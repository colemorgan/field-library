// UI glue: Web Bluetooth link + RelaySession + allowlist persistence.

import { bluetoothAvailable, bluetoothSupport, connectReader } from './ble.js';
import { DEFAULT_ALLOWLIST, RelaySession, displayPath, normalizeOrigin } from './relay.js';

const STORAGE_KEY = 'fieldSync.allowedServers.v1';
const MAX_LOG_ROWS = 100;

const $ = (id) => document.getElementById(id);
const els = {
  support: $('support'),
  sync: $('sync'),
  stop: $('stop'),
  status: $('status'),
  blocked: $('blocked'),
  blockedOrigin: $('blocked-origin'),
  allowBlocked: $('allow-blocked'),
  log: $('log'),
  logEmpty: $('log-empty'),
  servers: $('servers'),
  addServer: $('add-server'),
  serverInput: $('server-input'),
  serverError: $('server-error'),
  resetServers: $('reset-servers'),
};

// ---- allowlist (persisted) ------------------------------------------------

function loadAllowlist() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(stored)) {
      const list = stored.map(normalizeOrigin).filter(Boolean);
      return [...new Set(list)];
    }
  } catch {
    /* fall back to defaults */
  }
  return [...DEFAULT_ALLOWLIST];
}

let allowlist = loadAllowlist();

function saveAllowlist(list) {
  allowlist = [...new Set(list)];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(allowlist));
  } catch {
    /* private mode: keep in memory */
  }
  renderServers();
}

function renderServers() {
  els.servers.replaceChildren(
    ...allowlist.map((origin) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = origin;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'secondary small';
      btn.textContent = 'Remove';
      btn.setAttribute('aria-label', `Remove ${origin}`);
      btn.addEventListener('click', () => saveAllowlist(allowlist.filter((o) => o !== origin)));
      li.append(span, btn);
      return li;
    }),
  );
}

els.addServer.addEventListener('submit', (e) => {
  e.preventDefault();
  const origin = normalizeOrigin(els.serverInput.value);
  if (!origin) {
    els.serverError.textContent = 'Enter an https:// address, e.g. https://sync.example.com';
    els.serverError.hidden = false;
    return;
  }
  els.serverError.hidden = true;
  els.serverInput.value = '';
  saveAllowlist([...allowlist, origin]);
});

els.resetServers.addEventListener('click', () => saveAllowlist([...DEFAULT_ALLOWLIST]));

// ---- status and log -------------------------------------------------------

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = `status ${kind}`.trim();
}

function addLogRow(kind, text, detail = '') {
  const li = document.createElement('li');
  li.className = kind;
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const main = document.createElement('span');
  main.className = 'main';
  main.textContent = text;
  li.append(time, main);
  if (detail) {
    const d = document.createElement('span');
    d.className = 'detail';
    d.textContent = detail;
    li.append(d);
  }
  els.log.prepend(li);
  while (els.log.children.length > MAX_LOG_ROWS) els.log.lastElementChild.remove();
  els.logEmpty.hidden = true;
}

const ERROR_TEXT = {
  network: 'network error',
  timeout: 'timed out',
  origin_not_allowed: 'server not allowed',
  bad_request: 'refused (bad request)',
  too_large: 'response too large',
};

function onSessionEvent(ev) {
  switch (ev.type) {
    case 'hello':
      setStatus(`Connected to ${ev.device || 'reader'}${ev.fw ? ` (${ev.fw})` : ''}. Syncing…`, 'busy');
      addLogRow('info', `Reader uses ${ev.origin ?? ev.baseUrl}`);
      break;
    case 'blocked':
      els.blockedOrigin.textContent = ev.origin;
      els.allowBlocked.dataset.origin = ev.origin;
      els.allowBlocked.hidden = !normalizeOrigin(ev.origin);
      els.blocked.hidden = false;
      setStatus('Reader uses a server that is not allowed.', 'error');
      break;
    case 'request': {
      const ok = ev.status >= 200 && ev.status < 300;
      const outcome = ev.status === 0 ? ERROR_TEXT[ev.error] ?? ev.error : String(ev.status);
      addLogRow(ok ? 'ok' : 'bad', `${ev.method} ${displayPath(ev.path)}`, `${outcome} · ${ev.ms} ms`);
      if (ev.error === 'network') {
        addLogRow(
          'warn',
          'Could not reach the server.',
          'Check mobile data. A custom server must allow CORS from this page (including the x-auth-user/x-auth-key headers).',
        );
      }
      break;
    }
    case 'log':
      addLogRow(ev.level, ev.text);
      break;
    case 'end':
      break;
  }
}

// ---- sync -----------------------------------------------------------------

let session = null;

async function sync() {
  if (session) return;
  els.blocked.hidden = true;
  els.sync.disabled = true;
  setStatus('Choose your reader (FieldSync-…) in the list.', 'busy');
  let link;
  try {
    link = await connectReader({ onStatus: (t) => setStatus(t, 'busy') });
  } catch (err) {
    els.sync.disabled = false;
    if (err?.name === 'NotFoundError') {
      setStatus('No reader chosen. Start Sync Progress on the reader, then try again.');
    } else {
      setStatus(`Could not connect: ${err?.message ?? err}`, 'error');
      addLogRow('error', 'Connection failed', String(err?.message ?? err));
    }
    return;
  }
  setStatus(`Connected to ${link.name}. Waiting for the reader…`, 'busy');
  addLogRow('info', `Connected to ${link.name}`);
  els.stop.hidden = false;
  session = new RelaySession({
    link,
    fetch: (...args) => fetch(...args),
    getAllowlist: () => allowlist,
    mtu: link.mtu,
    onEvent: onSessionEvent,
  });
  const { reason } = await session.run();
  session = null;
  els.stop.hidden = true;
  els.sync.disabled = false;
  if (reason === 'done') setStatus('Sync finished. You can close this page.', 'ok');
  else if (reason === 'cancelled') setStatus('Stopped.');
  else setStatus(`Session ended: ${reason}.`, 'error');
  addLogRow('info', `Session ended (${reason})`);
}

els.sync.addEventListener('click', () => {
  sync().catch((err) => setStatus(`Error: ${err?.message ?? err}`, 'error'));
});
els.stop.addEventListener('click', () => session?.cancel('cancelled'));
els.allowBlocked.addEventListener('click', () => {
  const origin = normalizeOrigin(els.allowBlocked.dataset.origin);
  if (!origin) return;
  if (!confirm(`Allow syncing with ${origin}? Your reader's sync login will be sent there.`)) return;
  saveAllowlist([...allowlist, origin]);
  els.blocked.hidden = true;
  setStatus(session ? 'Server allowed. Retry the sync on the reader if it failed.' : 'Server allowed. Sync again.');
});

// ---- startup --------------------------------------------------------------

async function init() {
  renderServers();
  const problem = bluetoothSupport();
  if (problem) {
    els.support.hidden = false;
    els.support.textContent =
      problem === 'insecure'
        ? 'This page must be opened over HTTPS (or from localhost) to use Bluetooth.'
        : 'This browser cannot use Bluetooth from web pages. Use Chrome on Android, or the Bluefy browser on iPhone/iPad.';
    els.support.dataset.reason = problem;
    setStatus('Bluetooth not available in this browser.', 'error');
    return;
  }
  if (!(await bluetoothAvailable())) {
    els.support.hidden = false;
    els.support.dataset.reason = 'no-adapter';
    els.support.textContent = 'Bluetooth looks turned off or missing. Turn it on, then reload this page.';
    setStatus('Bluetooth is off.', 'error');
    els.sync.disabled = false; // let the user try anyway; availability can be wrong
    return;
  }
  els.sync.disabled = false;
  setStatus('Ready.');
}

init();
