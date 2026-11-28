const $ = (id) => document.getElementById(id);

function icon(name, className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

async function api(path, data) {
  const response = await fetch(
    '/api/chats' + path,
    data
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        }
      : {},
  );
  const body = await response.json();
  if (response.status === 401) {
    location.replace('/');
    throw new Error('Sign in to reopen your workspace.');
  }
  if (!response.ok)
    throw Object.assign(new Error(body.error || 'Could not load chats.'), { status: response.status });
  return body;
}

export function openChats(account) {
  const key = 'kolmogor.workspace.selectedChat.' + account;
  let selected = null,
    generation = 0,
    next,
    working = false,
    sending = false,
    retry;
  let rows = new Map(),
    list = new Map(),
    busyRead = false,
    timer;

  const drafts = new Map();
  const input = $('chat-input');
  const scroller = $('conversation');
  let followReply = true;

  function sizeInput() {
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
  }

  function controls() {
    const visible = selected !== null;
    $('all-chats').hidden = !visible;
    $('chat-index').hidden = visible;
    $('conversation').hidden = !visible;
    $('chat-form').hidden = !visible;
    $('new-chat').hidden = visible;
    $('draft-greeting').hidden = selected !== '';
    $('workspace').toggleAttribute('data-thread', visible);
    $('destinations').hidden = visible;
    $('chat-send').disabled = sending || working || !$('chat-input').value.trim();
    input.readOnly = sending;
    $('new-chat').disabled = sending || selected === '';
    $('all-chats').disabled = sending;
  }

  function select(id, moveFocus = false) {
    if (selected !== null) {
      if (input.value) drafts.set(selected, { value: input.value, retry });
      else drafts.delete(selected);
    }
    generation++;
    selected = id;
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
    next = null;
    rows = new Map();
    list = new Map();
    busyRead = false;
    sending = false;
    working = false;
    retry = drafts.get(id)?.retry;
    followReply = true;
    $('chat-heading').textContent = id === null ? 'Chats' : 'New chat';
    input.value = drafts.get(id)?.value || '';
    $('chat-status').textContent = '';
    $('messages').replaceChildren();
    $('chat-list').replaceChildren();
    $('more-chats').hidden = true;
    $('older-turns').hidden = true;
    $('chat-empty').hidden = true;
    controls();
    if (id !== null) sizeInput();
    if (id === '') {
      input.focus();
      return;
    }
    if (moveFocus) $('chat-heading').focus();
    void refresh();
  }

  function renderList() {
    const items = [...list.values()]
      .sort((a, b) => b.updated - a.updated)
      .map((chat) => {
        const li = document.createElement('li'),
          button = document.createElement('button');
        button.type = 'button';
        const glyph = document.createElement('span'), title = document.createElement('span');
        glyph.className = 'chat-glyph';
        glyph.append(icon('chats'));
        title.className = 'row-title';
        title.textContent = chat.title;
        button.append(glyph, title, icon('next', 'chevron'));
        button.onclick = () => select(chat.id, true);
        li.append(button);
        return li;
      });
    $('chat-list').replaceChildren(...items);
    $('chat-empty').hidden = items.length !== 0;
    $('more-chats').hidden = !next;
  }

  function renderTurns(older) {
    const anchor = scroller.scrollHeight - scroller.scrollTop;
    const atEnd = anchor - scroller.clientHeight < 48;
    const jumpToEnd = followReply || atEnd;
    const turns = [...rows.values()].sort((a, b) => a.seq - b.seq);
    const messages = [];
    const line = (role, text) => {
      const li = document.createElement('li'),
        who = document.createElement('strong'),
        content = document.createElement('div');
      li.className = role === 'You' ? 'user-message' : 'agent-message';
      if (role === 'Codex') who.append(icon('brand'));
      who.append(role);
      content.textContent = text;
      li.append(who, content);
      messages.push(li);
    };
    for (const turn of turns) {
      line('You', turn.prompt);
      if (turn.state === 'completed') line('Codex', turn.reply);
      if (turn.error) line('Workspace', turn.error);
    }
    working = turns.at(-1)?.state === 'working';
    $('messages').replaceChildren(...messages);
    $('older-turns').hidden = !next;
    $('chat-status').textContent = working ? 'Codex is replying…' : '';
    controls();
    if (older) scroller.scrollTop = scroller.scrollHeight - anchor;
    else if (jumpToEnd) scroller.scrollTop = scroller.scrollHeight;
    followReply = false;
  }

  async function refresh(older = false) {
    if (selected === '' || busyRead || sending || (older && !next)) return;
    const epoch = generation,
      before = older ? '?before=' + next : '';
    busyRead = true;
    try {
      const page = await api((selected ? '/' + selected : '') + before);
      if (epoch !== generation) return;
      // Retain older pages during a refresh. A page cursor always refers to the oldest loaded page.
      const cache = selected ? rows : list,
        incoming = selected ? page.turns : page.chats;
      const idOf = (row) => (selected ? row.seq : row.id);
      const oldest = selected
        ? Math.min(...rows.keys())
        : Math.min(...[...list.values()].map((chat) => chat.updated));
      const order = (row) => (selected ? row.seq : row.updated);
      if (!cache.size || older || incoming.some((row) => order(row) <= oldest)) next = page.next;
      else if (incoming.length && !incoming.some((row) => cache.has(idOf(row)))) {
        cache.clear();
        next = page.next;
      }
      let changed = false;
      for (const row of incoming) {
        const id = idOf(row),
          prior = cache.get(id);
        if (!prior || (selected ? prior.state !== row.state : prior.updated !== row.updated))
          changed = true;
        cache.set(id, row);
      }
      if (selected) {
        $('chat-heading').textContent = page.title;
        if (changed || followReply) renderTurns(older);
      } else {
        if (changed || !cache.size) renderList();
        $('chat-status').textContent = '';
      }
    } catch (err) {
      if (epoch !== generation) return;
      if (err.status === 404 && selected) {
        select(null);
        return;
      }
      $('chat-status').textContent = err.message;
    } finally {
      if (generation === epoch) busyRead = false;
    }
  }

  $('first-chat').onclick = $('new-chat').onclick = () => select('');
  $('all-chats').onclick = () => select(null, true);
  $('more-chats').onclick = $('older-turns').onclick = () => refresh(true);
  input.oninput = () => {
    sizeInput();
    controls();
  };
  $('chat-form').onsubmit = async (event) => {
    event.preventDefault();
    const prompt = $('chat-input').value;
    if (working || sending || !prompt.trim()) return;
    if (!retry || retry.prompt !== prompt) retry = { prompt, request: crypto.randomUUID() };
    generation++;
    busyRead = false;
    sending = true;
    controls();
    $('chat-status').textContent = 'Sending…';
    try {
      const result = await api(selected ? '/' + selected : '', retry);
      const same = selected === result.id;
      drafts.delete(selected);
      followReply = true;
      selected = result.id;
      localStorage.setItem(key, selected);
      if (!same) rows.clear();
      retry = undefined;
      input.value = '';
      sizeInput();
      working = true;
      $('chat-status').textContent = 'Codex is replying…';
    } catch (err) {
      $('chat-status').textContent = err.message;
      return;
    } finally {
      sending = false;
      controls();
    }
    await refresh();
    schedule();
  };
  const saved = localStorage.getItem(key);
  select(saved && /^[0-9a-f-]{36}$/.test(saved) ? saved : null);
  async function poll() {
    if (!document.hidden) await refresh();
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    timer = window.setTimeout(poll, working ? 1400 : 8000);
  }
  schedule();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refresh();
  });
  window.addEventListener('pagehide', () => clearTimeout(timer), { once: true });
}
