import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

test('concurrent retry persists once and returns the original sequence', async () => {
  process.env.TABLE = 'test';
  const { saveMessage } = await import('./data.js');
  const mock = new Map<string, Record<string, unknown>>([
    ['CONV#room|META',{lastSeq:0,type:'group'}],
    ['CONV#room|MEMBER#alice',{uid:'alice'}],
    ['USER#alice|PROFILE',{uid:'alice'}],
  ]);
  let commits = 0;
  const original = DynamoDBDocumentClient.prototype.send;
  DynamoDBDocumentClient.prototype.send = (async (command: GetCommand | TransactWriteCommand) => {
    if (command instanceof GetCommand) {
      const {pk,sk} = command.input.Key!;
      return {Item:mock.get(pk+'|'+sk)};
    }
    const entries = command.input.TransactItems!;
    const meta = entries.find(entry=>entry.Update)!.Update!;
    const dedup = entries.find(entry=>entry.Put?.Item?.sk === 'DEDUP#alice#retry')!.Put!.Item!;
    const old = mock.get('CONV#room|META')!.lastSeq;
    if (old !== meta.ExpressionAttributeValues![':old'] || mock.has('CONV#room|'+dedup.sk)) {
      throw Object.assign(new Error('conflict'),{name:'TransactionCanceledException'});
    }
    assert.ok(entries.some(entry => entry.Put?.Item?.sk === 'MSG#0000000000000001'));
    assert.ok(entries.some(entry => entry.Put?.Item?.sk === 'AUTHORED#room#MSG#0000000000000001'));
    mock.set('CONV#room|META',{lastSeq:meta.ExpressionAttributeValues![':next'],type:'group'});
    mock.set('CONV#room|'+dedup.sk,dedup);
    commits++;
    return {};
  }) as typeof original;
  try {
    const body = {text:'Hola',clientMessageId:'retry'};
    const [first, second] = await Promise.all([saveMessage('alice','room',body),saveMessage('alice','room',body)]);
    assert.deepEqual(first,second);
    assert.equal(first.seq,1);
    assert.equal(commits,1);
  } finally {
    DynamoDBDocumentClient.prototype.send = original;
  }
});

