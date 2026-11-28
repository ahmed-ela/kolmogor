import { openChats } from './chat.js';

const $ = (selector) => document.querySelector(selector);
const names = { codex: 'Codex CLI', claude: 'Claude Code', antigravity: 'Antigravity CLI', chrome: 'Chrome' };
let renderedProviders;
let active,
  display,
  timer,
  queue,
  pending,
  loading = false;
async function api(path, method = 'GET', form) {
  const r = await fetch(path, { method, body: form ? new URLSearchParams(form) : undefined });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || 'Request failed.');
  return data;
}
function report(err) {
  $('#status').textContent = err.message;
}
async function busy(button, action) {
  button.disabled = true;
  try {
    await action();
  } catch (err) {
    report(err);
  } finally {
    button.disabled = false;
  }
}
function closeDisplay() {
  const current = display;
  display = null;
  current?.();
  $('#viewer').hidden = true;
}
function clearStep() {
  closeDisplay();
  active = null;
  pending = false;
  $('#instructions').hidden = true;
  $('#instructions input').value = '';
  $('#authorize').removeAttribute('href');
}
async function start(provider) {
  if (active !== provider) clearStep();
  active = provider;
  $('#instructions').hidden = false;
  $('#instructions h2').textContent = names[provider];
  $('#instructions p').textContent = 'Opening this connection…';
  $('#skip').hidden = !queue;
  $('#instructions form').hidden = true;
  $('#authorize').hidden = true;
  const data = await api('/api/connections/' + provider + '/start', 'POST');
  if (active !== provider) return;
  if (data.connected) {
    clearStep();
    return;
  }
  if (provider === 'chrome') {
    $('#instructions p').textContent =
      'Sign in to Google in your workspace browser. Your session stays on this workspace.';
    $('#viewer').hidden = false;
    const { view } = await import('/display.js');
    if (active !== provider) return;
    closeDisplay();
    $('#viewer').hidden = false;
    display = view($('#screen'), data.password, () => {
      $('#viewer').hidden = true;
    });
    return;
  }
  $('#instructions p').textContent = data.message;
  const link = $('#authorize');
  link.hidden = !data.url;
  if (data.url) link.href = data.url;
  $('#instructions form').hidden = !(data.acceptsCode && data.url);
  pending = !data.url;
}
async function next(states) {
  clearStep();
  let provider;
  while (queue?.length && !provider) {
    const candidate = queue.shift();
    if (states[candidate] !== 'connected') provider = candidate;
  }
  if (provider) {
    await start(provider);
    return;
  }
  queue = null;
  $('#status').textContent = Object.keys(names).every((p) => states[p] === 'connected')
    ? 'All accounts are connected.'
    : 'Connection setup finished. You can connect the remaining accounts individually.';
}
function renderProviders(providers) {
  const signature = JSON.stringify(Object.keys(names).map((key) => providers[key]));
  if (signature === renderedProviders) return;
  const rows = [];
  for (const [provider, name] of Object.entries(names)) {
    const row = document.createElement('li'),
      label = document.createElement('span'),
      sub = document.createElement('small'),
      button = document.createElement('button');
    const status = providers[provider];
    label.textContent = name;
    sub.textContent =
      status === 'connected'
        ? 'Connected'
        : status === 'ready'
          ? 'Private browser ready'
          : status === 'pending'
            ? 'Sign-in in progress'
            : 'Available to connect';
    button.textContent =
      provider === 'chrome'
        ? 'Open browser'
        : status === 'connected'
          ? 'Check connection'
          : status === 'pending'
            ? 'Continue'
            : 'Connect';
    button.onclick = () =>
      busy(button, async () => {
        queue = null;
        if (provider !== 'chrome' && status === 'connected') await refresh();
        else await start(provider);
      });
    label.append(sub);
    row.append(label, button);
    rows.push(row);
  }
  $('#providers').replaceChildren(...rows);
  renderedProviders = signature;
}
async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const state = await api('/api/connections');
    if (!state.ready) {
      $('#provider-health').textContent = 'Preparing your private workspace…';
      await api('/api/workspace', 'POST');
      return;
    }
    $('#provider-health').textContent = '';
    renderProviders(state.providers);
    if (queue && (!active || state.providers[active] === 'connected')) await next(state.providers);
    else if (active && state.providers[active] === 'connected' && active !== 'chrome') clearStep();
    else if (active && pending) await start(active);
  } finally {
    loading = false;
  }
}
function checkConnections() {
  if (!document.hidden && !$('#connections').hidden)
    refresh().catch((err) => { $('#provider-health').textContent = err.message; });
}
function showSection(chats) {
  $('#chats').hidden = !chats;
  $('#connections').hidden = chats;
  for (const [button, current] of [[$('#nav-chats'), chats], [$('#nav-connections'), !chats]]) {
    if (current) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  $(chats ? '#chat-heading' : '#connections-title').focus({ preventScroll: true });
  if (!chats) checkConnections();
}
$('#nav-chats').onclick = () => showSection(true);
$('#nav-connections').onclick = () => showSection(false);

// WebKit can resize only the visual viewport when the software keyboard opens.
function fitWindow() {
  const viewport = window.visualViewport;
  if (!viewport || viewport.scale !== 1) return;
  const style = document.documentElement.style;
  if (viewport.height + 1 < window.innerHeight)
    style.setProperty('--visible-height', viewport.height + 'px');
  else style.removeProperty('--visible-height');
}
window.visualViewport?.addEventListener('resize', fitWindow);
fitWindow();
$('#close-view').onclick = closeDisplay;
$('#skip').onclick = () =>
  busy($('#skip'), async () => {
    const state = await api('/api/connections');
    await next(state.providers);
  });
$('#instructions form').onsubmit = async (e) => {
  e.preventDefault();
  const field = $('#instructions input');
  await busy($('#instructions form button'), async () => {
    await api('/api/connections/' + active + '/code', 'POST', { code: field.value });
    field.value = '';
    $('#instructions form').hidden = true;
    $('#instructions p').textContent = 'Checking the provider connection…';
    await refresh();
  });
};
$('#logout').onclick = () =>
  busy($('#logout'), async () => {
    await api('/auth/logout', 'POST');
    closeDisplay();
    location.replace('/');
  });
$('#connect').onclick = () =>
  busy($('#connect'), async () => {
    clearStep();
    queue = Object.keys(names);
    $('#status').textContent = 'Checking your connections…';
    await api('/api/workspace', 'POST');
    await refresh();
  });
try {
  const me = await api('/api/me');
  $('#identity').textContent = me.email ?? '';
  $('#entry-status').textContent = 'Sign in to see your chats and connections.';
  $('#entry').hidden = !!me.email;
  $('#login').hidden = !!me.email;
  $('#workspace').hidden = !me.email;
  $('#logout').hidden = !me.email;
  if (me.email) {
    openChats(me.email);
    timer = setInterval(checkConnections, 5000);
    await api('/api/workspace', 'POST');
  }
} catch (err) {
  if ($('#workspace').hidden) $('#entry-status').textContent = err.message;
  else report(err);
}
window.addEventListener('pagehide', () => {
  clearInterval(timer);
  closeDisplay();
});
