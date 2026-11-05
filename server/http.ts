import { isOnline } from './presence';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, PostConfirmationTriggerEvent } from 'aws-lambda';
import { CognitoIdentityProviderClient, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createHash } from 'node:crypto';
import { all, check, change, conv, del, field, get, HttpError, insert, inboxCursor, inboxPage, integer, memberKey, membership, messageKey, now, put, query, randomUUID, remove, requireThat, saveMessage, transaction, ttl, update, user } from './data';

const usernameKey = (name: string) => 'NAME#' + name.toLowerCase();
const emailKey = (email: string) => 'EMAIL#' + email.toLowerCase();
async function profile(uid: string, claims: Record<string, unknown>) {
  const key = user(uid);
  let item = await get(key, 'PROFILE');
  if (!item) {
    requireThat(!await get(key, 'DELETED'), 403, 'Cuenta eliminada');
    const email = String(claims.email ?? '');
    const federated = typeof claims['cognito:username'] === 'string' && /^(Facebook|Microsoft|Corporate)_/i.test(claims['cognito:username']);
    requireThat(email && (String(claims.email_verified) === 'true' || federated && process.env.TRUST_FEDERATED_EMAIL === 'true'), 403, 'Correo sin verificar');
    const username = 'u-' + uid.toLowerCase();
    try {
      await transaction([
        check(key, 'DELETED', 'attribute_not_exists(pk)'),
        insert({pk:key, sk:'PROFILE', uid, username, email, displayName:username, status:'', avatarUrl:''}, 'attribute_not_exists(pk)'),
        insert({pk:usernameKey(username), sk:'LOOKUP', uid}, 'attribute_not_exists(pk)'),
        insert({pk:emailKey(email), sk:key, uid}),
      ]);
    } catch (error) {
      if ((error as Error).name !== 'TransactionCanceledException') throw error;
    }
    item = await get(key, 'PROFILE');
  }
  requireThat(item && !item.deleting, 403, 'Cuenta no disponible');
  return item;
}
const active = (uid: string) => check(user(uid), 'PROFILE', 'attribute_exists(pk) AND attribute_not_exists(deleting)');
const publicProfile = (item: Record<string, any>) => ({ uid:item.uid, username:item.username, displayName:item.displayName, status:item.profileStatus ?? item.status, avatarUrl:item.avatarUrl, lastSeenAt:item.lastSeenAt });
const memberItems = (cid: string, uid: string, role: string, seq: number, lastActivity: string) => [
  insert({pk:conv(cid), sk:memberKey(uid), uid, memberRole:role, lastReadSeq:seq, joinedAt:now()}, 'attribute_not_exists(pk)'),
  insert({pk:user(uid), sk:conv(cid), cid, inboxPk:user(uid), inboxSk:lastActivity+'#'+cid}),
];
async function leave(cid: string, uid: string, purge = false) {
  const pk = conv(cid);
  const member = await get(pk, memberKey(uid));
  if (!member) return;
  const meta = await get(pk, 'META');
  if (!meta || meta.deleted) {
    await del(pk, memberKey(uid));
    await del(user(uid), pk);
    return;
  }
  if (meta.type === 'group' && member.memberRole === 'owner' && meta.memberCount > 1) {
    requireThat(purge, 409, 'Transfiere la propiedad antes de salir');
    const members = (await query(pk, 'MEMBER#')).Items ?? [];
    const next = members.find(value => value.uid !== uid);
    requireThat(next, 409, 'Reintenta la salida');
    await transaction([
      change(pk, next.sk, 'SET memberRole = :owner', { ':owner':'owner' }, 'attribute_exists(pk)'),
      change(pk, 'META', 'ADD memberCount :minus', {':minus':-1, ':count':meta.memberCount}, 'memberCount = :count AND attribute_not_exists(deleted)'),
      remove(pk, memberKey(uid), 'attribute_exists(pk)'), remove(user(uid),pk),
    ]);
    return;
  }
  const close = meta.memberCount === 1 || meta.type === 'direct';
  await transaction([
    change(pk, 'META', close ? 'SET deleted = :yes ADD memberCount :minus' : 'ADD memberCount :minus',
      {':minus':-1, ':count':meta.memberCount, ...(close ? {':yes':true} : {})}, 'memberCount = :count AND attribute_not_exists(deleted)'),
    remove(pk, memberKey(uid), 'attribute_exists(pk)'), remove(user(uid),pk),
  ]);
}
async function routes(uid: string, me: Record<string, any>, method: string, path: string[], input: Record<string, any>, params: Record<string, string | undefined>, claims: Record<string, unknown>) {
  const [resource, id, section, target] = path;
  const my = user(uid);
  if (resource === 'users' && id === 'me' && method === 'GET') return publicProfile(me);
  if (resource === 'users' && id === 'me' && method === 'PATCH') {
    const displayName = field(input.displayName, 80);
    const status = String(input.status ?? '').slice(0, 160);
    const avatarUrl = String(input.avatarUrl ?? '');
    requireThat(avatarUrl.length <= 2048 && (!avatarUrl || URL.canParse(avatarUrl) && new URL(avatarUrl).protocol === 'https:'), 400, 'Avatar inválido');
    await update(my,'PROFILE','SET displayName = :name, profileStatus = :status, avatarUrl = :avatar',{':name':displayName,':status':status,':avatar':avatarUrl},'attribute_exists(pk) AND attribute_not_exists(deleting)');
    return { ...publicProfile(me), displayName, status, avatarUrl };
  }
  if (resource === 'users' && id === 'search' && method === 'GET') {
    const q = field(params.q, 254).toLowerCase();
    const hits = q.includes('@') ? (await query(emailKey(q),'USER#')).Items ?? [] : [await get(usernameKey(q),'LOOKUP')];
    const result = [];
    for (const hit of hits) {
      if (!hit || hit.uid === uid || await get(my,'BLOCK#'+hit.uid) || await get(user(hit.uid),'BLOCK#'+uid)) continue;
      const other = await get(user(hit.uid),'PROFILE');
      if (other && !other.deleting) result.push(publicProfile(other));
    }
    return result;
  }
  if (resource === 'contacts' && method === 'GET') {
    const result = [];
    for await (const item of all(my, 'CONTACT#')) {
      const other = await get(user(item.uid), 'PROFILE');
      if (other && !other.deleting && !await get(my,'BLOCK#'+item.uid) && !await get(user(item.uid),'BLOCK#'+uid)) result.push({...publicProfile(other), relationship:item.relationship});
    }
    return result;
  }
  if (resource === 'contacts' && id && method === 'POST') {
    requireThat(uid !== id, 400, 'Contacto inválido');
    const myKey = 'CONTACT#'+id;
    const otherKey = 'CONTACT#'+uid;
    const existing = await get(my,myKey);
    if (existing && existing.relationship !== 'incoming') return {};
    const accept = existing?.relationship === 'incoming';
    await transaction([
      active(uid), active(id),
      check(my,'BLOCK#'+id,'attribute_not_exists(pk)'), check(user(id),'BLOCK#'+uid,'attribute_not_exists(pk)'),
      insert({pk:my,sk:myKey,uid:id,relationship:accept?'accepted':'outgoing'},accept?'attribute_exists(pk)':'attribute_not_exists(pk)'),
      insert({pk:user(id),sk:otherKey,uid,relationship:accept?'accepted':'incoming'},accept?'attribute_exists(pk)':'attribute_not_exists(pk)'),
    ]);
    return {};
  }
  if (resource === 'blocks' && !id && method === 'GET') {
    const blocked = [];
    for await (const item of all(my,'BLOCK#')) {
      const other = await get(user(item.sk.slice(6)),'PROFILE');
      if (other && !other.deleting) blocked.push(publicProfile(other));
    }
    return blocked;
  }
  if (resource === 'blocks' && id && uid !== id) {
    if (method === 'POST') { await put({pk:my,sk:'BLOCK#'+id}); return {}; }
    if (method === 'DELETE') { await del(my,'BLOCK#'+id); return {}; }
  }
  if (resource === 'reports' && method === 'POST') {
    const cid = field(input.cid,80);
    await membership(cid,uid);
    await put({pk:my,sk:'REPORT#'+randomUUID(),cid,reason:field(input.reason,1000),createdAt:now()});
    return {};
  }
  if (resource === 'devices' && id) {
    if (method === 'DELETE') { await del(my,'DEVICE#'+id); return {}; }
    if (method === 'PUT') {
      const endpoint = new URL(field(input.endpoint,2048));
      requireThat(endpoint.protocol === 'https:' && !endpoint.port && !endpoint.username && !endpoint.password &&
        /(^|\.)(googleapis\.com|mozilla\.com|push\.apple\.com|notify\.windows\.com)$/.test(endpoint.hostname),400,'Proveedor push inválido');
      await put({pk:my,sk:'DEVICE#'+id,endpoint:endpoint.href,keys:{p256dh:field(input.keys?.p256dh,120),auth:field(input.keys?.auth,30)},ttl:ttl(180*86400)});
      return {};
    }
  }
  if (resource === 'account' && id === 'export' && method === 'GET') {
    const cursor = params.cursor;
    const records = await query(my, '', {limit:50,cursor});
    const items = [];
    for (const record of records.Items ?? []) {
      if (record.sk.startsWith('AUTHORED#')) {
        const message = await get(conv(record.cid),messageKey(record.seq));
        if (message?.senderId === uid) items.push({ ...message, text:message.messageBody, recordType:'authoredMessage' });
      } else if (!record.sk.startsWith('CONN#')) items.push(record);
    }
    return { items, cursor:records.LastEvaluatedKey?.sk };
  }
  if (resource === 'account' && id === 'notifications' && method === 'PUT') {
    await update(my,'PROFILE','SET digest = :enabled',{':enabled':input.digest === true},'attribute_exists(pk) AND attribute_not_exists(deleting)');
    return {};
  }
  if (resource === 'account' && method === 'DELETE') {
    const cognitoUsername = field(claims['cognito:username'],256);
    await new SQSClient({}).send(new SendMessageCommand({QueueUrl:process.env.PRIVACY_QUEUE,MessageBody:JSON.stringify({uid,cognitoUsername})}));
    return {};
  }
  if (resource === 'socket' && method === 'POST') {
    const ticket = randomUUID();
    await put({pk:'TICKET#'+ticket,sk:'META',uid,ttl:ttl(45),tokenExp:integer(claims.exp,1)},'attribute_not_exists(pk)');
    return {ticket, expires:integer(claims.exp,1)};
  }
  requireThat(resource === 'conversations',404,'Ruta inválida');
  if (!id && method === 'GET') {
    const page = await inboxPage(uid,params.cursor);
    const items = await Promise.all((page.Items ?? []).map(async link => {
      const [meta, member] = await Promise.all([get(link.sk,'META'),get(link.sk,memberKey(uid))]);
      if (!meta || !member || meta.deleted) return undefined;
      return {cid:meta.cid,name:meta.name,type:meta.type,role:member.memberRole,lastReadSeq:member.lastReadSeq,
        unread:Math.max(0,meta.lastSeq-member.lastReadSeq)};
    }));
    return {items:items.filter(Boolean),cursor:inboxCursor(page.LastEvaluatedKey)};
  }
  if (!id && method === 'POST') {
    const type = input.type;
    requireThat(type === 'direct' || type === 'group',400,'Tipo inválido');
    const peer = type === 'direct' ? field(input.peer,80) : undefined;
    requireThat(!peer || peer !== uid,400,'Contacto inválido');
    const users = peer ? [uid,peer].sort() : undefined;
    const cid = users ? createHash('sha256').update(users.join(':')).digest('hex') : randomUUID();
    const pk = conv(cid);
    const existing = await get(pk,'META');
    if (peer && existing && !existing.deleted && await get(pk,memberKey(uid))) return {cid};
    const createdAt = now();
    try {
      await transaction([
        active(uid),
        insert({pk,sk:'META',cid,type,users,name:peer ? '' : field(input.name,80),memberCount:peer?2:1,lastSeq:0,lastMessageAt:createdAt},'attribute_not_exists(pk)'),
        ...memberItems(cid,uid,'owner',0,createdAt),
        ...(peer ? [active(peer),check(my,'BLOCK#'+peer,'attribute_not_exists(pk)'),check(user(peer),'BLOCK#'+uid,'attribute_not_exists(pk)'),...memberItems(cid,peer,'member',0,createdAt)] : []),
      ]);
    } catch (error) {
      const current = peer && await get(pk,'META');
      if (!current || current.deleted || !await get(pk,memberKey(uid))) throw error;
    }
    return {cid,conversation:{cid,name:peer?'':input.name,type,role:'owner',unread:0}};
  }
  requireThat(id,404,'Conversación inválida');
  const pk = conv(id);
  const member = await membership(id,uid);
  const meta = await get(pk,'META');
  requireThat(meta && !meta.deleted,404,'Conversación eliminada');
  const role = member.memberRole;
  if (section === 'messages' && method === 'GET') {
    const limit = Math.min(integer(params.limit ?? '50',1),100);
    const after = params.afterSeq === undefined ? undefined : integer(params.afterSeq);
    const before = params.beforeSeq === undefined ? undefined : integer(params.beforeSeq,1);
    requireThat(after === undefined || before === undefined,400,'Usa un solo cursor');
    const result = await query(pk,'MSG#',{limit,after,before,reverse:after===undefined});
    const blocked = new Set<string>();
    for await (const item of all(my,'BLOCK#')) blocked.add(item.sk.slice(6));
    const senders = [...new Set((result.Items ?? []).map(item => item.senderId).filter(sender => sender && sender !== uid))];
    await Promise.all(senders.map(async sender => {
      if (await get(user(sender),'BLOCK#'+uid)) blocked.add(sender);
    }));
    return {items:(result.Items ?? []).map(item => !item.senderId?{seq:item.seq,text:'[Mensaje eliminado]',createdAt:item.createdAt}:blocked.has(item.senderId)?{seq:item.seq,hidden:true}:{...item,text:item.messageBody}),cursor:result.LastEvaluatedKey?.sk};
  }
  if (section === 'messages' && method === 'POST') return saveMessage(uid,id,input);
  if ((section === 'read' || section === 'delivered') && method === 'POST') {
    const seq = Math.min(integer(input.seq),meta.lastSeq);
    const key = section === 'read' ? 'lastReadSeq' : 'lastDeliveredSeq';
    try {
      await update(pk,memberKey(uid),'SET '+key+' = :seq',{':seq':seq},'attribute_exists(pk) AND (attribute_not_exists('+key+') OR '+key+' < :seq)');
    } catch (error) {
      if ((error as Error).name !== 'ConditionalCheckFailedException') throw error;
    }
    return {};
  }
  if (section === 'members' && method === 'GET') {
    const result = [];
    for await (const item of all(pk,'MEMBER#')) {
      const other = await get(user(item.uid),'PROFILE');
      if (other && !other.deleting && !await get(my,'BLOCK#'+item.uid) && !await get(user(item.uid),'BLOCK#'+uid)) {
        const online = await isOnline(item.uid);
        result.push({...publicProfile(other),online,role:item.memberRole,lastReadSeq:item.lastReadSeq,lastDeliveredSeq:item.lastDeliveredSeq});
      }
    }
    return result;
  }
  if (section === 'members' && method === 'POST') {
    requireThat(meta.type === 'group' && ['owner','admin'].includes(role),403,'Permisos insuficientes');
    const other = field(input.uid,80);
    requireThat(other !== uid,400,'Ya eres miembro');
    const newRole = input.role === 'admin' && role === 'owner' ? 'admin' : 'member';
    await transaction([
      active(uid),active(other),{ConditionCheck:{...check(pk,memberKey(uid),'memberRole = :role').ConditionCheck,ExpressionAttributeValues:{':role':role}}},
      check(my,'BLOCK#'+other,'attribute_not_exists(pk)'),check(user(other),'BLOCK#'+uid,'attribute_not_exists(pk)'),
      change(pk,'META','ADD memberCount :one',{':one':1,':max':100,':seq':meta.lastSeq},'memberCount < :max AND lastSeq = :seq AND attribute_not_exists(deleted)'),
      ...memberItems(id,other,newRole,meta.lastSeq,meta.lastMessageAt),
    ]);
    return {};
  }
  if (section === 'members' && target === 'me' && method === 'DELETE') { await leave(id,uid); return {}; }
  if (section === 'owner' && method === 'PUT') {
    requireThat(meta.type === 'group' && role === 'owner',403,'Permisos insuficientes');
    const other = field(input.uid,80);
    requireThat(other !== uid,400,'Ya eres propietario');
    await transaction([
      change(pk,memberKey(uid),'SET memberRole = :admin',{':admin':'admin',':owner':'owner'},'memberRole = :owner'),
      change(pk,memberKey(other),'SET memberRole = :owner',{':owner':'owner'},'attribute_exists(pk)'),
    ]);
    return {};
  }
  if (!section && method === 'DELETE') {
    requireThat(meta.type === 'group' && role === 'owner',403,'Permisos insuficientes');
    await transaction([change(pk,'META','SET deleted = :yes',{':yes':true},'attribute_exists(pk) AND attribute_not_exists(deleted)'),{ConditionCheck:{...check(pk,memberKey(uid),'memberRole = :role').ConditionCheck,ExpressionAttributeValues:{':role':'owner'}}}]);
    return {};
  }
  throw new HttpError(404,'Ruta inválida');
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    const claims = event.requestContext.authorizer.jwt.claims;
    requireThat(claims.token_use === 'id',401,'Sesión inválida');
    const uid = field(claims.sub,80);
    const me = await profile(uid,claims);
    const [version,...path] = event.rawPath.split('/').filter(Boolean).map(decodeURIComponent);
    requireThat(version === 'v1',404,'Ruta inválida');
    const input = event.body ? JSON.parse(event.body) : {};
    requireThat(input && typeof input === 'object' && !Array.isArray(input),400,'Solicitud inválida');
    return {statusCode:200,headers:{'content-type':'application/json','cache-control':'no-store'},body:JSON.stringify(await routes(uid,me,event.requestContext.http.method,path,input,event.queryStringParameters ?? {},claims))};
  } catch (error) {
    const status = error instanceof HttpError ? error.status : error instanceof SyntaxError || error instanceof URIError ? 400 : /ConditionalCheckFailed|TransactionCanceled/.test((error as Error).name) ? 409 : 500;
    if (status === 500) console.error({event:'http_failure',name:(error as Error).name,requestId:event.requestContext.requestId});
    return {statusCode:status,headers:{'content-type':'application/json'},body:JSON.stringify({error:error instanceof HttpError ? error.message : status === 409 ? 'El estado cambió o la operación no está permitida' : status === 400 ? 'Solicitud inválida' : 'Error interno'})};
  }
}

export async function purge(uid: string, cognitoUsername: string) {
  const my = user(uid);
  const me = await get(my,'PROFILE');
  if (me) await update(my,'PROFILE','SET deleting = :yes',{':yes':true},'attribute_exists(pk)');
  await put({pk:my,sk:'DELETED'});
  for await (const item of all(my,'AUTHORED#')) {
    const msg = await get(conv(item.cid),messageKey(item.seq));
    if (msg?.senderId === uid) await update(conv(item.cid),msg.sk,'SET messageBody = :text REMOVE senderId, clientMessageId',{':text':'[Mensaje eliminado]'},'attribute_exists(pk)');
    await del(conv(item.cid),item.dedup);
    await del(my,item.sk);
  }
  for await (const link of all(my,'CONV#')) {

    await leave(link.cid,uid,true);
  }
  for await (const contact of all(my,'CONTACT#')) await del(user(contact.uid),'CONTACT#'+uid);
  if (me) {
    await del(emailKey(me.email),my);
    await del(usernameKey(me.username),'LOOKUP');
  }
  for await (const item of all(my,'')) if (!['DELETED','PROFILE'].includes(item.sk)) {
    if (item.sk.startsWith('CONN#')) await del(item.sk,'META');
    await del(my,item.sk);
  }
  try {
    await new CognitoIdentityProviderClient({}).send(new AdminDeleteUserCommand({UserPoolId:process.env.USER_POOL,Username:cognitoUsername}));
  } catch (error) {
    if ((error as Error).name !== 'UserNotFoundException') throw error;
  }
  await del(my,'PROFILE');
}



export async function confirmed(event: PostConfirmationTriggerEvent) {
  if (event.triggerSource === 'PostConfirmation_ConfirmSignUp') {
    await profile(event.request.userAttributes.sub,event.request.userAttributes);
  }
  return event;
}







