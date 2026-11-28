import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { workspaceBroker } from '../broker-client.mjs';

test('chat socket preserves split UTF-8 frames and a preview cannot complete a disconnected turn', async t => {
  const dir = mkdtempSync('/tmp/kg-stream-');
  const path = join(dir,'broker.sock');
  const server = createServer(socket => {
    socket.once('data', bytes => {
      const {turn} = JSON.parse(bytes);
      const data = Buffer.from('{"delta":"🌲"}\n{"delta":" cedar"}\n');
      socket.write(data.subarray(0,12));
      const last = turn.prompt === 'interrupt' ? '' : '{"status":"completed","reply":"🌲 cedar"}\n';
      setImmediate(() => socket.end(Buffer.concat([data.subarray(12),Buffer.from(last)])));
    });
  }).listen(path);
  await once(server,'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir,{recursive:true,force:true});
  });
  const broker = workspaceBroker(path), received = [];
  const run = prompt => broker.chat('owner',{thread:null,prompt},delta=>received.push(delta));
  const result = await run('hello');
  assert.deepEqual(received,['🌲',' cedar']);
  assert.equal(result.reply,received.join(''));
  await assert.rejects(run('interrupt'), /unavailable/);
});
