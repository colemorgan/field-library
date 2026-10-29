// Dev-only smoke check: serve the app on localhost, open it in headless Chromium, fail on any
// console error / page error / failed request, and check the "no Bluetooth" message appears
// (headless Chromium has no Bluetooth adapter).
//
// Needs Playwright, which is NOT a dependency of this app. Point PLAYWRIGHT_MODULE at an installed
// copy (e.g. a global install), or run:  pnpm dlx playwright install chromium  and
// PLAYWRIGHT_MODULE=$(pnpm root -g)/playwright node scripts/browser-check.mjs
// Usage: node scripts/browser-check.mjs [screenshotDir]   (default /tmp)
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { startServer } from '../serve.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const outDir = process.argv[2] ?? '/tmp';

const server = await startServer(0);
const url = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch();
const problems = [];
try {
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 360, height: 760 }, colorScheme: scheme, deviceScaleFactor: 2 });
    page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
    page.on('response', (r) => r.status() >= 400 && problems.push(`HTTP ${r.status()}: ${r.url()}`));
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.getElementById('status').textContent !== 'Loading…');
    const support = page.locator('#support');
    const visible = await support.isVisible();
    const text = visible ? await support.textContent() : '';
    const reason = await support.getAttribute('data-reason');
    const hasBluetooth = await page.evaluate(() => 'bluetooth' in navigator);
    console.log(`[${scheme}] navigator.bluetooth present: ${hasBluetooth}; support notice: ${visible ? `${reason}: ${text}` : 'hidden'}`);
    console.log(`[${scheme}] status: ${await page.locator('#status').textContent()}`);
    console.log(`[${scheme}] allowed servers: ${(await page.locator('#servers li span').allTextContents()).join(', ')}`);
    if (!visible) problems.push('no-Bluetooth notice not shown');
    const shot = join(outDir, `field-sync-${scheme}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`[${scheme}] screenshot: ${shot}`);
    await page.close();
  }

  // Simulated session: fake navigator.bluetooth + fake reader speaking real framing; sync-server
  // requests are intercepted by Playwright (nothing leaves the machine).
  const page = await browser.newPage({ viewport: { width: 360, height: 760 }, deviceScaleFactor: 2 });
  page.on('console', (m) => m.type() === 'error' && problems.push(`sim console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`sim pageerror: ${e.message}`));
  const relayed = [];
  await page.route('https://sync.crosspointreader.com/**', (route) => {
    const r = route.request();
    relayed.push(`${r.method()} ${new URL(r.url()).pathname}`);
    if (r.headers()['x-auth-key'] !== 'test-key') problems.push('sim: auth header not forwarded');
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"document":"d","percentage":0.5}' });
  });
  await page.addInitScript(() => {
    const listeners = {};
    let notifyCb = null;
    let p;
    const reader = async () => {
      p ??= await import('/protocol.js');
      return p;
    };
    let dec;
    let ids = 50;
    const sendToPhone = async (msg) => {
      const { encodeFrames } = await reader();
      for (const c of encodeFrames(JSON.stringify(msg), ids++ & 255, { mtu: 23 })) {
        await new Promise((r) => setTimeout(r, 1));
        notifyCb?.({ target: { value: new DataView(c.buffer) } });
      }
    };
    const script = [
      { t: 'hello', v: 1, device: 'CrossPoint', fw: 'sim', baseUrl: 'https://sync.crosspointreader.com' },
      { t: 'req', id: 1, method: 'GET', path: '/syncs/progress/0123456789abcdef0123456789abcdef?position_kinds=x', headers: { 'x-auth-user': 'u', 'x-auth-key': 'test-key' }, body: null },
      { t: 'req', id: 2, method: 'PUT', path: '/syncs/progress', headers: { 'x-auth-user': 'u', 'x-auth-key': 'test-key', 'Content-Type': 'application/json' }, body: '{"document":"d"}' },
      { t: 'req', id: 3, method: 'GET', path: '/../etc', headers: {}, body: null },
      { t: 'bye', reason: 'done' },
    ];
    // After each phone message, send script items up to and including the next req.
    const onPhoneMessage = async () => {
      while (script.length) {
        const next = script.shift();
        await sendToPhone(next);
        if (next.t === 'req') break;
      }
    };
    const rx = {
      async writeValueWithResponse(chunk) {
        const { FrameDecoder } = await reader();
        dec ??= new FrameDecoder();
        const r = dec.push(new Uint8Array(chunk));
        if (r?.ok) setTimeout(onPhoneMessage, 1);
      },
    };
    const tx = {
      addEventListener: (t, cb) => (notifyCb = cb),
      removeEventListener: () => (notifyCb = null),
      startNotifications: async () => {},
      stopNotifications: async () => {},
    };
    const device = {
      name: 'FieldSync-SIM1',
      addEventListener: (t, cb) => (listeners[t] = cb),
      removeEventListener: () => {},
      gatt: {
        connected: false,
        async connect() {
          this.connected = true;
          return { getPrimaryService: async () => ({ getCharacteristic: async (u) => (u.endsWith('0002-5a1e-4c8b-9f3e-2b7c1a0e5d10') ? rx : tx) }) };
        },
        disconnect() {
          this.connected = false;
        },
      },
    };
    Object.defineProperty(navigator, 'bluetooth', {
      value: { requestDevice: async () => device, getAvailability: async () => true },
    });
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.click('#sync');
  await page
    .waitForFunction(() => /finished|ended/i.test(document.getElementById('status').textContent), null, { timeout: 15000 })
    .catch(() => problems.push('sim: session did not finish'));
  const status = await page.locator('#status').textContent();
  const rows = await page.locator('#log li').allInnerTexts();
  console.log(`[sim] status: ${status}`);
  console.log(`[sim] log:\n  ${rows.map((r) => r.replace(/\s+/g, ' ')).join('\n  ')}`);
  console.log(`[sim] intercepted: ${relayed.join(', ')}`);
  if (!/finished/i.test(status)) problems.push(`sim: unexpected status ${status}`);
  if (relayed.length !== 2) problems.push(`sim: expected 2 relayed requests, got ${relayed.length}`);
  if (rows.join(' ').includes('test-key')) problems.push('sim: credential appeared in log');
  const shot = join(outDir, 'field-sync-session.png');
  await page.screenshot({ path: shot, fullPage: true });
  console.log(`[sim] screenshot: ${shot}`);
} finally {
  await browser.close();
  server.close();
}
if (problems.length) {
  console.error('FAIL\n' + problems.join('\n'));
  process.exit(1);
}
console.log('OK: no console errors, no-Bluetooth notice shown, simulated session relayed');
