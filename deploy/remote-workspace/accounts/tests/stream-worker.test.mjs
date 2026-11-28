import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import worker from '../codex-chat.cjs';

function fakeServer(thread, completed = true, {calls = [], resolved, reroute} = {}) {
  const proc = new EventEmitter();
  const turnId = randomUUID();
  const emit = (message) => proc.stdout.write(JSON.stringify(message) + '\n');
  const notice = (method, params) => emit({method, params:{threadId:thread, turnId, ...params}});
  proc.stdout = new PassThrough();
  proc.stdin = new Writable({
    write(chunk, _, done) {
      const r = JSON.parse(chunk);
      calls.push(r);
      if (r.id === 1) emit({id:1, result:{}});
      if (r.method === 'account/read') emit({id:r.id,result:{account:{type:'chatgpt',planType:'pro'}}});
      if (r.method === 'model/list') {
        assert.equal(r.params.includeHidden,false);
        emit({id:r.id, result:r.params.cursor
          ? {data:[{model:'b',displayName:'B'}],nextCursor:null}
          : {data:[{model:'a',displayName:'A',isDefault:true},{model:'secret',hidden:true}],nextCursor:'more'}});
      }
      if (r.id === 2) {
        assert.equal(r.params.sandbox,'read-only');
        assert.equal(r.params.approvalPolicy,'never');
        emit({id:2, result:{thread:{id:thread},model:resolved ?? r.params.model}});
      }
      if (r.id === 3) {
        emit({id:3, result:{turn:{id:turnId}}});
        if (reroute) notice('model/rerouted',{fromModel:r.params.model,toModel:reroute});
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

test('pages the signed-in catalog and validates the same model on resume and on turn start', async () => {
  const thread = randomUUID(), calls = [];
  const run = (input,options) => worker.reply(input,() => fakeServer(thread,true,{calls,...options}),() => {});
  const {models} = await run({operation:'models'});
  assert.deepEqual(models.map(m => [m.id,m.isDefault]),[['a',true],['b',false]]);
  assert.ok(!calls.some(r => r.method.startsWith('thread/')));
  for (const [model,options] of [['secret',{}],['a',{resolved:'b'}]]) {
    assert.equal((await run({thread,prompt:'hi',model},options)).status,'model_unavailable');
    assert.ok(!calls.some(r => r.method === 'turn/start'));
  }
  const result = await run({thread,model:'b',prompt:'hi'});
  assert.equal(result.model,'b');
  assert.equal(calls.findLast(r=>r.method==='thread/resume').params.model,'b');
  assert.equal(calls.findLast(r=>r.method==='turn/start').params.model,'b');
  const changed = await run({thread,model:'a',prompt:'hi'},{reroute:'b'});
  assert.equal(changed.model,'b');
  assert.equal(changed.rerouted,true);
});
