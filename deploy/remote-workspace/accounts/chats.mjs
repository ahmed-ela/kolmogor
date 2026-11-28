import { createHash, randomUUID } from 'node:crypto';

export const chatID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const pageSize = 30;

export class ChatError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The account service is a single writer. The CLI's resumable thread is an implementation detail.
export class WorkspaceChats {
  constructor(db, run) {
    this.db = db;
    this.run = run;
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_chats (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, provider_thread TEXT,
        updated INTEGER NOT NULL, UNIQUE(owner,id)
      );
      CREATE INDEX IF NOT EXISTS chat_activity ON workspace_chats(owner, updated DESC);
      CREATE TABLE IF NOT EXISTS workspace_turns (
        seq INTEGER PRIMARY KEY, owner TEXT NOT NULL, chat TEXT NOT NULL, request TEXT NOT NULL,
        fingerprint TEXT NOT NULL, prompt TEXT NOT NULL, reply TEXT, error TEXT,
        state TEXT NOT NULL CHECK(state IN ('working','completed','failed','interrupted')),
        UNIQUE(owner,request), FOREIGN KEY(owner,chat) REFERENCES workspace_chats(owner,id)
      );
      CREATE INDEX IF NOT EXISTS chat_history ON workspace_turns(owner,chat,seq);
      CREATE UNIQUE INDEX IF NOT EXISTS chat_inflight ON workspace_turns(owner,chat) WHERE state='working';
      UPDATE workspace_turns SET state='interrupted', error='The chat service restarted before it could confirm the reply. Your message was saved.' WHERE state='working';
    `);
  }

  list(owner, before) {
    // Activity uses the globally increasing turn sequence, so there are no timestamp ties.
    const rows = this.db
      .prepare(
        'SELECT id,title,updated FROM workspace_chats WHERE owner=? AND updated<? ORDER BY updated DESC LIMIT ?',
      )
      .all(owner, before, pageSize + 1);
    const chats = rows.slice(0, pageSize);
    return { chats, next: rows.length > pageSize ? chats.at(-1).updated : null };
  }

  read(owner, id, before) {
    const chat = this.db
      .prepare('SELECT id,title FROM workspace_chats WHERE owner=? AND id=?')
      .get(owner, id);
    if (!chat) throw new ChatError(404, 'Chat not found.');
    const rows = this.db
      .prepare(
        'SELECT seq,request,prompt,reply,state,error FROM workspace_turns WHERE owner=? AND chat=? AND seq<? ORDER BY seq DESC LIMIT ?',
      )
      .all(owner, id, before, pageSize + 1);
    const turns = rows.slice(0, pageSize).reverse();
    return { ...chat, turns, next: rows.length > pageSize ? turns[0].seq : null };
  }

  send(owner, target, request, prompt) {
    if (
      typeof request !== 'string' ||
      !chatID.test(request) ||
      typeof prompt !== 'string' ||
      !prompt.trim() ||
      Buffer.byteLength(prompt) > 8192
    )
      throw new ChatError(400, 'Enter a message of up to 8 KB.');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([target, prompt]))
      .digest('hex');
    const old = this.db
      .prepare('SELECT chat,request,fingerprint FROM workspace_turns WHERE owner=? AND request=?')
      .get(owner, request);
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new ChatError(409, 'This send identifier already belongs to another message.');
      return { id: old.chat, request };
    }
    let chat;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (target) {
        chat = this.db
          .prepare('SELECT id,provider_thread FROM workspace_chats WHERE owner=? AND id=?')
          .get(owner, target);
        if (!chat) throw new ChatError(404, 'Chat not found.');
        if (
          this.db
            .prepare("SELECT 1 FROM workspace_turns WHERE owner=? AND chat=? AND state='working'")
            .get(owner, target)
        )
          throw new ChatError(409, 'Wait for the current reply before sending another message.');
      }
      if (
        this.db
          .prepare("SELECT count(*) AS n FROM workspace_turns WHERE owner=? AND state='working'")
          .get(owner).n >= 2
      )
        throw new ChatError(429, 'Two replies are already running in this workspace.');
      if (!chat) {
        chat = { id: randomUUID(), provider_thread: null };
        const title = Array.from(prompt.trim().replace(/\s+/gu, ' ')).slice(0, 80).join('');
        this.db
          .prepare('INSERT INTO workspace_chats(id,owner,title,updated) VALUES(?,?,?,0)')
          .run(chat.id, owner, title);
      }
      const { lastInsertRowid } = this.db
        .prepare(
          "INSERT INTO workspace_turns(owner,chat,request,fingerprint,prompt,state) VALUES(?,?,?,?,?,'working')",
        )
        .run(owner, chat.id, request, fingerprint, prompt);
      this.db
        .prepare('UPDATE workspace_chats SET updated=? WHERE owner=? AND id=?')
        .run(lastInsertRowid, owner, chat.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    void this.finish(owner, chat, request, prompt).catch(() =>
      console.error('Workspace chat result could not be saved'),
    );
    return { id: chat.id, request };
  }

  async finish(owner, chat, request, prompt) {
    let result;
    try {
      result = await this.run(owner, { thread: chat.provider_thread, prompt });
    } catch {
      result = null;
    }
    const thread =
      typeof result?.thread === 'string' &&
      chatID.test(result.thread) &&
      (!chat.provider_thread || result.thread === chat.provider_thread)
        ? result.thread
        : null;
    const valid =
      thread &&
      result.status === 'completed' &&
      typeof result.reply === 'string' &&
      result.reply.trim() &&
      Buffer.byteLength(result.reply) <= 98304;
    const messages = {
      disconnected: 'Connect Codex in this workspace and send again.',
      failed: 'Codex could not complete this reply.',
      capacity: 'The workspace is still starting. Try again when Codex is connected.',
    };
    const confirmedFailure = Object.hasOwn(messages, result?.status);
    const state = valid ? 'completed' : confirmedFailure ? 'failed' : 'interrupted';
    const error = valid
      ? null
      : confirmedFailure
        ? messages[result.status]
        : 'The worker did not confirm a reply. Your message was saved and was not sent again.';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db
        .prepare(
          "UPDATE workspace_turns SET reply=?,state=?,error=? WHERE owner=? AND request=? AND state='working'",
        )
        .run(valid ? result.reply : null, state, error, owner, request).changes;
      if (changed && thread)
        this.db
          .prepare('UPDATE workspace_chats SET provider_thread=? WHERE owner=? AND id=?')
          .run(thread, owner, chat.id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

export async function chatRoute({ chats, workspace, req, url, json }) {
  const match = /^\/api\/chats(?:\/([a-f0-9-]+))?$/.exec(url.pathname);
  if (!match || (match[1] && !chatID.test(match[1]))) throw new ChatError(404, 'Chat not found.');
  const id = match[1] || null;
  if (req.method === 'GET') {
    const before = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(before) || before < 1) throw new ChatError(400, 'Invalid page.');
    return json(200, id ? chats.read(workspace, id, before) : chats.list(workspace, before));
  }
  if (req.method !== 'POST') throw new ChatError(405, 'Unsupported chat action.');
  if (req.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new ChatError(415, 'Send JSON.');
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    if ((bytes += chunk.length) > 65536) throw new ChatError(413, 'Message too large.');
    chunks.push(chunk);
  }
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ChatError(400, 'Invalid message.');
  }
  return json(202, chats.send(workspace, id, data?.request, data?.prompt));
}
