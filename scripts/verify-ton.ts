/**
 * TON testnet verifier (`npm run verify:ton`). Proves, live:
 *  1. The app's TON test wallet address and its balance read through toncenter testnet
 *  2. The optional read-only mainnet balance of TON_MAINNET_WATCH_ADDRESS (SKIPPED when unset)
 *  3. Wallet signals from that live read, and a TON money request on the lens within its limits
 *  4. When the test wallet is funded: one real testnet TON payout to the test requester through the
 *     lens tap path, with its transaction hash and Telegram receipts. Unfunded: SKIPPED with the
 *     address that needs test coins, never PASS.
 *  5. A request over the per-request cap is refused before anything is sent
 *
 * Needs VERIFY_TON_RECIPIENT (the test requester's TON testnet address) for step 4.
 * Writes proof JSON with no secrets to PROOF_OUT when set.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  formatTon,
  parseTonAmount,
  renderLensPage,
  tonRequestSignal,
  validateLensLayout,
  type LensViewState,
  type TonPayoutView,
  type TonRequestView,
  type TonRequesterView,
} from '@chainvision/shared';
import { loadConfig } from '../packages/server/src/config.js';
import { parseTonAddress, testnetFriendly } from '../packages/server/src/ton/address.js';
import { Toncenter } from '../packages/server/src/ton/toncenter.js';
import type { TonPaid, TonRequestDesk } from '../packages/server/src/ton/requests.js';
import { TON_FEE_RESERVE_NANO, readTonBalance } from '../packages/server/src/ton/wallet.js';
import { ChainVisionEngine } from '../packages/server/src/watcher/engine.js';

interface CheckResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIPPED';
  latencyMs: number;
  details: Record<string, unknown>;
}

async function runCheck(
  name: string,
  fn: () => Promise<{ status?: 'PASS' | 'SKIPPED'; details: Record<string, unknown> }>,
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

function makeDesk(params: {
  request: TonRequestView;
  requester: TonRequesterView;
  notify: (text: string) => Promise<number | null>;
}): TonRequestDesk & { payouts: TonPayoutView[]; requesterMessageId: number | null } {
  const { request, requester } = params;
  const desk = {
    requesters: [requester],
    payouts: [] as TonPayoutView[],
    requesterMessageId: null as number | null,
    request: (id: string) => (id === request.id ? request : null),
    requester: (id: string) => (id === requester.telegramUserId ? requester : null),
    async settle(paid: TonPaid) {
      request.status = 'paid';
      desk.payouts.push({ amount: paid.request.amount, currency: 'TON', at: Date.now() });
      desk.requesterMessageId = await params.notify(paid.requesterText);
    },
    async failed() {
      request.status = 'failed';
    },
  };
  return desk;
}

async function main() {
  const startedAt = Date.now();
  const config = loadConfig();
  const engine = new ChainVisionEngine(config);
  const wallet = engine.tonWallet;
  const results: CheckResult[] = [];
  const amountTon = Number(process.env.VERIFY_TON_AMOUNT || 0.05);
  const recipient = process.env.VERIFY_TON_RECIPIENT ?? '';

  let address = '';
  let balanceNano: bigint | null = null;

  results.push(
    await runCheck('ton:test-wallet-address', async () => {
      address = await wallet.friendlyAddress();
      return { details: { address, raw: (await wallet.address()).toRawString(), version: 'v4r2', network: 'ton-testnet' } };
    }),
  );

  results.push(
    await runCheck('read:ton-testnet-balance', async () => {
      const snap = await engine.pollTon();
      if (snap.error || snap.balanceNano === null) throw new Error(snap.error ?? 'no balance');
      balanceNano = BigInt(snap.balanceNano);
      const signals = engine.queue.ranked(Date.now()).filter((s) => s.source === 'ton');
      return {
        details: {
          endpoint: wallet.api.baseUrl,
          address: snap.address,
          balanceTon: formatTon(snap.balanceNano),
          accountState: snap.state,
          recentIncoming: snap.incoming.slice(0, 3).map((t) => ({ hash: t.hash, amountTon: formatTon(t.amountNano), from: t.from, at: new Date(t.at).toISOString() })),
          tonSignalsOnQueue: signals.map((s) => s.line),
        },
      };
    }),
  );

  results.push(
    await runCheck('read:ton-mainnet-readonly', async () => {
      if (!config.tonMainnetWatchAddress) {
        return { status: 'SKIPPED', details: { reason: 'TON_MAINNET_WATCH_ADDRESS is not set' } };
      }
      const nano = await readTonBalance(new Toncenter('mainnet', config.toncenterApiKey), config.tonMainnetWatchAddress);
      return { details: { address: config.tonMainnetWatchAddress, balanceTon: formatTon(nano), readOnly: true } };
    }),
  );

  const recipientParsed = parseTonAddress(recipient);
  const now = Date.now();
  const request: TonRequestView = { id: `rq_verify${now.toString(16).slice(-6)}`, requesterId: 'verify-kit', amount: amountTon, currency: 'TON', status: 'open', createdAt: now, expiresAt: now + 5 * 60_000 };
  const requester: TonRequesterView = {
    telegramUserId: 'verify-kit',
    name: 'KIT',
    status: 'approved',
    tonAddress: recipientParsed ? testnetFriendly(recipientParsed.address) : null,
  };

  results.push(
    await runCheck('lens:ton-request', async () => {
      const signal = tonRequestSignal(request, { ...requester, tonAddress: requester.tonAddress ?? address }, 'act_verify', Date.now());
      const out = lens({ mode: 'signal', paired: true, signal });
      if (out.errors.length) throw new Error(out.errors.join('; '));
      return { details: { lensLine: out.text, chars: out.chars } };
    }),
  );

  results.push(
    await runCheck('safety:ton-over-cap-refused', async () => {
      const over: TonRequestView = { ...request, id: 'rq_overcap', amount: engine.getSession().thresholds.maxRequestTon + 1 };
      const desk = makeDesk({ request: over, requester: { ...requester, tonAddress: requester.tonAddress ?? address }, notify: async () => null });
      engine.tonRequests = desk;
      const signal = tonRequestSignal(over, { ...requester, tonAddress: requester.tonAddress ?? address }, 'act_overcap', Date.now());
      const refused = await engine.executeAction(signal.action!).then(
        () => null,
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      engine.tonRequests = null;
      if (!refused || over.status !== 'open') throw new Error('An over-cap TON request was not refused');
      return { details: { amountTon: over.amount, refused } };
    }),
  );

  results.push(
    await runCheck('tx:ton-testnet-request-payout', async () => {
      if (!recipientParsed) {
        return { status: 'SKIPPED', details: { reason: 'VERIFY_TON_RECIPIENT is not a TON address' } };
      }
      const amountNano = parseTonAmount(amountTon);
      if (amountNano === null) throw new Error('VERIFY_TON_AMOUNT is not a TON amount');
      if (balanceNano === null || balanceNano < amountNano + TON_FEE_RESERVE_NANO) {
        return {
          status: 'SKIPPED',
          details: {
            reason: 'Test wallet is not funded',
            addressNeedingTestCoins: address,
            balanceTon: balanceNano === null ? null : formatTon(balanceNano),
            neededTon: formatTon(amountNano + TON_FEE_RESERVE_NANO),
            faucet: '@testgiver_ton_bot in Telegram',
          },
        };
      }
      const chatId = engine.getSession().telegramChatId;
      const desk = makeDesk({
        request,
        requester,
        notify: async (text) => (chatId && engine.telegram.isConfigured ? (await engine.telegram.sendMessage(chatId, text)).message_id : null),
      });
      engine.tonRequests = desk;
      let wearerMessageId: number | null = null;
      const sendReceipt = engine.telegram.sendReceipt.bind(engine.telegram);
      engine.telegram.sendReceipt = async (receipt, chat) => {
        const res = await sendReceipt(receipt, chat);
        wearerMessageId = res.messageId ?? null;
        return res;
      };
      const signal = tonRequestSignal(request, { ...requester, tonAddress: requester.tonAddress as string }, 'act_verify_pay', Date.now());
      engine.queue.upsert(signal);
      engine.tick();
      const before = lens(engine.getLensState());
      const top = engine.getLensState().signal;
      if (top?.id !== signal.id) throw new Error(`The request is not the top line on the lens (top: ${top?.line ?? 'blank'})`);
      const receipt = await engine.confirmPendingAction(top.action!.id);
      return {
        details: {
          lensBeforeTap: before.text,
          txHash: receipt.txHashOrOrderId,
          explorerUrl: receipt.explorerUrl,
          from: address,
          to: requester.tonAddress,
          amountTon: formatTon(amountNano),
          before: receipt.beforeFact,
          after: receipt.afterFact,
          requestStatus: request.status,
          telegram: { wearerReceiptMessageId: wearerMessageId, requesterReceiptMessageId: desk.requesterMessageId, requesterChat: 'stand-in: the wearer chat (test requester has no Telegram account)' },
        },
      };
    }),
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
  for (const r of results) console.log(`[${r.status}] ${r.name} (${r.latencyMs}ms) ${JSON.stringify(r.details)}`);
  console.log(`\nSummary: ${summary.passed} PASS, ${summary.skipped} SKIPPED, ${summary.failed} FAIL in ${(totalMs / 1000).toFixed(1)}s`);
  const outPath = process.env.PROOF_OUT;
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
    console.log(`Proof written to ${outPath}`);
  }
  engine.stop();
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[verify:ton] Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
