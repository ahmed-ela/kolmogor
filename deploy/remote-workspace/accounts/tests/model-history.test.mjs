import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { WorkspaceChats } from '../chats.mjs';

test('switching engines transfers bounded completed history and only resumes a matching session', async () => {
  const db = new DatabaseSync(':memory:'), calls = [];
  const codex = 'gpt-a', gemini = 'gemini/gemini-a';
  const store = new WorkspaceChats(db, async (owner, turn) => {
    calls.push(turn);
    return {thread:turn.thread || randomUUID(), model:turn.model, status:'completed', reply:turn.prompt};
  });
  const {id} = store.send('alice', null, randomUUID(), 'one', codex);
  await setImmediate();
  store.send('bob', null, randomUUID(), 'other workspace', codex);
  await setImmediate();
  store.send('alice', id, randomUUID(), 'two', gemini);
  await setImmediate();
  assert.equal(calls[2].thread,null);
  assert.deepEqual(JSON.parse(calls[2].context), {partial:false,turns:[{prompt:'one',reply:'one'}]});
  store.send('alice', id, randomUUID(), 'three', gemini);
  await setImmediate();
  assert.ok(calls[3].thread);
  assert.equal(calls[3].context,undefined);
  store.send('alice', id, randomUUID(), 'four', codex);
  await setImmediate();
  assert.equal(calls[4].thread,null);
  assert.deepEqual(JSON.parse(calls[4].context).turns.map(t=>t.reply), ['one','two','three']);
  db.prepare("UPDATE workspace_turns SET reply=? WHERE prompt='four'").run('🤖'.repeat(24000));
  store.send('alice',id,randomUUID(),'five',gemini);
  await setImmediate();
  assert.ok(Buffer.byteLength(calls[5].context)<=32768);
  assert.equal(JSON.parse(calls[5].context).partial,true);
  db.close();
});

test('upgrading an existing chat preserves history without inventing its model', async () => {
  const db = new DatabaseSync(':memory:'), request = randomUUID();
  let store = new WorkspaceChats(db,async () => ({thread:randomUUID(), reply:'old answer', status:'completed'}));
  const chat = store.send('owner',null,request,'old prompt');
  await setImmediate();
  db.exec('ALTER TABLE workspace_chats DROP COLUMN model; ALTER TABLE workspace_turns DROP COLUMN model; ALTER TABLE workspace_turns DROP COLUMN requested_model;');
  store = new WorkspaceChats(db,() => assert.fail('Replayed during upgrade'));
  const history = store.read('owner',chat.id,Number.MAX_SAFE_INTEGER);
  assert.equal(history.model,null);
  assert.equal(history.turns[0].reply,'old answer');
  assert.equal(history.turns[0].model,null);
  assert.deepEqual(store.send('owner',null,request,'old prompt'),chat);
  db.close();
});

test('a reopened chat keeps its model, isolates turns and rejects mismatched acknowledgments', async () => {
  const db = new DatabaseSync(':memory:'), thread = randomUUID(), first = randomUUID();
  const run = async (_, turn) => ({status:'completed', thread, model:turn.model, reply:'hi'});
  let chats = new WorkspaceChats(db,run);
  const {id} = chats.send('alice',null,first,'hi','model-a');
  assert.throws(() => chats.send('alice',null,first,'hi','model-b'),{status:409});
  assert.throws(() => chats.send('alice',id,randomUUID(),'hi',''),{status:400});
  await setImmediate();
  chats.send('alice',id,randomUUID(),'hi again','model-b');
  await setImmediate();
  chats = new WorkspaceChats(db,run);
  chats.send('alice',id,randomUUID(),'hi from old client');
  await setImmediate();
  chats.run = async () => ({thread, status:'completed', reply:'wrong', model:'model-a'});
  chats.send('alice',id,randomUUID(),'hi','model-b');
  await setImmediate();
  const view = chats.read('alice',id,Number.MAX_SAFE_INTEGER);
  assert.equal(view.model,'model-b');
  assert.deepEqual(view.turns.map(t=>t.model),['model-a','model-b','model-b',null]);
  assert.equal(view.turns.at(-1).state,'interrupted');
  assert.equal(view.turns.at(-1).reply,null);
  db.close();
});
