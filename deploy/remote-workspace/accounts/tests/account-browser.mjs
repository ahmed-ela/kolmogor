// Runs against a disposable account database. No provider credentials or external network required.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { Duplex } from 'node:stream';
import { chromium } from 'playwright-core';
import { workspaceAccount } from '../browser-account.cjs';
import { Accounts } from '../identity.mjs';
import { accountServer } from '../server.mjs';

const reservation = net.createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const origin = 'http://127.0.0.1:' + port;
const accounts = new Accounts(':memory:');
const providers = { codex: 'disconnected', claude: 'disconnected', antigravity: 'disconnected', chrome: 'ready' };
const starts = [];
const firstChunk = Promise.withResolvers();
const lastChunk = Promise.withResolvers();
let sendCount = 0, push;

const server = accountServer({
  origin,
  accounts,
  google: {
    url: ({ state }) => origin + '/oauth/callback?code=fixture&state=' + state,
    verify: async (_, tx) => ({
      sub: 'fixture',
      email: 'owner@example.invalid',
      email_verified: true,
      nonce: tx.nonce,
    }),
  },
  broker: {
    async call(_workspace, action, provider, code) {
      if (action === 'chat-models') return {models:[
        {id:'fixture-a', name:'Fixture A', isDefault:true}, {id:'fixture-b', name:'Fixture B', isDefault:false}
      ]};
      if (action === 'ensure') return { ready: true };
      if (action === 'status') return { ready: true, providers };
      if (action === 'code') {
        assert.ok(['claude', 'antigravity'].includes(provider));
        assert.equal(code, 'fixture-' + provider);
        providers[provider] = 'connected';
        return { submitted: true };
      }
      starts.push(provider);
      if (provider === 'chrome') return { password: 'fixture' };
      providers[provider] = 'pending';
      return {
        url:
          provider === 'codex'
            ? 'https://auth.openai.com/codex/device'
            : provider === 'claude' ? 'https://claude.ai/oauth/authorize?fixture' : 'https://accounts.google.com/o/oauth2/auth?fixture',
        acceptsCode: provider !== 'codex',
        message: 'Approve the synthetic connection.',
      };
    },
    async chat(_owner,{thread,prompt,model}, onDelta) {
      const session = '10000000-0000-4000-8000-000000000003';
      if (prompt === 'A streamed fixture') {
        sendCount++;
        push = onDelta;
        onDelta('First part');
        firstChunk.resolve();
        await lastChunk.promise;
        return {status:'completed',thread:session,model,reply:'First part and final.'};
      }
      if (prompt === 'A long layout fixture')
        return { status:'completed', thread:session, model, reply:'A readable paragraph on a narrow screen. '.repeat(240) };
      if (thread) assert.equal(thread,session);
      assert.equal(prompt,thread ? 'Recall it' : 'Remember the fixture');
      assert.equal(model,thread ? 'fixture-b' : 'fixture-a');
      return {status:'completed',thread:session,model,reply:thread ? 'I remember' : 'Stored'};
    },
    async display() {
      return new Duplex({
        read() {},
        write(_, __, done) {
          done();
        },
      });
    },
  },
});
server.listen(port, '127.0.0.1');
await once(server, 'listening');
const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let browser;
try {
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_BIN || (process.platform === 'darwin' ? macChrome : '/usr/bin/google-chrome'),
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width:390, height:720 }, isMobile:true, hasTouch:true });
  async function fits(target) {
    const bounds = await target.boundingBox();
    assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44, '44px touch target');
    const view = await page.evaluate(() => ({ w:document.documentElement.clientWidth,
      h:window.visualViewport.height, scroll:document.documentElement.scrollWidth }));
    assert.ok(view.scroll <= view.w, 'No horizontal page scrolling');
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= view.w + 1 &&
      bounds.y >= -1 && bounds.y + bounds.height <= view.h + 1, JSON.stringify({target:await target.getAttribute('id'),bounds,view}));
  }
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin === origin) await route.continue();
    else await route.abort();
  });
  await page.goto(origin);
  await page.getByRole('link', { name: 'Sign in with Google' }).click();
  const chats = page.getByRole('button',{name:'Chats',exact:true});
  const connections = page.getByRole('button',{name:'Connections',exact:true});
  const newChat = page.getByRole('button',{name:'New chat'});
  const input = page.getByLabel('Message Codex');
  const back = page.getByRole('button',{name:'All chats'});
  const send = page.getByRole('button',{name:'Send',exact:true});
  await page.getByRole('heading',{name:'No chats yet'}).waitFor();
  for (const width of [320,390,1024]) {
    await page.setViewportSize({width,height:700});
    for (const target of [newChat, chats, connections]) await fits(target);
  }
  await page.setViewportSize({width:390,height:720});
  await newChat.click();
  await input.fill('Unsent draft');
  await back.click();
  await connections.click();
  await page.getByText('owner@example.invalid', { exact:true }).waitFor();
  assert.equal(await connections.getAttribute('aria-current'),'page');
  await chats.click();
  await newChat.click();
  assert.equal(await input.inputValue(),'Unsent draft');
  assert.equal(await input.evaluate(el=>el===document.activeElement),true);
  await back.click();
  await page.getByRole('button',{name:'New chat'}).click();
  await page.getByLabel('Message Codex').fill('Remember the fixture');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await page.getByText('Stored',{exact:true}).waitFor();
  const other = await browser.newPage();
  await other.goto(origin);
  await other.getByRole('link',{name:'Sign in with Google'}).click();
  await other.getByRole('button',{name:'Remember the fixture'}).click();
  await other.getByRole('combobox',{name:'Codex model'}).selectOption('fixture-b');
  await other.getByLabel('Message Codex').fill('Recall it');
  await other.getByRole('button',{name:'Send',exact:true}).click();
  await other.getByText('I remember',{exact:true}).waitFor();
  await page.reload();
  await page.getByText('I remember',{exact:true}).waitFor();
  await page.getByText('Stored',{exact:true}).waitFor();
  await page.waitForFunction(() => document.querySelector('#chat-model').value === 'fixture-b');
  assert.deepEqual(await page.locator('.agent-message strong').allTextContents(),['fixture-a','fixture-b']);
  await page.getByRole('button',{name:'All chats'}).click();
  await page.getByRole('button',{name:'Remember the fixture'}).waitFor();
  assert.equal(await page.locator('#chat-list button').count(),1);
  await other.close();
  await newChat.click();
  await input.fill('A streamed fixture');
  await send.click();
  await firstChunk.promise;
  const partial = page.locator('#live-reply div');
  await partial.filter({hasText:/^First part$/}).waitFor();
  assert.equal(await page.getByRole('status').filter({hasText:'Codex is replying'}).count(),1);
  await page.reload();
  await partial.filter({hasText:/^First part$/}).waitFor();
  push(' and final.');
  await partial.filter({hasText:/^First part and final\.$/}).waitFor();
  lastChunk.resolve();
  await page.locator('.agent-message:not(#live-reply) div').filter({hasText:/^First part and final\.$/}).waitFor();
  assert.equal(sendCount,1);
  await back.click();
  console.log('Verified a real SSE preview before completion, reload and snapshot, a new delta and exactly one final reply.');
  console.log('Verified fresh workspace, two independent signed-in clients, both turns on one chat and reload.');
  await newChat.click();
  await input.fill('A long layout fixture');
  await send.click();
  await page.locator('.agent-message').waitFor();
  await page.emulateMedia({colorScheme:'dark'});
  for (const viewport of [{width:320,height:360},{width:740,height:290},{width:1024,height:720}]) {
    await page.setViewportSize(viewport);
    await fits(back);
    await fits(page.getByLabel('Codex model'));
    await fits(send);
    const transcript = page.locator('#conversation');
    await transcript.evaluate(el=>{ el.scrollTop=0; });
    assert.ok(await transcript.evaluate(el=>el.scrollHeight>el.clientHeight));
    await fits(send);
    assert.equal(await connections.isVisible(),false);
  }
  await page.setViewportSize({width:390,height:720});
  await page.emulateMedia({colorScheme:'light'});
  await back.click();
  await connections.click();
  console.log('Verified phone, landscape and desktop layouts, persistent composer, navigation and draft.');
  await page.getByRole('button', { name: 'Connect all accounts' }).click();
  await page.getByRole('heading', { name: 'Codex CLI' }).waitFor();
  assert.equal(
    await page.getByRole('link', { name: 'Open sign-in page' }).getAttribute('href'),
    'https://auth.openai.com/codex/device'
  );
  await page.getByRole('button', { name: 'Skip this account' }).click();
  await page.getByLabel('Authorization code').fill('fixture-claude');
  await page.getByRole('button', { name: 'Submit code' }).click();
  await page.getByRole('heading', { name: 'Antigravity CLI' }).waitFor();
  await page.getByRole('link', { name: 'Open sign-in page' }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Open sign-in page' }).getAttribute('href'), 'https://accounts.google.com/o/oauth2/auth?fixture');
  await page.getByLabel('Authorization code').fill('fixture-antigravity');
  await page.getByRole('button', { name: 'Submit code' }).click();
  await page.getByRole('heading', { name: 'Workspace Chrome' }).waitFor();
  await page.locator('#screen canvas').waitFor({ state: 'attached' });
  assert.deepEqual(starts, ['codex', 'claude', 'antigravity', 'chrome']);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('link', { name: 'Sign in with Google' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Connect all accounts' }).isVisible(), false);
  console.log(
    'Verified Google entry, all four guided connection steps, manual code, browser viewer, and sign-out with a disposable account.'
  );

  const remoteChrome = await browser.newContext();
  await remoteChrome.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<main>Fixture</main>' }));
  const unrelated = await remoteChrome.newPage();
  await unrelated.goto('https://example.invalid/user-work');
  const landing = await remoteChrome.newPage();
  await landing.goto('https://www.google.com/account/about/');
  assert.equal(await workspaceAccount(remoteChrome, 'status'), false);
  assert.equal(await workspaceAccount(remoteChrome, 'start'), false);
  const login = new URL(landing.url());
  assert.equal(login.origin, 'https://accounts.google.com');
  assert.equal(login.searchParams.get('continue'), 'https://myaccount.google.com/');
  const challenge = new URL('/challenge/fixture', login.origin);
  challenge.search = login.search;
  await landing.goto(challenge.href);
  assert.equal(await workspaceAccount(remoteChrome, 'start'), false);
  assert.equal(landing.url(), challenge.href);
  assert.equal(remoteChrome.pages().length, 2);
  assert.equal(unrelated.url(), 'https://example.invalid/user-work');
  await landing.goto('https://myaccount.google.com/');
  assert.equal(await workspaceAccount(remoteChrome, 'status'), false);
  await landing.setContent('<button aria-label="Google Account: fixture">Account</button>');
  assert.equal(await workspaceAccount(remoteChrome, 'status'), true);
  await remoteChrome.close();
  console.log('Verified that Chrome reuses the Google tab, preserves an active challenge, and checks the signed-in account menu.');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  accounts.db.close();
}
