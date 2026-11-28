// Private stdio transport inside the owner's CLI pod. Publish only answer text for the acknowledged turn.
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { readFileSync } = require('node:fs');

const maxText = 96 * 1024;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const cwd = '/opt/kolmogor-chat/workspace';
const modelID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/;
function output(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function launch() {
  return spawn('codex', ['--disable', 'shell_tool', 'app-server', '--listen', 'stdio://'], {
    cwd, env: { ...process.env, CODEX_HOME: '/opt/kolmogor-chat/home' },
    detached: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
}

async function reply({ thread, prompt, model, operation }, start = launch, publish = output) {
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
  const listOnly = operation === 'models';
  const catalog = new Map(), cursors = new Set();
  const list = (cursor) => send({id:4, method:'model/list', params:{modelProvider:'openai', includeHidden:false, limit:100, cursor}});
  function openThread() {
    if (model) options.model = model;
    if (thread) options.threadId = thread;
    send({id:2, method:thread ? 'thread/resume' : 'thread/start', params:options});
  }
  let resolvedModel, catalogResult, plan, rerouted = false;
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
          if (listOnly) send({id:6,method:'account/read',params:{refreshToken:false}});
          else if (model) list(null);
          else openThread();
        } else if (event.id === 6) {
          const tier = event.result?.account?.planType;
          if (typeof tier === 'string' && /^[a-z_]{1,32}$/.test(tier)) plan = tier;
          list(null);
        } else if (event.id === 4) {
          for (const row of event.result.data) {
            if (!row.hidden && typeof row.model === 'string' && modelID.test(row.model))
              catalog.set(row.model, {id:row.model, name:String(row.displayName || row.model).slice(0,120), isDefault:row.isDefault === true});
          }
          const cursor = event.result.nextCursor;
          if (catalog.size > 256 || cursors.size > 10) throw Error('Unexpected catalog size');
          if (cursor) {
            if (cursors.has(cursor)) throw Error('Repeated model cursor');
            cursors.add(cursor);
            list(cursor);
          } else if (listOnly || !catalog.has(model)) {
            catalogResult = listOnly ? {models:[...catalog.values()], ...(plan && {plan})} : {status:'model_unavailable'};
            proc.stdin.end();
          } else openThread();
        } else if (event.id === 2) {
          session = event.result?.thread?.id;
          if (!uuid.test(session) || (thread && session !== thread)) throw Error('Thread mismatch');
          resolvedModel = event.result.model;
          if (model && resolvedModel !== model) {
            catalogResult = {status:'model_unavailable'};
            proc.stdin.end();
          } else {
            const params = {threadId:session, input:[{type:'text',text:prompt}]};
            if (model) params.model = model;
            send({id:3, method:'turn/start', params});
          }
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
      if (event.method === 'model/rerouted') {
        if (p.fromModel !== resolvedModel || typeof p.toModel !== 'string' || !modelID.test(p.toModel))
          throw Error('Invalid model reroute');
        resolvedModel = p.toModel;
        rerouted = true;
        continue;
      }
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
    const code = await closed;
    if (code === 0 && catalogResult) return catalogResult;
    if (code === 0 && completed && !failed && typeof answer === 'string' &&
        answer.trim() && Buffer.byteLength(answer) <= maxText)
      return {status:'completed', thread:session, reply:answer, ...(resolvedModel ? {model:resolvedModel} : {}), ...(rerouted && {rerouted})};
    return {status:failed ? 'failed' : 'interrupted', thread:session};
  } finally {
    clearTimeout(timeout);
    stop();
  }
}

module.exports = { reply };
if (require.main === module || (!process.argv[1] && process.execArgv.includes('-e')))
  reply(JSON.parse(readFileSync(0, 'utf8'))).then(output).catch(() => { process.exitCode = 1; });
