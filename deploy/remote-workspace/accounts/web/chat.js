const $ = (id) => document.getElementById(id);
const sourceName = model => model?.startsWith('gemini/') ? 'Gemini' : 'Codex';

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
  const choices = new Map();
  const picker = $('chat-model');
  let catalog = [], providers = {}, loadingModels, catalogError = '', storedModel, historyReady = false;
  function renderPicker() {
    const choice = choices.get(selected) || storedModel || catalog.find((m) => m.isDefault)?.id || catalog[0]?.id;
    const options = [];
    for (const [key,label] of [['codex','Codex'],['gemini','Gemini']]) {
      const models = catalog.filter(row => row.provider === key);
      if (!models.length) continue;
      const group = document.createElement('optgroup');
      const tier = providers[key]?.plan;
      group.label = tier ? label + ' · ' + tier[0].toUpperCase() + tier.slice(1) : label;
      for (const {id,name} of models) group.append(new Option(name,id));
      options.push(group);
    }
    if (!options.length) options.push(new Option(catalogError || 'Loading models…', ''));
    else if (choice && !catalog.some((m) => m.id === choice))
      options.unshift(new Option(choice + ' (unavailable)', ''));
    picker.replaceChildren(...options);
    picker.value = catalog.some((m) => m.id === choice) ? choice : '';
    controls();
  }
  async function loadModels() {
    if (loadingModels) return loadingModels;
    catalogError = '';
    loadingModels = api('/models').then((result) => {
      catalog = result.models || [];
      providers = result.providers || {};
      if (!catalog.length) catalogError = 'Connect a provider in Connections';
      else if (Object.values(providers).some(p => p.status === 'unavailable')) catalogError = 'Some models are unavailable';
    }).catch(() => {
      catalog = [];
      catalogError = 'Models unavailable';
    }).finally(() => {
      loadingModels = undefined;
      renderPicker();
    });
    renderPicker();
    return loadingModels;
  }
  picker.onchange = () => {
    choices.set(selected, picker.value);
    controls();
  };
  $('retry-models').onclick = loadModels;
  const input = $('chat-input');
  const scroller = $('conversation');
  let followReply = true;
  let source, streamRequest, paint, preview = '';

  function closeStream() {
    cancelAnimationFrame(paint);
    paint = undefined;
    source?.close();
    source = undefined;
    streamRequest = undefined;
    preview = '';
  }

  function showPreview() {
    paint = undefined;
    const line = $('live-reply');
    if (!line) return;
    const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    line.hidden = !preview;
    line.lastElementChild.textContent = preview;
    if (atEnd) scroller.scrollTop = scroller.scrollHeight;
  }

  function watchReply(request) {
    if (request && streamRequest === request) return;
    closeStream();
    if (!request || document.hidden) return;
    const events = new EventSource('/api/chats/' + selected + '/turns/' + request + '/events');
    streamRequest = request;
    source = events;
    for (const type of ['snapshot', 'delta']) {
      events.addEventListener(type, (event) => {
        if (source !== events) return;
        const text = JSON.parse(event.data);
        preview = type === 'snapshot' ? text : preview + text;
        paint ??= requestAnimationFrame(showPreview);
      });
    }
    events.addEventListener('settled', () => {
      if (source !== events) return;
      closeStream();
      void refresh();
    });
    events.onerror = () => {
      if (source !== events) return;
      if (events.readyState === EventSource.CLOSED) closeStream();
      // The scheduled read rechecks authorization and history. A rejected subscription
      // must not immediately create another one; EventSource retries transient disconnects.
      schedule();
    };
  }

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
    picker.hidden = !visible;
    picker.disabled = !historyReady || !catalog.length || sending || working || Boolean(retry && retry.prompt === input.value);
    $('retry-models').hidden = !visible || !catalogError;
    $('chat-send').disabled = sending || working || !historyReady || !picker.value || !$('chat-input').value.trim();
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
    closeStream();
    selected = id;
    storedModel = undefined;
    historyReady = id === '';
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
    renderPicker();
    if (id !== null) void loadModels();
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
    const line = (role, text, modelLabel) => {
      const li = document.createElement('li'),
        who = document.createElement('strong'),
        content = document.createElement('div');
      li.className = role === 'You' ? 'user-message' : 'agent-message';
      if (role === 'Codex' || role === 'Gemini') who.append(icon('brand'));
      who.append(modelLabel || role);
      content.textContent = text;
      li.append(who, content);
      messages.push(li);
      return li;
    };
    for (const turn of turns) {
      line('You', turn.prompt);
      if (turn.state === 'completed') {
        const label = turn.model && (turn.requestedModel && turn.requestedModel !== turn.model
          ? turn.model + ' (requested ' + turn.requestedModel + ')' : turn.model.replace(/^gemini\//,''));
        line(sourceName(turn.model), turn.reply, label);
      }
      if (turn.state === 'working') {
        const text = streamRequest === turn.request ? preview : '';
        const live = line(sourceName(turn.requestedModel), text);
        live.id = 'live-reply';
        live.hidden = !text;
      }
      if (turn.error) line('Workspace', turn.error);
    }
    working = turns.at(-1)?.state === 'working';
    $('messages').replaceChildren(...messages);
    $('older-turns').hidden = !next;
    $('chat-status').textContent = working ? sourceName(turns.at(-1).requestedModel) + ' is replying…' : '';
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
        const latestTurn = incoming.at(-1);
        const currentModel = !older && latestTurn?.state === 'working' ? latestTurn.requestedModel || page.model : page.model;
        if (!historyReady || (!older && storedModel !== currentModel)) {
          storedModel = currentModel;
          historyReady = true;
          renderPicker();
        }
        $('chat-heading').textContent = page.title;
        if (changed || followReply) renderTurns(older);
        const latest = working && [...rows.values()].find((row) => row.state === 'working');
        watchReply(latest?.request);
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
    if ($('chat-send').disabled) return;
    if (!retry || retry.prompt !== prompt) retry = { prompt, model: picker.value, request: crypto.randomUUID() };
    generation++;
    busyRead = false;
    sending = true;
    controls();
    $('chat-status').textContent = 'Sending…';
    try {
      const result = await api(selected ? '/' + selected : '', retry);
      const same = selected === result.id;
      drafts.delete(selected);
      choices.delete(selected);
      storedModel = retry.model;
      followReply = true;
      selected = result.id;
      localStorage.setItem(key, selected);
      if (!same) rows.clear();
      retry = undefined;
      input.value = '';
      sizeInput();
      working = true;
      $('chat-status').textContent = sourceName(storedModel) + ' is replying…';
    } catch (err) {
      if (err.status >= 400 && err.status < 500) retry = undefined;
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
    if (!document.hidden && source?.readyState !== EventSource.OPEN) await refresh();
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    timer = window.setTimeout(poll, working ? 1400 : 8000);
  }
  schedule();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) closeStream();
    else void refresh();
  });
  window.addEventListener('pagehide', () => {
    clearTimeout(timer);
    closeStream();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) { void refresh(); schedule(); }
  });
}
