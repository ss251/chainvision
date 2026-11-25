/**
 * Exchange verifier (`npm run verify:exchanges`).
 * Public steps always run live: Bybit testnet, Binance spot testnet and Coinbase market data, a confirm
 * card carrying two venues' prices, the intent model on the exchange phrases, and the exchange signals.
 * Signed steps run only with keys in the secrets file and are reported SKIPPED with the reason otherwise:
 * a Bybit Funding-to-Trading transfer, a Bybit reduce-only trim, a Binance testnet limit order and its cancel,
 * each through the voice card and tap path with its Telegram receipt.
 *
 * Writes proof JSON with no secrets to PROOF_OUT when set.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  EXCHANGE_CAPS,
  renderLensPage,
  signalLensLine,
  validateLensLayout,
  type ExecutionReceipt,
  type LensViewState,
} from '@chainvision/shared';
import { loadConfig } from '../packages/server/src/config.js';
import { binanceLimitDraft } from '../packages/server/src/exchanges/desk.js';
import { VoiceIntentService } from '../packages/server/src/voice/openrouter.js';
import { ChainVisionEngine } from '../packages/server/src/watcher/engine.js';

type Status = 'PASS' | 'FAIL' | 'SKIPPED';
interface CheckResult {
  name: string;
  status: Status;
  latencyMs: number;
  details: Record<string, unknown>;
}

async function runCheck(
  name: string,
  fn: () => Promise<{ status?: Status; details: Record<string, unknown> }>,
): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const res = await fn();
    return { name, status: res.status ?? 'PASS', latencyMs: Date.now() - t0, details: res.details };
  } catch (err) {
    return { name, status: 'FAIL', latencyMs: Date.now() - t0, details: { error: err instanceof Error ? err.message : String(err) } };
  }
}

function lens(state: LensViewState): { text: string; chars: number; errors: string[] } {
  const layout = renderLensPage(state);
  return { text: layout.textObject.map((c) => c.content).join(' | '), chars: layout.totalChars, errors: validateLensLayout(layout).errors };
}

async function main() {
  const startedAt = Date.now();
  const config = loadConfig();
  const engine = new ChainVisionEngine(config, {
    stateFile: config.stateFile ?? path.resolve(import.meta.dirname, '../.chainvision/state.json'),
  });
  const desk = engine.desk;
  const results: CheckResult[] = [];
  const telegramMessages: Record<string, number | undefined> = {};
  const sendReceipt = engine.telegram.sendReceipt.bind(engine.telegram);
  engine.telegram.sendReceipt = async (receipt: ExecutionReceipt, chatId?: string | null) => {
    const out = await sendReceipt(receipt, chatId);
    telegramMessages[receipt.id] = out.messageId;
    return out;
  };

  results.push(
    await runCheck('public:bybit-testnet', async () => {
      const [serverTime, marks, instrument] = await Promise.all([
        desk.bybit.serverTime(),
        desk.bybit.readMarks(),
        desk.bybit.instrument('BTCUSDT'),
      ]);
      if (!marks.BTC) throw new Error('No BTCUSDT mark price');
      return { details: { host: 'api-testnet.bybit.com', serverTime, marks, instrument } };
    }),
  );
  results.push(
    await runCheck('public:binance-spot-testnet', async () => {
      const [serverTime, prices, filters] = await Promise.all([
        desk.binance.serverTime(),
        desk.binance.readPrices(),
        desk.binanceFilters('BTCUSDT'),
      ]);
      if (!prices.BTC) throw new Error('No BTCUSDT price');
      return { details: { host: 'testnet.binance.vision', serverTime, prices, filters } };
    }),
  );
  results.push(
    await runCheck('public:coinbase-read-only', async () => {
      const snap = await desk.coinbase.readSnapshot();
      if (snap.error || !snap.prices.BTC) throw new Error(snap.error ?? 'No BTC-USD price');
      return { details: { host: 'api.exchange.coinbase.com', prices: snap.prices } };
    }),
  );

  const snap = await desk.readSnapshot();
  results.push(
    await runCheck('public:two-venue-confirm-card', async () => {
      const market = snap.binance.prices.BTC;
      if (!market) throw new Error('No Binance testnet BTC price');
      const res = binanceLimitDraft({
        side: 'buy',
        asset: 'BTC',
        qty: 0.001,
        price: Math.floor(market * 0.97),
        filters: await desk.binanceFilters('BTCUSDT'),
        marketPrice: market,
        coinbasePrice: snap.coinbase.prices.BTC,
        balances: null,
        allowanceUsd: EXCHANGE_CAPS.binance_limit.perAction,
      });
      if (!('draft' in res)) throw new Error(res.refusal);
      const now = Date.now();
      const card = lens({
        mode: 'confirm',
        paired: true,
        pendingAction: { ...res.draft, id: 'act_verify', source: 'voice', createdAt: now, expiresAt: now + 90_000, requiresTap: true },
      });
      if (card.errors.length) throw new Error(card.errors.join('; '));
      return { details: { note: 'card built from live public data; not sent to any exchange', lens: card.text, chars: card.chars } };
    }),
  );

  results.push(
    await runCheck('voice:intent-model-exchange-phrases', async () => {
      const intents = new VoiceIntentService(config);
      const market = Math.floor((snap.binance.prices.BTC ?? 60000) * 0.97);
      const phrases: Array<[string, string[]]> = [
        ['move 500 to trading', ['exchange_transfer']],
        ['close half my BTC position', ['hl_trim', 'exchange_trim']],
        ['buy 0.001 BTC at ' + market + ' on Binance', ['exchange_limit']],
        ['cancel my Binance orders', ['exchange_cancel']],
      ];
      const parsed = [];
      for (const [phrase, expected] of phrases) {
        const out = await intents.parseTranscript(phrase);
        parsed.push({ phrase, intent: out.intent, provider: out.provider, model: out.model, ok: expected.includes(out.intent.action) });
      }
      const bad = parsed.filter((p) => !p.ok);
      if (bad.length) throw new Error('Unexpected intents: ' + JSON.stringify(bad));
      const viaModel = parsed.every((p) => p.provider === 'openrouter');
      return { status: viaModel ? 'PASS' : 'SKIPPED', details: { parsed, ...(viaModel ? {} : { reason: 'OPENROUTER_API_KEY not configured or unreachable; local rules parsed' }) } };
    }),
  );

  results.push(
    await runCheck('queue:exchange-signals-live', async () => {
      const specs = desk.signalSpecs(snap, engine.getSession().thresholds);
      return {
        details: {
          bybitSigned: snap.bybit.signed,
          binanceSigned: snap.binance.signed,
          signals: specs.map((s) => ({ id: s.base.id, line: signalLensLine({ line: s.base.line, action: s.action as never }) })),
          note: specs.length ? 'signals raised from live testnet accounts' : 'no exchange signal: the lens stays blank',
        },
      };
    }),
  );

  const skip = (reason: string) => async () => ({ status: 'SKIPPED' as Status, details: { reason } });
  const bybitMissing = 'BYBIT_TESTNET_API_KEY / BYBIT_TESTNET_API_SECRET not in the secrets file';
  const binanceMissing = 'BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET not in the secrets file';

  /** Voice -> confirm card -> tap -> receipt, exactly as the glasses drive it. */
  const voiceTap = async (phrase: string) => {
    await engine.pollNow();
    const out = await engine.handleVoiceTranscript(phrase);
    if (!out.pendingAction) {
      throw new Error('No confirm card for "' + phrase + '": ' + (engine.getLensState().errorMessage ?? out.parse.intent.action));
    }
    const card = lens(engine.getLensState());
    const receipt = await engine.confirmPendingAction(out.pendingAction.id);
    return {
      phrase,
      intent: out.parse.intent,
      intentProvider: out.parse.provider,
      card: card.text,
      cardErrors: card.errors,
      receipt: {
        id: receipt.id,
        summary: receipt.summary,
        network: receipt.network,
        before: receipt.beforeFact,
        after: receipt.afterFact,
        exchangeId: receipt.txHashOrOrderId,
        telegramPosted: receipt.telegramPosted,
        telegramMessageId: telegramMessages[receipt.id] ?? null,
      },
      result: lens(engine.getLensState()).text,
    };
  };

  results.push(
    await runCheck(
      'signed:bybit-account',
      desk.bybit.hasKey
        ? async () => ({ details: { account: await desk.bybit.readAccount(), positions: await desk.bybit.readPositions() } })
        : skip(bybitMissing),
    ),
  );
  const transferUsdt = Number(process.env.VERIFY_BYBIT_TRANSFER_USDT || 10);
  results.push(
    await runCheck(
      'signed:bybit-transfer-funding-to-trading',
      desk.bybit.hasKey ? async () => ({ details: await voiceTap('move ' + transferUsdt + ' to trading') }) : skip(bybitMissing),
    ),
  );
  results.push(
    await runCheck(
      'signed:bybit-reduce-only-trim',
      desk.bybit.hasKey
        ? async () => {
            const pos = (await desk.bybit.readPositions()).find((p) => p.symbol === 'BTCUSDT');
            if (!pos) return { status: 'SKIPPED' as Status, details: { reason: 'No open Bybit testnet BTCUSDT position; run npm run setup:bybit first' } };
            return { details: await voiceTap('close half my Bybit BTC position') };
          }
        : skip(bybitMissing),
    ),
  );
  results.push(
    await runCheck(
      'signed:binance-account',
      desk.binance.hasKey
        ? async () => ({ details: { balances: await desk.binance.readBalances(), openOrders: await desk.binance.readOpenOrders() } })
        : skip(binanceMissing),
    ),
  );
  results.push(
    await runCheck(
      'signed:binance-limit-order',
      desk.binance.hasKey
        ? async () => {
            const market = (await desk.binance.readPrices()).BTC ?? 0;
            return { details: await voiceTap('buy 0.001 BTC at ' + Math.floor(market * 0.97) + ' on Binance') };
          }
        : skip(binanceMissing),
    ),
  );
  results.push(
    await runCheck(
      'signed:binance-cancel-open-orders',
      desk.binance.hasKey ? async () => ({ details: await voiceTap('cancel my open BTC orders on Binance') }) : skip(binanceMissing),
    ),
  );

  const totalMs = Date.now() - startedAt;
  const summary = {
    timestamp: new Date().toISOString(),
    totalMs,
    passed: results.filter((r) => r.status === 'PASS').length,
    skipped: results.filter((r) => r.status === 'SKIPPED').length,
    failed: results.filter((r) => r.status === 'FAIL').length,
    results,
  };
  for (const r of results) console.log('[' + r.status + '] ' + r.name + ' (' + r.latencyMs + 'ms) ' + JSON.stringify(r.details));
  console.log('\nSummary: ' + summary.passed + ' PASS, ' + summary.skipped + ' SKIPPED, ' + summary.failed + ' FAIL in ' + (totalMs / 1000).toFixed(1) + 's');
  const outPath = process.env.PROOF_OUT;
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
    console.log('Proof written to ' + outPath);
  }
  engine.stop();
  if (summary.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[verify:exchanges] Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
