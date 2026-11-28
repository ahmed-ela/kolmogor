import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { WorkspaceChats } from '../chats.mjs';

const all = Number.MAX_SAFE_INTEGER;
test('deduplicates sends, serializes a thread, scopes every read and resumes only the stored provider thread', async () => {
  const db = new DatabaseSync(':memory:');
  const calls = [];
  const reply = Promise.withResolvers();
  const store = new WorkspaceChats(db, (owner, turn) => {
    calls.push({ owner, turn });
    return reply.promise;
  });
  const key = randomUUID(),
    worker = randomUUID();
  const first = store.send('alice', null, key, 'remember birch');
  assert.deepEqual(store.send('alice', null, key, 'remember birch'), first);
  assert.equal(calls.length, 1);
  assert.throws(() => store.send('alice', null, key, 'other'), { status: 409 });
  assert.throws(() => store.send('alice', first.id, randomUUID(), 'concurrent'), { status: 409 });
  assert.deepEqual(store.list('bob', all).chats, []);
  assert.throws(() => store.read('bob', first.id, all), { status: 404 });
  assert.throws(() => store.send('bob', first.id, randomUUID(), 'other'), { status: 404 });
  reply.resolve({ thread: worker, status: 'completed', reply: 'birch' });
  await setImmediate();
  assert.equal(store.read('alice', first.id, all).turns[0].reply, 'birch');
  store.send('alice', first.id, randomUUID(), 'repeat');
  assert.deepEqual(calls[1], { owner: 'alice', turn: { thread: worker, prompt: 'repeat' } });
  await setImmediate();
  db.close();
});

test('reopening a real SQLite file preserves history and interrupts an uncertain send without replay', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kg-chat-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.sqlite'),
    worker = randomUUID(),
    key = randomUUID();
  let db = new DatabaseSync(path),
    calls = 0;
  let store = new WorkspaceChats(db, async () =>
    ++calls === 1
      ? { status: 'completed', thread: worker, reply: 'first reply' }
      : new Promise(() => {}),
  );
  const chat = store.send('a', null, randomUUID(), 'hello');
  await setImmediate();
  store.send('a', chat.id, key, 'unfinished');
  db.close();
  db = new DatabaseSync(path);
  store = new WorkspaceChats(db, () => assert.fail('No replay'));
  const { turns } = store.read('a', chat.id, all);
  assert.deepEqual(
    turns.map((t) => t.state),
    ['completed', 'interrupted'],
  );
  assert.equal(turns[0].reply, 'first reply');
  assert.equal(store.send('a', chat.id, key, 'unfinished').id, chat.id);
  db.close();
});

test('bounded pages return every turn and every chat, and an unverified provider result is never shown as a reply', async () => {
  const db = new DatabaseSync(':memory:'),
    worker = randomUUID();
  const store = new WorkspaceChats(db, async (_owner, { thread, prompt }) => ({
    thread: thread || worker,
    status: 'completed',
    reply: prompt,
  }));
  const first = store.send('a', null, randomUUID(), 'first');
  await setImmediate();
  for (let n = 0; n < 32; n++) {
    store.send('a', first.id, randomUUID(), 'turn ' + n);
    await setImmediate();
    store.send('a', null, randomUUID(), 'chat ' + n);
    await setImmediate();
  }
  const page = store.list('a', all),
    tail = store.list('a', page.next);
  assert.equal(new Set([...page.chats, ...tail.chats].map((c) => c.id)).size, 33);
  const latest = store.read('a', first.id, all),
    older = store.read('a', first.id, latest.next);
  assert.equal(older.turns[0].prompt, 'first');
  assert.equal(older.turns.length + latest.turns.length, 33);
  store.run = async () => ({ status: 'completed', thread: randomUUID(), reply: 'wrong thread' });
  store.send('a', first.id, randomUUID(), 'last');
  await setImmediate();
  const bad = store.read('a', first.id, all).turns.at(-1);
  assert.equal(bad.state, 'interrupted');
  assert.equal(bad.reply, null);
  db.close();
});
