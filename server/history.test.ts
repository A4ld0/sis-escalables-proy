import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

test('history resumes by sequence and resets after a block in either direction', async () => {
  process.env.TABLE = 'test';
  const { handler } = await import('./http.js');
  const { messageKey } = await import('./data.js');
  const profiles = new Map<string, Record<string, unknown>>([
    ['USER#alice', {uid:'alice'}],
    ['USER#bob', {uid:'bob'}],
  ]);
  const blocks = new Set<string>();
  let messages = [
    {seq:1,senderId:'bob',messageBody:'uno',sk:messageKey(1)},
    {seq:2,senderId:'alice',messageBody:'dos',sk:messageKey(2)},
  ];
  const original = DynamoDBDocumentClient.prototype.send;
  DynamoDBDocumentClient.prototype.send = (async (command: GetCommand | QueryCommand | TransactWriteCommand) => {
    if (command instanceof GetCommand) {
      const {pk,sk} = command.input.Key!;
      if (sk === 'PROFILE') return {Item:profiles.get(pk)};
      if (sk === 'META') return {Item:{cid:'room',type:'group',lastSeq:messages.length}};
      if (sk === 'MEMBER#alice') return {Item:{joinedAt:'test',memberRole:'member',lastReadSeq:0}};
      return {Item:blocks.has(pk+'|'+sk) ? {pk,sk} : undefined};
    }
    if (command instanceof TransactWriteCommand) {
      for (const {Put,Delete,Update} of command.input.TransactItems!) {
        if (Put?.Item) blocks.add(Put.Item.pk+'|'+Put.Item.sk);
        if (Delete?.Key) blocks.delete(Delete.Key.pk+'|'+Delete.Key.sk);
        if (Update?.Key) profiles.get(Update.Key.pk)!.historyPrivacyVersion = Update.ExpressionAttributeValues![':version'];
      }
      return {};
    }
    if (command.input.IndexName === 'Inbox') return {Items:[{sk:'CONV#room'}]};
    const values = command.input.ExpressionAttributeValues!;
    if (values[':prefix'] === 'BLOCK#') {
      return {Items:[...blocks].filter(key => key.startsWith(values[':pk']+'|')).map(key => ({sk:key.split('|')[1]}))};
    }
    const items = messages.filter(item => item.sk >= values[':prefix']);
    return {Items:command.input.ScanIndexForward ? items : items.reverse()};
  }) as typeof original;

  const request = async (uid: string, method: string, rawPath: string, queryStringParameters?: Record<string, string>) => {
    const event = {rawPath,queryStringParameters,requestContext:{http:{method},authorizer:{jwt:{claims:{sub:uid,token_use:'id'}}}}};
    const response = await handler(event as unknown as APIGatewayProxyEventV2WithJWTAuthorizer);
    assert.equal(response.statusCode,200,response.body);
    return JSON.parse(response.body);
  };
  const history = (query?: Record<string, string>) => request('alice','GET','/v1/conversations/room/messages',query);

  try {
    const initial = await history();
    assert.deepEqual(initial.items.map((item: {seq: number}) => item.seq),[2,1]);
    const inbox = await request('alice','GET','/v1/conversations');
    assert.equal(inbox.items[0].cacheVersion,initial.cacheVersion);
    const summary = await request('alice','GET','/v1/conversations/room');
    assert.equal(summary.cacheVersion,initial.cacheVersion);
    messages = [...messages,{seq:3,senderId:'bob',messageBody:'tres',sk:messageKey(3)}];
    const resumed = await history({afterSeq:'2',cacheVersion:initial.cacheVersion});
    assert.equal(resumed.reset,false);
    assert.deepEqual(resumed.items.map((item: {seq: number}) => item.seq),[3]);

    await request('bob','POST','/v1/blocks/alice');
    const blocked = await history({afterSeq:'3',cacheVersion:resumed.cacheVersion});
    assert.equal(blocked.reset,true);
    const blockedInbox = await request('alice','GET','/v1/conversations');
    assert.equal(blockedInbox.items[0].cacheVersion,blocked.cacheVersion);
    assert.deepEqual(blocked.items[0],{seq:3,hidden:true});
    assert.deepEqual(blocked.items[2],{seq:1,hidden:true});

    await request('bob','DELETE','/v1/blocks/alice');
    const restored = await history({afterSeq:'3',cacheVersion:blocked.cacheVersion});
    assert.equal(restored.reset,true);
    assert.equal(restored.items[0].text,'tres');

    await request('alice','POST','/v1/blocks/bob');
    const blockedByViewer = await history({afterSeq:'3',cacheVersion:restored.cacheVersion});
    assert.equal(blockedByViewer.reset,true);
    assert.deepEqual(blockedByViewer.items[0],{seq:3,hidden:true});
  } finally {
    DynamoDBDocumentClient.prototype.send = original;
  }
});
