/**
 * Demo-order simulator run (`npm run sim:demo`): the whole phase 2 story on the built glasses app in
 * the official Even Hub simulator against a live backend, one screenshot per step:
 * blank lens; an exchange line if live data raises one; a Hyperliquid position trim by voice; a
 * Telegram request in USDC shown and paid; a request in TON shown (paid only when the TON test
 * wallet is funded, otherwise declined with a swipe); the "what matters?" brief; a voice alert set
 * and fired; a voice order card with two venues' prices; blank again.
 *
 * Needs `npm run build` first and the backend's usual env (CHAINVISION_ENV_FILE /
 * CHAINVISION_SECRETS_FILE). VERIFY_REQUESTER_ADDRESS (Sepolia) and VERIFY_TON_RECIPIENT (TON testnet)
 * are the test requester's addresses; the requester uses the owner's own Telegram chat. Optional:
 * SIM_OUT (default ./sim-out), SIM_AUTOMATION_PORT (default 19900), SIM_AID (microphone id).
 * Real testnet effects: a reduce-only Hyperliquid trim and a 20 USDC Sepolia payout.
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
const notes = {};

async function waitMode(modes, seconds) {
  for (let i = 0; i < seconds; i++) {
    const mode = (await api('GET', '/api/state')).state.mode;
    if (modes.includes(mode)) return mode;
    await sleep(1000);
  }
  return (await api('GET', '/api/state')).state.mode;
}

async function toBlank() {
  for (let i = 0; i < 4 && (await api('GET', '/api/state')).state.mode !== 'idle'; i++) await input('down');
  return waitMode(['idle'], 15);
}

// 1. Nothing matters: the lens is blank.
await api('POST', '/api/thresholds', QUIET);
await api('POST', '/api/sync');
await shot('demo-01-blank', 'thresholds set so no watcher raises a signal');

// 2. An exchange line, only if live data raises one.
const exchangeSignals = (await api('GET', '/api/signals')).signals.filter((s) => ['exchange', 'bybit', 'binance'].includes(s.source));
if (exchangeSignals.length) {
  await shot('demo-02-exchange-line', exchangeSignals[0].line);
} else {
  notes.exchangeLine = {
    shown: false,
    reason: 'No exchange signal in live data: every exchange line (margin, liquidation distance, open orders, fills) comes from a signed account read, so without Bybit or Binance testnet keys public prices alone raise nothing.',
  };
}

// 3. A Hyperliquid position trim, by voice: card, then a tap sends a reduce-only trim.
const trim = await api('POST', '/api/voice/text', { transcript: 'trim half my ETH perp' });
await shot('demo-03-trim-card', trim.pendingAction ? trim.pendingAction.headline : 'no trim card');
let trimReceipt = null;
if (trim.pendingAction) {
  await input('click');
  const mode = await waitMode(['result', 'error'], 60);
  trimReceipt = (await api('GET', '/api/state')).state.lastReceipt;
  await shot('demo-04-trim-done', mode === 'result' ? trimReceipt?.summary : 'trim failed');
}
await toBlank();

// 4. Telegram money requests: USDC shown and paid; TON shown, paid only if the TON wallet is funded.
const chatId = (await api('GET', '/api/state')).session.telegramChatId;
const tg = (text) =>
  api('POST', '/api/dev/telegram-update', {
    update_id: Date.now(),
    message: { message_id: 1, chat: { id: Number(chatId), type: 'private' }, from: { id: Number(chatId), first_name: 'Kit' }, text },
  });
const requests = { usdc: null, ton: null };
const sepoliaRequester = process.env.VERIFY_REQUESTER_ADDRESS;
if (sepoliaRequester && chatId) {
  const register = await tg(`/register ${sepoliaRequester} Kit`);
  await api('POST', '/api/requesters/approve', { telegramUserId: String(chatId) });
  const ask = await tg('/ask 20 USDC');
  await shot('demo-05-usdc-request', 'Telegram /ask 20 USDC from an approved requester');
  await input('click');
  const mode = await waitMode(['result', 'error'], 90);
  await shot('demo-06-usdc-paid', mode === 'result' ? 'tap paid 20 testnet USDC on Sepolia' : 'payment failed');
  requests.usdc = { replies: { register: register.messageIds, ask: ask.messageIds }, receipt: (await api('GET', '/api/state')).state.lastReceipt };
  await toBlank();
} else {
  notes.usdcRequest = 'VERIFY_REQUESTER_ADDRESS or the paired Telegram chat is not set';
}
const tonRequester = process.env.VERIFY_TON_RECIPIENT;
if (tonRequester && chatId) {
  const register = await tg(`/register ${tonRequester} Kit`);
  await api('POST', '/api/requesters/approve', { telegramUserId: String(chatId) });
  const ton = await api('GET', '/api/ton');
  const ask = await tg('/ask 0.05 TON');
  await shot('demo-07-ton-request', `Telegram /ask 0.05 TON; test wallet holds ${ton.testWallet?.balanceNano ?? '?'} nanotons`);
  const funded = BigInt(ton.testWallet?.balanceNano ?? '0') >= 100_000_000n;
  if (funded) {
    await input('click');
    const mode = await waitMode(['result', 'error'], 120);
    await shot('demo-08-ton-paid', mode === 'result' ? 'tap paid 0.05 testnet TON' : 'TON payment failed');
  } else {
    await input('down');
    await sleep(1500);
    await shot('demo-08-ton-declined', `not paid: the TON test wallet ${ton.testWallet?.address} is unfunded, so the request was declined with a swipe`);
  }
  const book = await api('GET', '/api/requesters');
  requests.ton = {
    funded,
    wallet: ton.testWallet?.address,
    replies: { register: register.messageIds, ask: ask.messageIds },
    request: book.requests.filter((r) => r.currency === 'TON').map((r) => ({ amount: r.amount, status: r.status, via: r.resolvedVia, txHash: r.txHash })),
  };
  await toBlank();
} else {
  notes.tonRequest = 'VERIFY_TON_RECIPIENT or the paired Telegram chat is not set';
}

// 5. "What matters?" by voice: up to three ranked lines, read-only, then blank.
const brief = await api('POST', '/api/voice/text', { transcript: 'What matters?' });
await shot('demo-09-brief', `intent via ${brief.parse?.provider}`);
await toBlank();

// 6. Alert set by voice a hair from the live price; a twin on the other side makes it fire whichever way the price moves.
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
await shot('demo-10-alert-set', transcript);
const twin = await api('POST', '/api/alerts', { asset: 'ETH', direction: 'below', price: Number((eth - step).toFixed(2)) });
let fired = null;
for (let i = 0; i < 100 && !fired; i++) {
  await sleep(3000);
  await api('POST', '/api/sync');
  fired = (await api('GET', '/api/signals')).signals.find((s) => s.source === 'price_alert') ?? null;
}
if (!fired) throw new Error('No alert fired within 300 s');
await waitMode(['signal'], 15);
await shot('demo-11-alert-fired', fired.line);
for (const r of (await api('GET', '/api/alerts')).rules) await api('POST', '/api/alerts/remove', { id: r.id });
await input('click');
await toBlank();

// 7. A voice order card with two venues' prices: a Uniswap Sepolia swap card carrying the Hyperliquid
// testnet and Bybit testnet marks. Swipe down cancels it; nothing is sent.
const order = await api('POST', '/api/voice/text', { transcript: 'swap 0.005 ETH to USDC' });
await shot('demo-12-order-card', order.pendingAction ? `${order.pendingAction.headline} | ${order.pendingAction.comparisonLine}` : 'no order card');
const binance = await api('POST', '/api/voice/text', { transcript: 'buy 0.001 BTC at 57000' });
notes.binanceLimitCard = binance.pendingAction
  ? { shown: true, comparisonLine: binance.pendingAction.comparisonLine }
  : { shown: false, reason: (await api('GET', '/api/state')).state.errorMessage ?? 'refused' };
await toBlank();

// 8. Blank again.
await sleep(2000);
await shot('demo-13-blank-again', 'nothing left that matters');

const consoleDump = await fetch(`${SIM}/api/console`).then((r) => r.json());
const report = {
  timestamp: new Date().toISOString(),
  steps,
  notes,
  trim: { intent: trim.parse?.intent ?? null, receipt: trimReceipt },
  requests,
  brief: { intent: brief.parse?.intent ?? null },
  alert: { transcript, intent: voiced.parse?.intent ?? null, stored: voiced.alert ?? null, twin, fired: fired.line },
  order: { intent: order.parse?.intent ?? null, card: order.pendingAction ?? null },
  consoleErrors: (consoleDump.entries || []).filter((e) => e.level === 'error'),
};
fs.writeFileSync(path.join(OUT_DIR, 'sim-demo-report.json'), JSON.stringify(report, null, 2));
console.log(`SIM_DEMO_REPORT ${path.join(OUT_DIR, 'sim-demo-report.json')}`);
staticSrv.close();
cleanup();
process.exit(0);
