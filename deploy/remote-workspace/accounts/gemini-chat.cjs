// Conversation-only ACP client for the signed-in Antigravity worker.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const gemini = /^gemini-[a-z0-9][a-z0-9.-]{0,110}$/;
const maxText = 96 * 1024;
const policy = `---
name: kolmogor-chat
description: Answer workspace chat messages
mainAgent: true
subagent: false
tools: []
mcpServers: []
plugins: []
skills: []
commandExecutionPolicy: off
---
Answer the user's message in conversation. You have no tools.
`;

function chatModel(r) {
  return r?.models?.currentModelId;
}
function controls(options = []) {
  return Object.fromEntries(
    options.filter((x) => x.id === 'model' || x.id === 'thought_level').map((x) => [x.id, x.currentValue]),
  );
}

async function reply({ thread, prompt, model }, publish = () => {}, start = spawn) {
  if (!gemini.test(model) || (thread && !uuid.test(thread))) return { status: 'model_unavailable' };
  // Keep the user's workspace files and project customizations outside this chat.
  const cwd = fs.mkdtempSync('/tmp/kolmogor-gemini-');
  let proc, timer;
  try {
    const agents = path.join(cwd, '.agents', 'agents');
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(path.join(agents, 'kolmogor-chat.md'), policy);
    proc = start('agy', ['acp', '--agent', 'kolmogor-chat'], {
      cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    function stop() {
      if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch (err) {
          if (err.code !== 'ESRCH') throw err;
        }
      }
    }
    timer = setTimeout(stop, 115000);
    proc.stdin.on('error', () => {});
    const closed = new Promise((resolve) => {
      proc.once('error', () => resolve(-1));
      proc.once('close', resolve);
    });
    const send = (frame) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
    const rpc = (id, method, params) => send({ id, method, params });
    let session,
      expectedControls,
      prompting = false,
      result,
      bytes = 0;
    const chunks = [];
    rpc(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'kolmogor_workspace', version: '1' },
    });
    try {
      for await (const line of createInterface({ input: proc.stdout, crlfDelay: Infinity })) {
        const m = JSON.parse(line),
          p = m.params;
        if (m.method && m.id != null) {
          if (m.method === 'session/request_permission')
            send({ id: m.id, result: { outcome: { outcome: 'cancelled' } } });
          else send({ id: m.id, error: { code: -32601, message: 'Unavailable in a workspace chat' } });
          throw Error('Unexpected agent request');
        }
        if (m.error) throw Error('Gemini request failed');
        if (m.id === 1) {
          if (m.result?.protocolVersion !== 1) throw Error('ACP version mismatch');
          rpc(2, thread ? 'session/resume' : 'session/new', {
            cwd,
            mcpServers: [],
            ...(thread && { sessionId: thread }),
          });
        } else if (m.id === 2) {
          session = m.result?.sessionId ?? thread;
          if (!uuid.test(session) || (thread && session !== thread)) throw Error('Session mismatch');
          if (!m.result?.models?.availableModels?.some((row) => row.modelId === model)) {
            result = { status: 'model_unavailable' };
            proc.stdin.end();
          } else rpc(3, 'session/set_model', { sessionId: session, modelId: model });
        } else if (m.id === 3) {
          rpc(4, 'session/resume', { sessionId: session, cwd, mcpServers: [] });
        } else if (m.id === 4) {
          if ((m.result?.sessionId && m.result.sessionId !== session) || chatModel(m.result) !== model)
            throw Error('Model selection not confirmed');
          expectedControls = controls(m.result.configOptions);
          prompting = true;
          rpc(5, 'session/prompt', { sessionId: session, prompt: [{ type: 'text', text: prompt }] });
        } else if (m.method === 'session/update' && prompting && p?.sessionId === session) {
          const u = p.update;
          if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update')
            throw Error('Unexpected tool');
          if (
            u.sessionUpdate === 'config_option_update' &&
            Object.entries(controls(u.configOptions)).some(([k, v]) => expectedControls[k] !== v)
          )
            throw Error('Model changed during reply');
          if (
            u.sessionUpdate === 'agent_message_chunk' &&
            u.content?.type === 'text' &&
            typeof u.content.text === 'string'
          ) {
            const delta = u.content.text;
            bytes += Buffer.byteLength(delta);
            if (bytes > maxText) throw Error('Reply too large');
            chunks.push(delta);
            publish({ delta });
          }
        } else if (m.id === 5 && prompting) {
          prompting = false;
          const answer = chunks.join('');
          result =
            m.result?.stopReason === 'end_turn' && answer.trim()
              ? { status: 'completed', thread: session, model, reply: answer }
              : { status: 'failed' };
          proc.stdin.end();
        }
      }
      return (await closed) === 0 && result ? result : { status: 'interrupted' };
    } finally {
      stop();
    }
  } finally {
    clearTimeout(timer);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
module.exports = { reply };
if (require.main === module || (!process.argv[1] && process.execArgv.includes('-e'))) {
  const write = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  reply(JSON.parse(fs.readFileSync(0, 'utf8')), write)
    .then(write)
    .catch(() => {
      process.exitCode = 1;
    });
}
