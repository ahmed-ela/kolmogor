// Runs as the workspace's unprivileged CLI user. Only a verified final response leaves the pod.
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { readFileSync } = require('node:fs');

async function reply({ thread, prompt }) {
  const args = [
    '-a',
    'never',
    '--disable',
    'shell_tool',
    'exec',
    '--sandbox',
    'read-only',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--json',
  ];
  if (thread) args.push('resume', thread);
  args.push('-');
  const child = spawn('codex', args, {
    cwd: '/workspace',
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const exit = new Promise((resolve) => {
    child.once('error', () => resolve(-1));
    child.once('close', resolve);
  });
  function stop() {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
  const timeout = setTimeout(stop, 115000);
  let session,
    text,
    complete = false,
    failed = false;
  try {
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      const event = JSON.parse(line);
      if (event.type === 'thread.started') session = event.thread_id;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message')
        text = event.item.text;
      if (event.type === 'turn.completed') complete = true;
      if (event.type === 'turn.failed') failed = true;
    }
    const code = await exit;
    if (thread && session !== thread) return { status: 'interrupted' };
    if (
      code === 0 &&
      complete &&
      !failed &&
      typeof text === 'string' &&
      text.trim() &&
      Buffer.byteLength(text) <= 98304
    )
      return { status: 'completed', thread: session, reply: text };
    return { status: failed ? 'failed' : 'interrupted', thread: session };
  } finally {
    clearTimeout(timeout);
    stop();
  }
}
reply(JSON.parse(readFileSync(0, 'utf8')))
  .then((result) => console.log(JSON.stringify(result)))
  .catch(() => {
    process.exitCode = 1;
  });
