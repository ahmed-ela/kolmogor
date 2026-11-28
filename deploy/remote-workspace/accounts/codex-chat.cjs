// Private stdio transport inside the owner's CLI pod. Publish only answer text for the acknowledged turn.
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { readFileSync } = require('node:fs');

const maxText = 96 * 1024;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const cwd = '/opt/kolmogor-chat/workspace';
function output(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function launch() {
  return spawn('codex', ['--disable', 'shell_tool', 'app-server', '--listen', 'stdio://'], {
    cwd, env: { ...process.env, CODEX_HOME: '/opt/kolmogor-chat/home' },
    detached: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
}

async function reply({ thread, prompt }, start = launch, publish = output) {
  const proc = start();
  const stop = () => {
    if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
    }
  };
  const closed = new Promise((resolve) => {
    proc.once('error', () => resolve(-1));
    proc.once('close', resolve);
  });
  proc.stdin.on('error', () => {});
  const timeout = setTimeout(stop, 115000);
  const send = (value) => proc.stdin.write(JSON.stringify(value) + '\n');
  const options = { cwd, sandbox: 'read-only', approvalPolicy: 'never', modelProvider: 'openai' };
  let session, turn, item, answer, bytes = 0, completed = false, failed = false;
  try {
    send({ id: 1, method: 'initialize', params: {clientInfo: {name:'kolmogor_workspace',version:'1'}} });
    for await (const line of createInterface({input:proc.stdout, crlfDelay:Infinity})) {
      const event = JSON.parse(line), p = event.params;
      if (event.id !== undefined) {
        // This client never grants permissions, serves tools or accepts server requests.
        if (event.method || event.error) throw Error('Unexpected worker request or error');
        if (event.id === 1) {
          send({method:'initialized'});
          send({id:2, method: thread ? 'thread/resume' : 'thread/start',
            params: thread ? {...options, threadId:thread} : options});
        } else if (event.id === 2) {
          session = event.result?.thread?.id;
          if (!uuid.test(session) || (thread && session !== thread)) throw Error('Thread mismatch');
          send({id:3, method:'turn/start', params:{threadId:session, input:[{type:'text',text:prompt}]}});
        } else if (event.id === 3) {
          turn = event.result?.turn?.id;
          if (!turn) throw Error('Missing turn');
        }
        continue;
      }
      if (!turn || p?.threadId !== session) continue;
      if (event.method === 'turn/completed' && p.turn?.id === turn) {
        completed = p.turn.status === 'completed';
        failed = p.turn.status === 'failed';
        proc.stdin.end();
        continue;
      }
      if (completed || failed || p.turnId !== turn) continue;
      if (event.method === 'item/started' && p.item?.type === 'agentMessage' && p.item.phase === 'final_answer') {
        if (item) throw Error('Multiple final answer items');
        item = p.item.id;
      } else if (item && event.method === 'item/agentMessage/delta' && p.itemId === item && typeof p.delta === 'string') {
        bytes += Buffer.byteLength(p.delta);
        if (bytes > maxText) throw Error('Answer too large');
        publish({delta:p.delta});
      } else if (event.method === 'item/completed' && p.item?.type === 'agentMessage' &&
          (p.item.phase === 'final_answer' || p.item.phase == null) && (!item || item === p.item.id)) {
        answer = p.item.text;
      }
    }
    if (await closed === 0 && completed && !failed && typeof answer === 'string' &&
        answer.trim() && Buffer.byteLength(answer) <= maxText)
      return {status:'completed', thread:session, reply:answer};
    return {status:failed ? 'failed' : 'interrupted', thread:session};
  } finally {
    clearTimeout(timeout);
    stop();
  }
}

module.exports = { reply };
if (require.main === module || (!process.argv[1] && process.execArgv.includes('-e')))
  reply(JSON.parse(readFileSync(0, 'utf8'))).then(output).catch(() => { process.exitCode = 1; });
