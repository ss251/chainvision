/**
 * Simulator end-to-end run (`npm run sim:e2e`): drives the built glasses app in the official
 * Even Hub simulator against a live backend and saves a screenshot per step.
 *
 * Needs: `npm run build` first, and the backend's usual env (CHAINVISION_ENV_FILE /
 * CHAINVISION_SECRETS_FILE). Optional: SIM_OUT (screenshot folder, default ./sim-out),
 * SIM_AUTOMATION_PORT (default 19900), SIM_AID (microphone id for the simulator),
 * VERIFY_REQUESTER_ADDRESS (a Sepolia address; when set, a Telegram money request is paid for real
 * after the lens tap and a second one is declined with a swipe; the requester uses the owner's chat).
 * The glasses build talks to http://127.0.0.1:8787, so the backend is started on 8787.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.resolve(process.env.SIM_OUT ?? path.join(REPO, 'sim-out'));
const SIM_PORT = Number(process.env.SIM_AUTOMATION_PORT ?? 19900);
const STATIC_PORT = 15173;
const API = 'http://127.0.0.1:8787';
const SIM = `http://127.0.0.1:${SIM_PORT}`;
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

function cleanup() {
  for (const c of children) c.kill('SIGTERM');
}
process.on('exit', cleanup);

const glassesDist = path.join(REPO, 'packages/glasses/dist');
if (!fs.existsSync(path.join(glassesDist, 'index.html'))) throw new Error('Run npm run build first');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css' };
const staticSrv = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${STATIC_PORT}`);
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const p = path.join(glassesDist, rel);
  if (p.startsWith(glassesDist) && fs.existsSync(p) && fs.statSync(p).isFile()) {
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => staticSrv.listen(STATIC_PORT, '127.0.0.1', r));

const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chainvision-sim-')), 'state.json');
const backend = spawn('npx', ['tsx', 'packages/server/src/index.ts'], {
  cwd: REPO,
  env: { ...process.env, SERVER_PORT: '8787', CHAINVISION_STATE_FILE: stateFile, CHAINVISION_DEV_TELEGRAM_UPDATES: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(backend);
backend.stderr.on('data', (d) => process.stderr.write(`[srv-err] ${d}`));

async function waitUrl(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

async function api(method, route, body) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

if (!(await waitUrl(`${API}/api/health`))) throw new Error('Backend failed to start');

const simArgs = ['-y', '@evenrealities/evenhub-simulator@0.9.5', `http://127.0.0.1:${STATIC_PORT}`, '--automation-port', String(SIM_PORT)];
if (process.env.SIM_AID) simArgs.push('--aid', process.env.SIM_AID);
const sim = spawn('npx', simArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
children.push(sim);
if (!(await waitUrl(`${SIM}/api/ping`))) throw new Error('Simulator failed to start');
await sleep(2500);

const steps = [];
async function shot(name, note) {
  await sleep(1200);
  const buf = Buffer.from(await fetch(`${SIM}/api/screenshot/glasses`).then((r) => r.arrayBuffer()));
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, buf);
  const { state } = await api('GET', '/api/state');
  const step = {
    name,
    note,
    screenshot: file,
    mode: state.mode,
    signal: state.signal ? { id: state.signal.id, line: state.signal.line, action: state.signal.action?.actionPrompt ?? null } : null,
    briefLines: state.briefLines ?? null,
    noticeText: state.noticeText ?? null,
    queueSize: state.queueSize,
  };
  steps.push(step);
  console.log(`SHOT ${name}: mode=${state.mode} ${step.signal ? step.signal.line : ''}`);
  return step;
}

async function input(action) {
  const r = await fetch(`${SIM}/api/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  await sleep(800);
  return r.status;
}

const QUIET = { aaveMinHealthFactor: 1.05, hlMinLiqDistancePct: 1, exchangeMinLiqDistancePct: 1, uniswapAlertOutOfRange: false };

// 1. Nothing in the queue: the lens is blank.
await api('POST', '/api/thresholds', QUIET);
await api('POST', '/api/sync');
await shot('p2-01-empty-queue-blank', 'thresholds set so no watcher raises a signal');

// 2. Alert set by voice a hair from the live price; a twin on the other side makes it fire whichever way the price moves.
let eth;
for (let i = 0; i < 5 && !eth; i++) {
  eth = (await api('GET', '/api/state')).state.snapshots?.hyperliquid?.markPrices?.ETH;
  if (!eth) {
    await sleep(3000);
    await api('POST', '/api/sync');
  }
}
if (!eth) throw new Error('No live ETH testnet mark price');
const step = Math.max(0.01, Number((eth * 0.0002).toFixed(2)));
const transcript = `tell me if ETH goes above ${(eth + step).toFixed(2)}`;
const voiced = await api('POST', '/api/voice/text', { transcript });
await shot('p2-02-alert-set', transcript);
const twin = await api('POST', '/api/alerts', { asset: 'ETH', direction: 'below', price: Number((eth - step).toFixed(2)) });
let fired = null;
for (let i = 0; i < 100 && !fired; i++) {
  await sleep(3000);
  await api('POST', '/api/sync');
  fired = (await api('GET', '/api/signals')).signals.find((s) => s.source === 'price_alert') ?? null;
}
if (!fired) throw new Error('No alert fired within 300 s');
await shot('p2-03-alert-fired', fired.line);
for (const r of (await api('GET', '/api/alerts')).rules) await api('POST', '/api/alerts/remove', { id: r.id });

// 3. A real Aave signal (demo threshold above the live health factor) outranks the alert; only the top line shows.
await api('POST', '/api/thresholds', { aaveMinHealthFactor: 1.6 });
await api('POST', '/api/sync');
const ranked = (await api('GET', '/api/signals')).signals.map((s) => ({ id: s.id, severity: s.severity, line: s.line }));
await shot('p2-04-top-signal', 'Aave health against a 1.60 demo threshold, price alert queued behind it');

// 4. Swipe down: the top signal is dismissed and the next one shows.
await input('down');
await shot('p2-05-swipe-next-signal', 'swipe down dismissed the Aave line');

// 5. Untouched for about 10 s: the line blanks itself.
await sleep(11_000);
await shot('p2-06-auto-blank', 'no touch for 11 s');

// 6. "What matters?" by voice: up to three ranked lines, read-only, then blank again.
const brief = await api('POST', '/api/voice/text', { transcript: 'What matters?' });
await shot('p2-07-brief', `intent via ${brief.parse?.provider}`);
await sleep(10_500);
await shot('p2-08-brief-blanked', 'brief blanked itself');

// 7. Aave back under its threshold leaves the queue; after the rest period only the alert, which still matters, returns.
await api('POST', '/api/thresholds', QUIET);
await api('POST', '/api/sync');
let returned = false;
for (let i = 0; i < 80 && !returned; i++) {
  await sleep(1000);
  returned = (await api('GET', '/api/state')).state.mode === 'signal';
}
if (!returned) throw new Error('Alert line did not return after the rest period');
await shot('p2-09-alert-returns', 'after the 60 s rest the still-live alert returns');

// 8. A tap on a line with no action clears it; the queue is empty again, so the lens is blank.
await input('click');
await shot('p2-10-tap-cleared-blank', 'tap cleared the alert line');

// 9. Money requests through Telegram, approved on the lens (real Sepolia transfer).
let requests = null;
const requesterAddress = process.env.VERIFY_REQUESTER_ADDRESS;
const chatId = (await api('GET', '/api/state')).session.telegramChatId;
if (requesterAddress && chatId) {
  const tg = (text) =>
    api('POST', '/api/dev/telegram-update', {
      update_id: Date.now(),
      message: { message_id: 1, chat: { id: Number(chatId), type: 'private' }, from: { id: Number(chatId), first_name: 'Kit' }, text },
    });
  const register = await tg(`/register ${requesterAddress} Kit`);
  await api('POST', '/api/requesters/approve', { telegramUserId: String(chatId) });
  const ask = await tg('/ask 20 USDC');
  await shot('p2-11-request-on-lens', 'Telegram /ask 20 USDC from an approved requester');
  await input('click');
  let paid = false;
  for (let i = 0; i < 90 && !paid; i++) {
    await sleep(1000);
    paid = (await api('GET', '/api/state')).state.mode === 'result';
  }
  await shot('p2-12-request-paid', 'tap paid 20 testnet USDC on Sepolia');
  await input('down');
  const ask2 = await tg('/ask 5 USDC');
  await shot('p2-13-second-request', 'second request');
  await input('down');
  await sleep(1500);
  await shot('p2-14-request-declined-blank', 'swipe down declined it');
  const book = await api('GET', '/api/requesters');
  requests = {
    telegramReplyIds: { register: register.messageIds, ask: ask.messageIds, ask2: ask2.messageIds },
    requests: book.requests.map((r) => ({
      amount: r.amount,
      status: r.status,
      via: r.resolvedVia,
      txHash: r.txHash,
      messages: r.messages,
    })),
    lastReceipt: (await api('GET', '/api/state')).state.lastReceipt,
  };
}

const consoleDump = await fetch(`${SIM}/api/console`).then((r) => r.json());
const report = {
  timestamp: new Date().toISOString(),
  rankedAtStep2: ranked,
  briefIntent: brief.parse?.intent ?? null,
  alert: { transcript, intent: voiced.parse?.intent ?? null, stored: voiced.alert ?? null, twin, fired: fired.line },
  steps,
  requests,
  consoleErrors: (consoleDump.entries || []).filter((e) => e.level === 'error'),
};
fs.writeFileSync(path.join(OUT_DIR, 'sim-e2e-report.json'), JSON.stringify(report, null, 2));
console.log(`SIM_E2E_REPORT ${path.join(OUT_DIR, 'sim-e2e-report.json')}`);
staticSrv.close();
cleanup();
process.exit(0);
