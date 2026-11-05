import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand, TransactWriteCommand, UpdateCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const TableName = process.env.TABLE!;
export const user = (id: string) => 'USER#' + id;
export const conv = (id: string) => 'CONV#' + id;
export const messageKey = (seq: number) => 'MSG#' + String(seq).padStart(16, '0');
export const now = () => new Date().toISOString();
export const ttl = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;
export const get = async (pk: string, sk: string) => (await db.send(new GetCommand({ TableName, Key: { pk, sk }, ConsistentRead: true }))).Item;
export const put = (item: Record<string, unknown>, condition?: string) => db.send(new PutCommand({ TableName, Item: item, ConditionExpression: condition }));
export const del = (pk: string, sk: string) => db.send(new DeleteCommand({ TableName, Key: { pk, sk } }));
export const query = (pk: string, prefix: string, options: { limit?: number; cursor?: string; after?: number; before?: number; reverse?: boolean } = {}) => {
  const values: Record<string, unknown> = { ':pk': pk, ':prefix': prefix };
  let range = 'begins_with(sk, :prefix)';
  if (!prefix) { delete values[':prefix']; range = ''; }
  if (options.after !== undefined || options.before !== undefined) {
    range = 'sk BETWEEN :prefix AND :end';
    values[':prefix'] = messageKey(options.after === undefined ? 0 : options.after + 1);
    values[':end'] = messageKey(options.before === undefined ? Number.MAX_SAFE_INTEGER : options.before - 1);
  }
  return db.send(new QueryCommand({ TableName, ConsistentRead: true, KeyConditionExpression: 'pk = :pk' + (range ? ' AND ' + range : ''), ExpressionAttributeValues: values,
    ScanIndexForward: !options.reverse, Limit: options.limit, ExclusiveStartKey: options.cursor ? {pk, sk: options.cursor} : undefined }));
};
export async function* all(pk: string, prefix: string) {
  let cursor: string | undefined;
  do {
    const result = await query(pk, prefix, { cursor });
    yield* result.Items ?? [];
    cursor = result.LastEvaluatedKey?.sk;
  } while (cursor);
}
export async function* scan() {
  let cursor: Record<string, any> | undefined;
  do {
    const result = await db.send(new ScanCommand({ TableName, ExclusiveStartKey: cursor }));
    yield* result.Items ?? [];
    cursor = result.LastEvaluatedKey;
  } while (cursor);
}
export const update = (pk: string, sk: string, expression: string, values: Record<string, unknown>, condition?: string) =>
  db.send(new UpdateCommand({ TableName, Key: { pk, sk }, UpdateExpression: expression, ConditionExpression: condition, ExpressionAttributeValues: values }));
export const transaction = (items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>) =>
  db.send(new TransactWriteCommand({ TransactItems: items }));
export const insert = (Item: Record<string, unknown>, condition?: string) => ({ Put: { TableName, Item, ConditionExpression: condition } });
export const remove = (pk: string, sk: string, condition?: string) => ({ Delete: { TableName, Key: { pk, sk }, ConditionExpression: condition } });
export const change = (pk: string, sk: string, expression: string, values: Record<string, unknown>, condition?: string) =>
  ({ Update: { TableName, Key: { pk, sk }, UpdateExpression: expression, ConditionExpression: condition, ExpressionAttributeValues: values } });
export const check = (pk: string, sk: string, condition: string) => ({ ConditionCheck: { TableName, Key: {pk, sk}, ConditionExpression: condition } });

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function requireThat(value: unknown, status: number, message: string): asserts value {
  if (!value) throw new HttpError(status, message);
}
export function field(value: unknown, max: number) {
  requireThat(typeof value === 'string' && value.trim().length && value.length <= max, 400, 'Campo inválido');
  return value.trim();
}
export function integer(value: unknown, min = 0) {
  const n = Number(value);
  requireThat(value !== null && value !== '' && Number.isSafeInteger(n) && n >= min, 400, 'Número inválido');
  return n;
}
export const memberKey = (uid: string) => 'MEMBER#' + uid;
export async function membership(cid: string, uid: string) {
  const item = await get(conv(cid), memberKey(uid));
  requireThat(item, 403, 'No perteneces a la conversación');
  return item;
}
export async function saveMessage(uid: string, cid: string, input: Record<string, unknown>) {
  const text = field(input.text, 4000);
  const id = field(input.clientMessageId, 80);
  const pk = conv(cid);
  const dedup = 'DEDUP#' + uid + '#' + id;
  for (let attempt = 0; attempt < 12; attempt++) {
    await membership(cid, uid);
    const prior = await get(pk, dedup);
    if (prior) return { seq: prior.seq, createdAt: prior.createdAt };
    const meta = await get(pk, 'META');
    requireThat(meta && !meta.deleted, 404, 'Conversación eliminada');
    const peer = meta.type === 'direct' ? (meta.users as string[]).find(value => value !== uid) : undefined;
    const seq = Number(meta.lastSeq) + 1;
    const createdAt = now();
    try {
      await transaction([
        check(user(uid), 'PROFILE', 'attribute_exists(pk) AND attribute_not_exists(deleting)'),
        check(pk, memberKey(uid), 'attribute_exists(pk)'),
        ...(peer ? [check(user(uid), 'BLOCK#' + peer, 'attribute_not_exists(pk)'), check(user(peer), 'BLOCK#' + uid, 'attribute_not_exists(pk)'), check(user(peer), 'PROFILE', 'attribute_exists(pk) AND attribute_not_exists(deleting)')] : []),
        change(pk, 'META', 'SET lastSeq = :next, lastMessageAt = :at', { ':next': seq, ':old': seq - 1, ':at': createdAt }, 'lastSeq = :old AND attribute_not_exists(deleted)'),
        insert({ pk, sk: messageKey(seq), cid, seq, senderId: uid, messageBody: text, createdAt, clientMessageId: id }, 'attribute_not_exists(pk)'),
        insert({ pk, sk: dedup, seq, createdAt }, 'attribute_not_exists(pk)'),
        insert({ pk: user(uid), sk: 'AUTHORED#' + cid + '#' + messageKey(seq), cid, seq, dedup }),
      ]);
      return { seq, createdAt };
    } catch (error) {
      if ((error as Error).name !== 'TransactionCanceledException') throw error;
      const profile = await get(user(uid), 'PROFILE');
      requireThat(profile && !profile.deleting, 403, 'Cuenta no disponible');
      if (peer) {
        const other = await get(user(peer), 'PROFILE');
        requireThat(other && !other.deleting && !await get(user(uid), 'BLOCK#' + peer) && !await get(user(peer), 'BLOCK#' + uid), 403, 'Conversación bloqueada');
      }
      await new Promise(resolve => setTimeout(resolve, Math.random() * Math.min(100, 5 * 2 ** attempt)));
    }
  }
  throw new HttpError(409, 'Reintenta el envío');
}
export { randomUUID };




export function inboxPage(uid: string, cursor?: string) {
  const pk = user(uid);
  let start: Record<string, string> | undefined;
  if (cursor) {
    const parts = Buffer.from(cursor,'base64url').toString().split('|');
    requireThat(parts.length === 2 && parts[0].startsWith('CONV#') && parts[1].endsWith('#'+parts[0].slice(5)),400,'Cursor inválido');
    start = {pk,sk:parts[0],inboxPk:pk,inboxSk:parts[1]};
  }
  return db.send(new QueryCommand({
    TableName, IndexName:'Inbox', KeyConditionExpression:'inboxPk = :owner', ExpressionAttributeValues:{':owner':pk},
    ScanIndexForward:false,Limit:30,ExclusiveStartKey:start,
  }));
}
export function inboxCursor(key: Record<string, unknown> | undefined) {
  return key ? Buffer.from(key.sk+'|'+key.inboxSk).toString('base64url') : undefined;
}
export async function touchInbox(uid: string, cid: string, createdAt: string) {
  try {
    await update(user(uid),conv(cid),'SET inboxSk = :sort',{':sort':createdAt+'#'+cid},
      'attribute_exists(pk) AND inboxSk < :sort');
  } catch (error) {
    if ((error as Error).name !== 'ConditionalCheckFailedException') throw error;
  }
}
