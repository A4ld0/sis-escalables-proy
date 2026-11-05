import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cache from 'aws-cdk-lib/aws-elasticache';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cf from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as waf from 'aws-cdk-lib/aws-wafv2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamo from 'aws-cdk-lib/aws-dynamodb';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as auth from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as node from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import { existsSync } from 'node:fs';

const app = new cdk.App();
const stage = String(app.node.tryGetContext('stage') ?? 'dev');
if (!/^[a-z][a-z0-9-]{1,18}$/.test(stage)) throw new Error('stage inválido');
const stack = new cdk.Stack(app,'Chat-'+stage,{env:{account:process.env.CDK_DEFAULT_ACCOUNT,region:'us-east-1'}});
const config = (key: string) => String(app.node.tryGetContext(key) ?? '');
const bucket = new s3.Bucket(stack,'Site',{blockPublicAccess:s3.BlockPublicAccess.BLOCK_ALL,enforceSSL:true,versioned:true});
const acl = new waf.CfnWebACL(stack,'EdgeFirewall',{
  scope:'CLOUDFRONT',defaultAction:{allow:{}},
  visibilityConfig:{cloudWatchMetricsEnabled:true,metricName:'ChatEdge',sampledRequestsEnabled:true},
  rules:[
    {name:'Common',priority:0,overrideAction:{none:{}},statement:{managedRuleGroupStatement:{vendorName:'AWS',name:'AWSManagedRulesCommonRuleSet'}},visibilityConfig:{cloudWatchMetricsEnabled:true,metricName:'Common',sampledRequestsEnabled:true}},
    {name:'Rate',priority:1,action:{block:{}},statement:{rateBasedStatement:{limit:3000,aggregateKeyType:'IP'}},visibilityConfig:{cloudWatchMetricsEnabled:true,metricName:'Rate',sampledRequestsEnabled:true}},
  ],
});
const edge = new cf.Distribution(stack,'Edge',{
  defaultRootObject:'index.html',webAclId:acl.attrArn,httpVersion:cf.HttpVersion.HTTP2_AND_3,
  defaultBehavior:{origin:origins.S3BucketOrigin.withOriginAccessControl(bucket),viewerProtocolPolicy:cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,cachePolicy:cf.CachePolicy.CACHING_DISABLED,responseHeadersPolicy:cf.ResponseHeadersPolicy.SECURITY_HEADERS},
});
const site = 'https://'+edge.domainName;
const pool = new cognito.UserPool(stack,'Users',{
  selfSignUpEnabled:true,signInAliases:{email:true},autoVerify:{email:true},
  accountRecovery:cognito.AccountRecovery.EMAIL_ONLY,mfa:cognito.Mfa.OPTIONAL,mfaSecondFactor:{sms:false,otp:true},
  deletionProtection:true,
});
const domainPrefix = config('domainPrefix') || 'chat-'+stage+'-'+cdk.Aws.ACCOUNT_ID;
const domain = pool.addDomain('Login',{cognitoDomain:{domainPrefix}});
const providers = [cognito.UserPoolClientIdentityProvider.COGNITO];
const dependencies: cdk.CfnResource[] = [];
const providerOptions = [
  {name:'Google',type:'Google',keys:['client_id','client_secret'],scopes:'openid email profile'},
  {name:'Facebook',type:'Facebook',keys:['client_id','client_secret'],scopes:'public_profile,email'},
  {name:'SignInWithApple',type:'SignInWithApple',keys:['client_id','team_id','key_id','private_key'],scopes:'email name'},
  {name:'Microsoft',type:'OIDC',keys:['client_id','client_secret','oidc_issuer'],scopes:'openid email profile'},
  {name:'Corporate',type:'SAML',keys:['MetadataURL'],scopes:''},
];
for (const option of providerOptions) {
  const secretName = config(option.name+'Secret');
  if (!secretName) continue;
  const details: Record<string,string> = Object.fromEntries(option.keys.map(key => [key,cdk.SecretValue.secretsManager(secretName,{jsonField:key}).unsafeUnwrap()]));
  if (option.scopes) details.authorize_scopes = option.scopes;
  if (option.type === 'OIDC') details.attributes_request_method = 'GET';
  const email = option.type === 'SAML' ? 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress' : 'email';
  const verification = option.type === 'Facebook' || option.type === 'SAML' ? undefined : 'email_verified';
  dependencies.push(new cognito.CfnUserPoolIdentityProvider(stack,option.name,{
    userPoolId:pool.userPoolId,providerName:option.name,providerType:option.type,providerDetails:details,
    attributeMapping:{email,...(verification?{email_verified:verification}:{})},
  }));
  providers.push(cognito.UserPoolClientIdentityProvider.custom(option.name));
}
const client = pool.addClient('Browser',{
  generateSecret:false,enableTokenRevocation:true,preventUserExistenceErrors:true,supportedIdentityProviders:providers,
  oAuth:{flows:{authorizationCodeGrant:true},scopes:[cognito.OAuthScope.OPENID,cognito.OAuthScope.EMAIL,cognito.OAuthScope.PROFILE],callbackUrls:[site+'/'],logoutUrls:[site+'/']},
  idTokenValidity:cdk.Duration.hours(1),accessTokenValidity:cdk.Duration.hours(1),refreshTokenValidity:cdk.Duration.days(30),
});
for (const dep of dependencies) client.node.addDependency(dep);
const replica = config('replicaRegion');
const table = new dynamo.TableV2(stack,'ChatTable',{
  partitionKey:{name:'pk',type:dynamo.AttributeType.STRING},sortKey:{name:'sk',type:dynamo.AttributeType.STRING},
  dynamoStream:dynamo.StreamViewType.NEW_AND_OLD_IMAGES,timeToLiveAttribute:'ttl',
  pointInTimeRecoverySpecification:{pointInTimeRecoveryEnabled:true},
  encryption:dynamo.TableEncryptionV2.awsManagedKey(),
  removalPolicy:cdk.RemovalPolicy.RETAIN,deletionProtection:true,
  replicas:replica?[{region:replica,pointInTimeRecoverySpecification:{pointInTimeRecoveryEnabled:true}}]:[],
});
table.addGlobalSecondaryIndex({
  indexName:'Inbox', partitionKey:{name:'inboxPk',type:dynamo.AttributeType.STRING},
  sortKey:{name:'inboxSk',type:dynamo.AttributeType.STRING},projectionType:dynamo.ProjectionType.KEYS_ONLY,
});
const cacheEnabled = config('redis') === 'true';
const vpc = cacheEnabled ? new ec2.Vpc(stack,'ChatVpc',{maxAzs:2,natGateways:2}) : undefined;
if (vpc) vpc.addGatewayEndpoint('DynamoEndpoint',{service:ec2.GatewayVpcEndpointAwsService.DYNAMODB});
const functionsSg = vpc ? new ec2.SecurityGroup(stack,'AppFunctionsSg',{vpc}) : undefined;
const cacheSg = vpc ? new ec2.SecurityGroup(stack,'CacheSg',{vpc}) : undefined;
if (functionsSg && cacheSg) cacheSg.addIngressRule(functionsSg,ec2.Port.tcp(6379));
const redis = vpc && cacheSg ? new cache.CfnServerlessCache(stack,'PresenceCache',{
  engine:'valkey',serverlessCacheName:'chat-'+stage,
  securityGroupIds:[cacheSg.securityGroupId],subnetIds:vpc.privateSubnets.map(subnet=>subnet.subnetId),
}) : undefined;
const dlq = new sqs.Queue(stack,'FanoutFailures',{retentionPeriod:cdk.Duration.days(14),enforceSSL:true});
const privacyDlq = new sqs.Queue(stack,'PrivacyFailures',{retentionPeriod:cdk.Duration.days(14),enforceSSL:true});
const privacyQueue = new sqs.Queue(stack,'PrivacyQueue',{enforceSSL:true,visibilityTimeout:cdk.Duration.minutes(15),deadLetterQueue:{queue:privacyDlq,maxReceiveCount:5}});
function fn(name: string, entry: string, handler: string, extra: Record<string,string> = {}, minutes?: number) {
  const useCache = Boolean(redis && (name === 'HttpHandler' || name === 'SocketHandler'));
  const result = new node.NodejsFunction(stack,name,{
    ...(useCache ? {vpc,securityGroups:[functionsSg!]} : {}),
    entry,handler,runtime:lambda.Runtime.NODEJS_22_X,architecture:lambda.Architecture.ARM_64,memorySize:512,
    timeout:minutes ? cdk.Duration.minutes(minutes) : cdk.Duration.seconds(15),
    tracing:lambda.Tracing.ACTIVE,logGroup:new logs.LogGroup(stack,name+'Logs',{retention:logs.RetentionDays.TWO_WEEKS}),
    environment:{TABLE:table.tableName,SERVICE:stack.stackName,...(useCache ? {PRESENCE_HOST:redis!.attrEndpointAddress} : {}),...extra},
    bundling:{bundleAwsSDK:true,minify:true,forceDockerBundling:false},
  });
  table.grantReadWriteData(result);
  result.addToRolePolicy(new iam.PolicyStatement({actions:['dynamodb:ConditionCheckItem'],resources:[table.tableArn]}));
  return result;
}
const httpHandler = fn('HttpHandler','server/http.ts','handler',{PRIVACY_QUEUE:privacyQueue.queueUrl,TRUST_FEDERATED_EMAIL:config('trustFederatedEmail')});
privacyQueue.grantSendMessages(httpHandler);
const confirmed = fn('Confirmed','server/http.ts','confirmed');
pool.addTrigger(cognito.UserPoolOperation.POST_CONFIRMATION,confirmed);
const privacy = fn('PrivacyHandler','server/realtime.ts','privacy',{USER_POOL:pool.userPoolId},10);
privacy.addToRolePolicy(new iam.PolicyStatement({actions:['cognito-idp:AdminDeleteUser'],resources:[pool.userPoolArn]}));
privacy.addEventSource(new sources.SqsEventSource(privacyQueue,{batchSize:1,reportBatchItemFailures:true}));
const socketHandler = fn('SocketHandler','server/realtime.ts','socket');
const vapidSecret = config('vapidSecret');
const digestFrom = config('digestFrom');
const fanout = fn('Fanout','server/realtime.ts','stream',{VAPID_SECRET:vapidSecret,DIGEST_FROM:digestFrom});
fanout.addEventSource(new sources.DynamoEventSource(table,{
  startingPosition:lambda.StartingPosition.LATEST,batchSize:10,reportBatchItemFailures:true,bisectBatchOnError:true,
  retryAttempts:5,onFailure:new sources.SqsDlq(dlq),
}));
if (vapidSecret) secrets.Secret.fromSecretNameV2(stack,'Vapid',vapidSecret).grantRead(fanout);
if (digestFrom) {
  const digest = fn('Digest','server/realtime.ts','digest',{DIGEST_FROM:digestFrom},10);
  digest.addToRolePolicy(new iam.PolicyStatement({actions:['ses:SendEmail'],resources:[stack.formatArn({service:'ses',resource:'identity',resourceName:digestFrom,arnFormat:cdk.ArnFormat.SLASH_RESOURCE_NAME})]}));
  new events.Rule(stack,'DailyDigest',{schedule:events.Schedule.rate(cdk.Duration.days(1)),targets:[new targets.LambdaFunction(digest)]});
}
const http = new apigw.HttpApi(stack,'Http',{
  defaultIntegration:new integrations.HttpLambdaIntegration('Routes',httpHandler),
  defaultAuthorizer:new auth.HttpJwtAuthorizer('CognitoJwt',pool.userPoolProviderUrl,{jwtAudience:[client.userPoolClientId]}),
  corsPreflight:{allowOrigins:[site],allowHeaders:['Authorization','Content-Type'],allowMethods:[apigw.CorsHttpMethod.ANY],maxAge:cdk.Duration.hours(1)},
});
const ws = new apigw.WebSocketApi(stack,'Socket',{
  routeSelectionExpression:'$request.body.action',
  connectRouteOptions:{integration:new integrations.WebSocketLambdaIntegration('Connect',socketHandler)},
  disconnectRouteOptions:{integration:new integrations.WebSocketLambdaIntegration('Disconnect',socketHandler)},
  defaultRouteOptions:{integration:new integrations.WebSocketLambdaIntegration('DispatchIntegration',socketHandler)},
});
const wsStage = new apigw.WebSocketStage(stack,'SocketStage',{webSocketApi:ws,stageName:stage,autoDeploy:true,throttle:{rateLimit:3000,burstLimit:1000}});
for (const func of [socketHandler,fanout]) wsStage.grantManagementApiAccess(func);
for (const [name,metric,threshold] of [
  ['Delivery',new cloudwatch.Metric({namespace:'Chat',metricName:'DeliveryLatency',dimensionsMap:{Service:stack.stackName},statistic:'p99'}),300],
  ['Iterator',fanout.metric('IteratorAge',{statistic:'Maximum'}),60000],
  ['FanoutDlq',dlq.metricApproximateNumberOfMessagesVisible(),1],
  ['PrivacyDlq',privacyDlq.metricApproximateNumberOfMessagesVisible(),1],
] as const) new cloudwatch.Alarm(stack,name+'Alarm',{metric,threshold,evaluationPeriods:2,treatMissingData:cloudwatch.TreatMissingData.NOT_BREACHING});
const assets = 'dist/chat/browser';
if (!existsSync(assets+'/index.html')) throw new Error('Primero ejecuta npm run build');
new s3deploy.BucketDeployment(stack,'Upload',{
  sources:[s3deploy.Source.asset(assets),s3deploy.Source.jsonData('config.json',{
    http:http.apiEndpoint,ws:wsStage.url,clientId:client.userPoolClientId,login:domain.baseUrl(),
    redirect:site+'/',vapidPublicKey:config('vapidPublicKey'),digest:Boolean(digestFrom),presence:Boolean(redis),
  })],
  destinationBucket:bucket,distribution:edge,distributionPaths:['/*'],
});
new cdk.CfnOutput(stack,'SiteUrl',{value:site});
new cdk.CfnOutput(stack,'FederationCallback',{value:domain.baseUrl()+'/oauth2/idpresponse'});
new cdk.CfnOutput(stack,'SamlAcs',{value:domain.baseUrl()+'/saml2/idpresponse'});
new cdk.CfnOutput(stack,'UserPoolId',{value:pool.userPoolId});





