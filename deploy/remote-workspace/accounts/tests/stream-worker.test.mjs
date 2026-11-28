import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import worker from '../codex-chat.cjs';

function fakeServer(thread, completed = true) {
  const proc = new EventEmitter();
  const turnId = randomUUID();
  const emit = (message) => proc.stdout.write(JSON.stringify(message) + '\n');
  const notice = (method, params) => emit({method, params:{threadId:thread, turnId, ...params}});
  proc.stdout = new PassThrough();
  proc.stdin = new Writable({
    write(chunk, _, done) {
      const r = JSON.parse(chunk);
      if (r.id === 1) emit({id:1, result:{}});
      if (r.id === 2) {
        assert.equal(r.params.sandbox,'read-only');
        assert.equal(r.params.approvalPolicy,'never');
        emit({id:2, result:{thread:{id:thread}}});
      }
      if (r.id === 3) {
        emit({id:3, result:{turn:{id:turnId}}});
        notice('item/started',{item:{id:'reason',type:'agentMessage',phase:'commentary'}});
        notice('item/agentMessage/delta',{itemId:'reason',delta:'commentary'});
        notice('item/started',{item:{id:'final',type:'agentMessage',phase:'final_answer'}});
        notice('item/agentMessage/delta',{threadId:randomUUID(),itemId:'final',delta:'other thread'});
        notice('item/agentMessage/delta',{turnId:randomUUID(),itemId:'final',delta:'other turn'});
        notice('item/reasoning/textDelta',{itemId:'final',delta:'reasoning'});
        notice('item/agentMessage/delta',{itemId:'other',delta:'another item'});
        notice('item/agentMessage/delta',{itemId:'final',delta:'one '});
        notice('item/agentMessage/delta',{itemId:'final',delta:'two'});
        notice('item/completed',{item:{id:'final',type:'agentMessage',phase:'final_answer',text:'one two'}});
        notice('turn/completed',{turn:{id:turnId,status:completed ? 'completed' : 'failed'}});
      }
      done();
    },
    final(done) { proc.stdout.end(); proc.emit('close',0); done(); },
  });
  return proc;
}

test('only live answer deltas belonging to the acknowledged thread, turn and item leave the worker', async () => {
  const thread = randomUUID(), frames = [];
  const result = await worker.reply({thread, prompt:'hello'}, () => fakeServer(thread), frame => frames.push(frame.delta));
  assert.deepEqual(frames,['one ','two']);
  assert.deepEqual(result,{status:'completed',thread,reply:'one two'});
  const failed = await worker.reply({thread,prompt:'again'}, () => fakeServer(thread,false), () => {});
  assert.equal(failed.status,'failed');
  assert.equal(failed.reply,undefined);
});
