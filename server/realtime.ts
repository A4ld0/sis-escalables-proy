import { canType, clearPresence, setPresence } from './presence';
import type { APIGatewayProxyEvent, DynamoDBStreamEvent, SQSEvent, ScheduledEvent } from 'aws-lambda';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import webPush from 'web-push';
import { all, check, conv, del, field, get, HttpError, insert, memberKey, membership, now, put, remove, requireThat, saveMessage, scan, transaction, touchInbox, ttl, update, user } from './data';
import { purge } from './http';


async function post(endpoint: string, id: string, data: unknown) {
  try {
    await new ApiGatewayManagementApiClient({endpoint}).send(new PostToConnectionCommand({ConnectionId:id,Data:Buffer.from(JSON.stringify(data))}));
    return true;
  } catch (error) {
    if ((error as Error).name !== 'GoneException') throw error;
    await disconnect(id);
    return false;
  }
}
async function disconnect(id: string) {
  const key = 'CONN#'+id;
  const conn = await get(key,'META');
  if (!conn) return;
  await Promise.all([del(key,'META'),del(user(conn.uid),key),clearPresence(conn.uid,id)]);
  try {
    await update(user(conn.uid),'PROFILE','SET lastSeenAt = :at',{':at':now()},'attribute_exists(pk) AND attribute_not_exists(deleting)');
  } catch (error) {
    if ((error as Error).name !== 'ConditionalCheckFailedException') throw error;
  }
}
async function sendTo(uid: string, data: unknown) {
  let delivered = false;
  for await (const conn of all(user(uid),'CONN#')) {
    if (conn.ttl <= ttl(0) || conn.tokenExp <= ttl(0)) continue;
    if (await post(conn.endpoint,conn.sk.slice(5),data)) delivered = true;
  }
  return delivered;
}
export async function socket(event: APIGatewayProxyEvent) {
  const context = event.requestContext;
  const id = context.connectionId!;
  const key = 'CONN#'+id;
  try {
    if (context.routeKey === '$connect') {
      const ticket = 'TICKET#'+field(event.queryStringParameters?.ticket,80);
      const auth = await get(ticket,'META');
      requireThat(auth && auth.ttl > ttl(0) && auth.tokenExp > ttl(0),401,'Credencial caducada');
      const info = {uid:auth.uid, tokenExp:auth.tokenExp, ttl:ttl(7200), endpoint:'https://'+context.domainName+'/'+context.stage};
      await transaction([
        remove(ticket,'META','attribute_exists(pk)'),
        check(user(auth.uid),'PROFILE','attribute_exists(pk) AND attribute_not_exists(deleting)'),
        insert({pk:key,sk:'META',...info}),insert({pk:user(auth.uid),sk:key,...info}),
      ]);
      return {statusCode:200,body:''};
    }
    if (context.routeKey === '$disconnect') {
      await disconnect(id);
      return {statusCode:200,body:''};
    }
    const conn = await get(key,'META');
    requireThat(conn && conn.tokenExp > ttl(0),401,'Sesión caducada');
    const me = await get(user(conn.uid),'PROFILE');
    requireThat(me && !me.deleting,403,'Cuenta no disponible');
    const input = JSON.parse(event.body ?? '{}');
    if (input.action === 'heartbeat') {
      await setPresence(conn.uid,id,conn.tokenExp);
      return {statusCode:200,body:''};
    }
    const cid = field(input.cid,80);
    if (input.action === 'sendMessage') {
      const saved = await saveMessage(conn.uid,cid,input);
      await post(conn.endpoint,id,{kind:'ack',cid,clientMessageId:input.clientMessageId,...saved});
    } else if (input.action === 'typing') {
      await membership(cid,conn.uid);
      const meta = await get(conv(cid),'META');
      requireThat(meta && !meta.deleted,404,'Conversación eliminada');
      try {
        const allowed = await canType(conn.uid);
        if (allowed === null) return {statusCode:200,body:''};
        if (allowed === undefined) await update(key,'META','SET typingAt = :now',{':now':ttl(0),':before':ttl(-3)},'attribute_exists(pk) AND (attribute_not_exists(typingAt) OR typingAt < :before)');
      } catch (error) {
        if ((error as Error).name === 'ConditionalCheckFailedException') return {statusCode:200,body:''};
        throw error;
      }
      for await (const item of all(conv(cid),'MEMBER#')) {
        if (item.uid !== conn.uid && !await get(user(item.uid),'BLOCK#'+conn.uid) && !await get(user(conn.uid),'BLOCK#'+item.uid)) await sendTo(item.uid,{kind:'typing',cid,uid:conn.uid});
      }
    }
    return {statusCode:200,body:''};
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error({event:'socket_failure',name:(error as Error).name});
    return {statusCode:status,body:''};
  }
}

let vapid: {subject:string;publicKey:string;privateKey:string} | undefined;
async function offline(uid: string, cid: string, seq: number) {
  const pk = user(uid);
  if (process.env.DIGEST_FROM) {
    const profile = await get(pk,'PROFILE');
    if (profile?.digest && !profile.deleting) await put({pk,sk:'DIGEST#'+cid+'#'+seq,ttl:ttl(7*86400)});
  }
  if (!process.env.VAPID_SECRET) return;
  if (!vapid) {
    const result = await new SecretsManagerClient({}).send(new GetSecretValueCommand({SecretId:process.env.VAPID_SECRET}));
    vapid = JSON.parse(result.SecretString!);
  }
  for await (const device of all(pk,'DEVICE#')) {
    if (device.ttl <= ttl(0)) continue;
    try {
      await webPush.sendNotification({endpoint:device.endpoint,keys:device.keys},JSON.stringify({cid,seq}),{TTL:3600,vapidDetails:vapid,timeout:3000});
    } catch (error) {
      const status = (error as {statusCode?:number}).statusCode;
      if (status === 404 || status === 410) await del(pk,device.sk);
      else throw error;
    }
  }
}
async function distribute(item: Record<string, any>, kind: string) {
  const meta = await get(item.pk,'META');
  if (!meta || meta.deleted) return;
  const recipients = [];
  for await (const member of all(item.pk,'MEMBER#')) {
    recipients.push(member.uid);
  }
  await Promise.all(recipients.map(async uid => {
    await touchInbox(uid,item.cid,item.createdAt);
    if (uid !== item.senderId && await get(user(item.senderId),'BLOCK#'+uid)) return;
    if (uid !== item.senderId && await get(user(uid),'BLOCK#'+item.senderId)) {
      await sendTo(uid,{kind,cid:item.cid,seq:item.seq,hidden:true});
      return;
    }
    const live = await sendTo(uid,{kind,cid:item.cid,seq:item.seq,senderId:item.senderId,text:item.messageBody,createdAt:item.createdAt});
    if (!live && uid !== item.senderId) await offline(uid,item.cid,item.seq);
  }));
  console.log(JSON.stringify({_aws:{Timestamp:Date.now(),CloudWatchMetrics:[{Namespace:'Chat',Dimensions:[['Service']],Metrics:[{Name:'DeliveryLatency',Unit:'Milliseconds'}]}]},Service:process.env.SERVICE,DeliveryLatency:Date.now()-Date.parse(item.createdAt)}));
}

export async function stream(event: DynamoDBStreamEvent) {
  const batchItemFailures = [];
  for (const record of event.Records) {
    if (record.eventName !== 'INSERT' || !record.dynamodb?.NewImage) continue;
    const item = unmarshall(record.dynamodb.NewImage as Parameters<typeof unmarshall>[0]);
    if (!String(item.sk).startsWith('MSG#')) continue;
    try {
      const current = await get(item.pk,item.sk);
      if (current?.senderId) await distribute(current,'message');
    }
    catch (error) {
      console.error({event:'fanout_failure',name:(error as Error).name});
      batchItemFailures.push({itemIdentifier:record.dynamodb.SequenceNumber!});
    }
  }
  return {batchItemFailures};
}
export async function privacy(event: SQSEvent) {
  const batchItemFailures = [];
  for (const record of event.Records) {
    try {
      const input = JSON.parse(record.body);
      await purge(input.uid,input.cognitoUsername);
    } catch (error) {
      console.error({event:'privacy_failure',name:(error as Error).name});
      batchItemFailures.push({itemIdentifier:record.messageId});
    }
  }
  return {batchItemFailures};
}
export async function digest(_event: ScheduledEvent) {
  const ses = new SESv2Client({});
  for await (const item of scan()) {
    if (item.sk !== 'PROFILE' || !item.digest || item.deleting) continue;
    const pending = [];
    for await (const notification of all(item.pk,'DIGEST#')) pending.push(notification.sk);
    if (!pending.length) continue;
    await ses.send(new SendEmailCommand({
      FromEmailAddress:process.env.DIGEST_FROM, Destination:{ToAddresses:[item.email]},
      Content:{Simple:{Subject:{Data:'Resumen de chat'},Body:{Text:{Data:'Tuviste actividad nueva mientras no estabas conectado. Abre la aplicación para ver tus conversaciones.'}}}},
    }));
    await Promise.all(pending.map(sk => del(item.pk,sk)));
  }
}





