// Previews exist only while a turn runs. SQLite remains authoritative for completed replies.
export class LiveReply {
  text = '';
  bytes = 0;
  listeners = new Set();

  append(delta) {
    if (!delta) return;
    this.bytes += Buffer.byteLength(delta);
    if (this.bytes > 96 * 1024) throw Error('Chat response too large');
    this.text += delta;
    for (const listener of this.listeners) listener('delta', delta);
  }

  finish() {
    for (const listener of this.listeners) listener('settled', null);
    this.listeners.clear();
  }
}

export function serveReply(res, live, authorized) {
  if (live && live.listeners.size >= 8) {
    res.writeHead(429, { 'Retry-After':'3' });
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type':'text/event-stream; charset=utf-8',
    'Cache-Control':'private, no-store, no-transform',
    'X-Accel-Buffering':'no',
  });
  const heartbeat = setInterval(() => {
    if (!authorized() || !res.write(': keepalive\n\n')) res.destroy();
  }, 5000);
  function send(event, data) {
    if (res.destroyed || res.writableEnded) return;
    if (!authorized()) return res.end();
    // Bound queued writes for slow clients, including a full reconnect snapshot.
    if (res.writableLength > 256 * 1024) return res.destroy();
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
    if (event === 'settled') res.end();
  }
  res.once('close', () => {
    clearInterval(heartbeat);
    live?.listeners.delete(send);
  });
  if (live) {
    live.listeners.add(send);
    send('snapshot', live.text);
  } else {
    send('settled', null);
  }
}
