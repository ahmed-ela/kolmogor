import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import wrapper from '../gemini-chat.cjs';

const model = 'gemini-test-low';
const session = randomUUID();
function server(calls, { confirmed = model, forbidden, change, stop = 'end_turn' } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  const emit = (frame) => proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
  const update = (sessionId, data) => emit({ method: 'session/update', params: { sessionId, update: data } });
  proc.stdin = new Writable({
    write(chunk, encoding, done) {
      const rpc = JSON.parse(chunk);
      calls.push(rpc);
      if (rpc.id === 1) emit({ id: 1, result: { protocolVersion: 1 } });
      if (rpc.id === 2)
        emit({ id: 2, result: { sessionId: session, models: { availableModels: [{ modelId: model }] } } });
      if (rpc.id === 3) emit({ id: 3, result: {} });
      if (rpc.id === 4)
        emit({
          id: 4,
          result: {
            sessionId: session,
            models: { currentModelId: confirmed },
            configOptions: [
              { id: 'model', currentValue: 'gemini-test' },
              { id: 'thought_level', currentValue: 'low' },
            ],
          },
        });
      if (rpc.id === 5) {
        if (forbidden)
          emit({ id: 'permission', method: 'session/request_permission', params: { sessionId: session } });
        if (change)
          update(session, {
            sessionUpdate: 'config_option_update',
            configOptions: [{ id: 'thought_level', currentValue: 'high' }],
          });
        update(randomUUID(), {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'wrong chat' },
        });
        update(session, {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'private thought' },
        });
        for (const part of ['answer', ' text'])
          update(session, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part } });
        emit({ id: 5, result: { stopReason: stop } });
      }
      done();
    },
    final(done) {
      proc.stdout.end();
      proc.emit('close', 0);
      done();
    },
  });
  return proc;
}
function run(opts = {}, thread = null) {
  const calls = [],
    events = [];
  const done = wrapper.reply(
    { model, thread, prompt: 'hi' },
    (e) => events.push(e.delta),
    (_cmd, args) => {
      assert.deepEqual(args, ['acp', '--agent', 'kolmogor-chat']);
      return server(calls, opts);
    },
  );
  return { calls, events, done };
}
test('Gemini confirms the exact model and effort, and resumes only the bound session', async () => {
  const { calls, events, done } = run({}, session);
  assert.deepEqual(await done, { status: 'completed', thread: session, model, reply: 'answer text' });
  assert.deepEqual(events, ['answer', ' text']);
  assert.equal(calls[1].method, 'session/resume');
  assert.equal(calls[1].params.sessionId, session);
  assert.equal(calls[2].params.modelId, model);
  assert.deepEqual(
    calls.map((r) => r.method),
    ['initialize', 'session/resume', 'session/set_model', 'session/resume', 'session/prompt'],
  );
});
test('a mismatched model, changed effort, permission request or interrupted completion cannot confirm an answer', async () => {
  const mismatch = run({ confirmed: 'other' });
  await assert.rejects(mismatch.done, /not confirmed/);
  assert.ok(!mismatch.calls.some((r) => r.method === 'session/prompt'));
  const changed = run({ change: true });
  await assert.rejects(changed.done, /Model changed/);
  assert.deepEqual(changed.events, []);
  const blocked = run({ forbidden: true });
  await assert.rejects(blocked.done, /Unexpected agent request/);
  assert.equal(blocked.calls.at(-1).result.outcome.outcome, 'cancelled');
  assert.deepEqual(blocked.events, []);
  assert.equal((await run({ stop: 'cancelled' }).done).status, 'failed');
});
