import { Address, Cell, loadMessage, loadMessageRelaxed } from '@ton/core';
import { mnemonicNew } from '@ton/crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BRIEF_EMPTY_TEXT,
  SIGNAL_LENS_LINE_MAX,
  TON_INCOMING_WINDOW_MS,
  checkTonAsk,
  checkTonPayout,
  formatTon,
  formatTonShort,
  parseTonAmount,
  parseTonAsk,
  rankSignals,
  renderLensPage,
  signalLensLine,
  tonPaidInLastDay,
  tonReadOnlyBriefLine,
  tonRequestSignal,
  tonWalletSignals,
  validateLensLayout,
  type LensViewState,
  type Signal,
  type TonRequestView,
  type TonRequesterView,
  type TonWalletSnapshot,
} from '@chainvision/shared';
import { loadConfig } from '../packages/server/src/config.js';
import { SafetyPolicyError } from '../packages/server/src/safety/policy.js';
import { assertAllowedTonPayout } from '../packages/server/src/safety/ton.js';
import { parseTonAddress, testnetFriendly, tonAddressKey } from '../packages/server/src/ton/address.js';
import { TonRequestRail, approvedTonAddressKeys, type TonRequestDesk } from '../packages/server/src/ton/requests.js';
import { TONCENTER_MAINNET_URL, TONCENTER_TESTNET_URL, Toncenter, tonHashToHex } from '../packages/server/src/ton/toncenter.js';
import { TonTestnetWallet, incomingTransfers } from '../packages/server/src/ton/wallet.js';
import { ChainVisionEngine } from '../packages/server/src/watcher/engine.js';

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const HASH_A = 'ab'.repeat(32);
const RAW_KIT = `0:${'1f'.repeat(32)}`;
const RAW_OTHER = `0:${'2e'.repeat(32)}`;
const KIT = Address.parseRaw(RAW_KIT);
const KIT_TESTNET = testnetFriendly(KIT);

function lensOk(state: LensViewState) {
  const layout = renderLensPage(state);
  expect(validateLensLayout(layout).errors).toEqual([]);
  return layout;
}

function kit(overrides: Partial<TonRequesterView> = {}): TonRequesterView {
  return { telegramUserId: '42', name: 'KIT', status: 'approved', tonAddress: KIT_TESTNET, ...overrides };
}

function tonRequest(overrides: Partial<TonRequestView> = {}): TonRequestView {
  return { id: 'rq_0a0b0c0d', requesterId: '42', amount: 2, currency: 'TON', status: 'open', createdAt: NOW, expiresAt: NOW + 5 * 60_000, ...overrides };
}

describe('TON addresses', () => {
  it('reads every user-friendly form and the raw form of one account as the same key', () => {
    const forms = [
      KIT.toString({ testOnly: true, bounceable: false }),
      KIT.toString({ testOnly: true, bounceable: true }),
      KIT.toString({ testOnly: false, bounceable: true }),
      KIT.toString({ testOnly: false, bounceable: false, urlSafe: false }),
      RAW_KIT,
    ];
    for (const f of forms) expect(tonAddressKey(f)).toBe(RAW_KIT);
    expect(tonAddressKey(RAW_OTHER)).not.toBe(RAW_KIT);
  });

  it('keeps the bounce flag the owner wrote, and sends a raw address non-bounceable', () => {
    expect(parseTonAddress(KIT.toString({ testOnly: true, bounceable: true }))?.bounceable).toBe(true);
    expect(parseTonAddress(KIT.toString({ testOnly: true, bounceable: false }))?.bounceable).toBe(false);
    expect(parseTonAddress(RAW_KIT)?.bounceable).toBe(false);
    expect(KIT_TESTNET.startsWith('0Q')).toBe(true);
  });

  it('rejects a broken checksum, an Ethereum address and junk', () => {
    const friendly = KIT.toString({ testOnly: true, bounceable: false });
    const tampered = friendly.slice(0, -1) + (friendly.endsWith('A') ? 'B' : 'A');
    expect(parseTonAddress(tampered)).toBeNull();
    expect(parseTonAddress('0x537B1ED6f937C1A27e7C6249026732565B381fB0')).toBeNull();
    expect(parseTonAddress('')).toBeNull();
    expect(parseTonAddress('0:1234')).toBeNull();
  });
});

describe('TON amounts in nanotons', () => {
  it('parses decimal TON exactly, with at most 9 decimals', () => {
    expect(parseTonAmount('2')).toBe(2_000_000_000n);
    expect(parseTonAmount('0.5')).toBe(500_000_000n);
    expect(parseTonAmount('1.000000001')).toBe(1_000_000_001n);
    expect(parseTonAmount('0.1')).toBe(100_000_000n);
    expect(parseTonAmount(0.3)).toBe(300_000_000n);
    expect(parseTonAmount('1.0000000001')).toBeNull();
    expect(parseTonAmount('0')).toBeNull();
    expect(parseTonAmount('-1')).toBeNull();
    expect(parseTonAmount('1e9')).toBeNull();
    expect(parseTonAmount(Number.NaN)).toBeNull();
  });

  it('formats nanotons without floating point and rounds short forms down', () => {
    expect(formatTon(2_000_000_000n)).toBe('2');
    expect(formatTon('1500000000')).toBe('1.5');
    expect(formatTon(1n)).toBe('0.000000001');
    expect(formatTonShort('1999999999')).toBe('1.99');
    expect(formatTonShort('2000000000')).toBe('2');
  });

  it('reads "/ask 2 TON" and never reads a USDC or unit-less ask as TON', () => {
    expect(parseTonAsk('/ask 2 TON')).toBe(2);
    expect(parseTonAsk('/ask@chainvision_bot 0.5 ton')).toBe(0.5);
    expect(parseTonAsk('/ask 1.25 gram')).toBe(1.25);
    expect(parseTonAsk('/ask 2')).toBeNull();
    expect(parseTonAsk('/ask 20 USDC')).toBeNull();
    expect(parseTonAsk('/ask 0.0000000001 TON')).toBeNull();
    expect(parseTonAsk('/ask 0 TON')).toBeNull();
  });
});

describe('TON request caps', () => {
  const caps = { perRequestTon: 2, dailyTon: 5 };

  it('allows a known, approved requester with a TON address within the caps', () => {
    expect(checkTonAsk({ requester: kit(), amount: 2, openRequestIds: [], payouts: [], caps, now: NOW })).toEqual({ ok: true });
  });

  it('refuses unknown, unapproved, address-less, busy and over-cap requests', () => {
    const base = { amount: 1, openRequestIds: [] as string[], payouts: [], caps, now: NOW };
    expect(checkTonAsk({ ...base, requester: null }).ok).toBe(false);
    expect(checkTonAsk({ ...base, requester: kit({ status: 'pending' }) }).ok).toBe(false);
    expect(checkTonAsk({ ...base, requester: kit({ tonAddress: null }) }).ok).toBe(false);
    expect(checkTonAsk({ ...base, requester: kit(), openRequestIds: ['rq_1'] }).ok).toBe(false);
    expect(checkTonAsk({ ...base, requester: kit(), amount: 2.000000001 })).toEqual({ ok: false, reason: 'TON requests are capped at 2 TON each.' });
  });

  it('counts only TON paid in the last 24 hours toward the daily cap', () => {
    const payouts = [
      { amount: 2, currency: 'TON' as const, at: NOW - 60_000 },
      { amount: 2, currency: 'TON' as const, at: NOW - 2 * 60 * 60_000 },
      { amount: 2, currency: 'TON' as const, at: NOW - 25 * 60 * 60_000 },
      { amount: 20, currency: 'USDC' as const, at: NOW - 60_000 },
      { amount: 20, at: NOW - 60_000 },
    ];
    expect(tonPaidInLastDay(payouts, NOW)).toBe(4_000_000_000n);
    const res = checkTonAsk({ requester: kit(), amount: 1.5, openRequestIds: [], payouts, caps, now: NOW });
    expect(res).toEqual({ ok: false, reason: 'That would pass the 5 TON daily limit (1 TON left today).' });
  });

  it('checks again at pay time: expired, already paid, not TON, or requester no longer approved', () => {
    const base = { requester: kit(), payouts: [], caps, now: NOW };
    expect(checkTonPayout({ ...base, request: tonRequest() })).toEqual({ ok: true });
    expect(checkTonPayout({ ...base, request: tonRequest({ expiresAt: NOW }) }).ok).toBe(false);
    expect(checkTonPayout({ ...base, request: tonRequest({ status: 'paid' }) }).ok).toBe(false);
    expect(checkTonPayout({ ...base, request: tonRequest({ currency: 'USDC' }) }).ok).toBe(false);
    expect(checkTonPayout({ ...base, request: tonRequest(), requester: kit({ status: 'pending' }) }).ok).toBe(false);
    expect(checkTonPayout({ ...base, request: tonRequest({ requesterId: '7' }) }).ok).toBe(false);
  });

  it('the safety policy refuses mainnet, unapproved recipients and cap breaches before any send', () => {
    const ok = {
      endpoint: TONCENTER_TESTNET_URL,
      toKey: RAW_KIT,
      approvedRecipientKeys: new Set([RAW_KIT]),
      amountNano: 2_000_000_000n,
      perRequestNano: 2_000_000_000n,
      dailyNano: 5_000_000_000n,
      paidLastDayNano: 3_000_000_000n,
    };
    expect(() => assertAllowedTonPayout(ok)).not.toThrow();
    expect(() => assertAllowedTonPayout({ ...ok, endpoint: TONCENTER_MAINNET_URL })).toThrow(SafetyPolicyError);
    expect(() => assertAllowedTonPayout({ ...ok, toKey: RAW_OTHER })).toThrow(/not an approved/);
    expect(() => assertAllowedTonPayout({ ...ok, amountNano: 0n })).toThrow(SafetyPolicyError);
    expect(() => assertAllowedTonPayout({ ...ok, amountNano: 2_000_000_001n })).toThrow(/per-request cap/);
    expect(() => assertAllowedTonPayout({ ...ok, paidLastDayNano: 3_000_000_001n })).toThrow(/daily cap/);
    expect(approvedTonAddressKeys([kit(), kit({ telegramUserId: '7', status: 'pending', tonAddress: RAW_OTHER }), kit({ tonAddress: null })])).toEqual(new Set([RAW_KIT]));
  });

  it('the app wallet cannot be built on mainnet', () => {
    expect(() => new TonTestnetWallet(null, new Toncenter('mainnet'))).toThrow(/testnet/);
  });
});

describe('TON signals on the lens', () => {
  it('shows a TON request as one line: "KIT ASKS 2 TON - TAP: PAY"', () => {
    const signal = tonRequestSignal(tonRequest(), { ...kit(), tonAddress: KIT_TESTNET }, 'act_1', NOW);
    expect(signal.action?.actionType).toBe('ton_payout');
    expect(signal.action?.params).toMatchObject({ amount: 2, to: KIT_TESTNET, requestId: 'rq_0a0b0c0d' });
    const layout = lensOk({ mode: 'signal', paired: true, signal });
    expect(layout.textObject[0]?.content).toBe('KIT ASKS 2 TON - TAP: PAY');
    const long = tonRequestSignal(tonRequest({ amount: 1.123456789 }), { ...kit({ name: 'ALEXANDRA KIT' }), tonAddress: KIT_TESTNET }, 'act_2', NOW);
    expect(signalLensLine(long).length).toBeLessThanOrEqual(SIGNAL_LENS_LINE_MAX);
    lensOk({ mode: 'signal', paired: true, signal: long });
  });

  const snap = (over: Partial<TonWalletSnapshot> = {}): TonWalletSnapshot => ({
    network: 'ton-testnet',
    address: KIT_TESTNET,
    balanceNano: '3000000000',
    state: 'active',
    incoming: [{ hash: HASH_A, lt: '100', from: KIT_TESTNET, amountNano: '2000000000', comment: '', at: NOW - 60_000 }],
    updatedAt: NOW,
    ...over,
  });

  it('raises an incoming payment for 10 minutes and a low balance only after it crosses the floor', () => {
    const signals = tonWalletSignals(snap(), { lowBalanceTon: 0.5, lowSince: null }, NOW);
    expect(signals.map((s) => s.line)).toEqual([`RECEIVED 2 TON FROM ${KIT_TESTNET.slice(0, 4)}..${KIT_TESTNET.slice(-4)} (TESTNET)`]);
    expect(tonWalletSignals(snap(), { lowBalanceTon: 0.5, lowSince: null }, NOW - 60_000 + TON_INCOMING_WINDOW_MS)).toEqual([]);
    const low = snap({ balanceNano: '120000000', incoming: [] });
    expect(tonWalletSignals(low, { lowBalanceTon: 0.5, lowSince: null }, NOW)).toEqual([]);
    const raised = tonWalletSignals(low, { lowBalanceTon: 0.5, lowSince: NOW }, NOW + 1000);
    expect(raised.map((s) => s.line)).toEqual(['TON TEST WALLET 0.12 TON, UNDER 0.5']);
    for (const s of raised) lensOk({ mode: 'signal', paired: true, signal: s });
  });

  it('ranks a TON request (it needs an answer) above TON notices, and money at risk above both', () => {
    const request = tonRequestSignal(tonRequest(), { ...kit(), tonAddress: KIT_TESTNET }, 'act_1', NOW);
    const incoming = tonWalletSignals(snap(), { lowBalanceTon: 0.5, lowSince: null }, NOW)[0] as Signal;
    const liq: Signal = { ...request, id: 'hyperliquid:liq:ETH', source: 'hyperliquid', kind: 'liquidation_distance', severity: 'critical', lossDistancePct: 3, action: null };
    expect(rankSignals([incoming, request, liq]).map((s) => s.id)).toEqual(['hyperliquid:liq:ETH', 'request:rq_0a0b0c0d', 'ton:in:100']);
  });

  it('feeds the live wallet read into the one queue and raises low balance on the drop', () => {
    const engine = new ChainVisionEngine(loadConfig());
    engine.applyTonSnapshot(snap({ incoming: [] }), NOW);
    expect(engine.queue.size).toBe(0);
    expect(engine.getLensState(NOW).mode).toBe('idle');
    engine.applyTonSnapshot(snap({ balanceNano: '100000000', incoming: [] }), NOW + 15_000);
    expect(engine.getLensState(NOW + 15_000).signal?.id).toBe('ton:low');
    engine.applyTonSnapshot(snap({ balanceNano: '900000000', incoming: [] }), NOW + 30_000);
    expect(engine.queue.size).toBe(0);
  });

  it('puts one READ-ONLY balance line in the brief and keeps it inside the lens limits', () => {
    expect(tonReadOnlyBriefLine({ connectedTestnetNano: null, mainnetNano: null })).toBeNull();
    const line = tonReadOnlyBriefLine({ connectedTestnetNano: '3210000000', mainnetNano: '123456789012345' }) as string;
    expect(line).toBe('READ-ONLY TON 3.21 TESTNET · GRAM 123456.78 MAINNET');
    const engine = new ChainVisionEngine(loadConfig());
    (engine as unknown as { tonMainnetNano: string }).tonMainnetNano = '12340000000';
    expect(engine.showBrief(NOW)).toEqual([BRIEF_EMPTY_TEXT, 'READ-ONLY GRAM 12.34 MAINNET']);
    engine.applyTonSnapshot(snap(), NOW);
    engine.queue.upsert(tonRequestSignal(tonRequest(), { ...kit(), tonAddress: KIT_TESTNET }, 'act_1', NOW));
    engine.queue.upsert(tonRequestSignal(tonRequest({ id: 'rq_2', requesterId: '7' }), { ...kit({ name: 'SAM' }), tonAddress: KIT_TESTNET }, 'act_2', NOW));
    const lines = engine.showBrief(NOW);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('READ-ONLY GRAM 12.34 MAINNET');
    lensOk(engine.getLensState(NOW));
  });
});

describe('paying a TON request', () => {
  let mnemonic = '';
  beforeAll(async () => {
    mnemonic = (await mnemonicNew(24)).join(' ');
  });

  function desk(request: TonRequestView, requester: TonRequesterView) {
    const settled: unknown[] = [];
    const d: TonRequestDesk & { settled: unknown[] } = {
      settled,
      requesters: [requester],
      payouts: [],
      request: (id) => (id === request.id ? request : null),
      requester: (id) => (id === requester.telegramUserId ? requester : null),
      async settle(paid) {
        settled.push(paid);
      },
      async failed() {},
    };
    return d;
  }

  it('the engine refuses a TON payout for a request the book does not hold, and an over-cap one, without sending', async () => {
    const engine = new ChainVisionEngine(loadConfig());
    const action = tonRequestSignal(tonRequest(), { ...kit(), tonAddress: KIT_TESTNET }, 'act_1', Date.now()).action!;
    await expect(engine.executeAction(action)).rejects.toThrow('This request is no longer open.');
    const over = tonRequest({ amount: 3, expiresAt: Date.now() + 60_000 });
    engine.tonRequests = desk(over, kit());
    const overAction = tonRequestSignal(over, { ...kit(), tonAddress: KIT_TESTNET }, 'act_2', Date.now()).action!;
    await expect(engine.executeAction(overAction)).rejects.toThrow('TON requests are capped at 2 TON each.');
  });

  it('signs one v4 transfer to the approved address for the exact nanotons, then reports the on-chain hash', async () => {
    let seqno = 5;
    let sentBoc: string | null = null;
    const txHash = Buffer.from(HASH_A, 'hex').toString('base64');
    const fakeFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = url.pathname.split('/').pop();
      const json = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
      if (method === 'getWalletInformation') {
        return json({ wallet: true, balance: sentBoc ? '1940000000' : '3000000000', account_state: 'active', seqno });
      }
      if (method === 'sendBocReturnHash') {
        sentBoc = (JSON.parse(String(init?.body)) as { boc: string }).boc;
        seqno += 1;
        return json({ hash: Buffer.alloc(32, 7).toString('base64') });
      }
      if (method === 'getTransactions') {
        if (!sentBoc) return json([{ utime: 1, transaction_id: { lt: '100', hash: txHash }, in_msg: { source: '', value: '0' }, out_msgs: [] }]);
        return json([
          { utime: 2, transaction_id: { lt: '101', hash: txHash }, in_msg: { source: '', value: '0' }, out_msgs: [{ destination: KIT.toString({ testOnly: true }), value: '1000000000' }] },
        ]);
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const wallet = new TonTestnetWallet(mnemonic, new Toncenter('testnet', 'test-key', fakeFetch));
    const rail = new TonRequestRail(wallet);
    const request = tonRequest({ amount: 1, expiresAt: Date.now() + 60_000 });
    const d = desk(request, kit());
    const action = tonRequestSignal(request, { ...kit(), tonAddress: KIT_TESTNET }, 'act_1', Date.now()).action!;
    const paid = await rail.pay(action, d, { perRequestTon: 2, dailyTon: 5 });

    expect(paid.transfer.txHash).toBe(HASH_A);
    expect(paid.receipt).toMatchObject({ protocol: 'ton', network: 'ton-testnet', actionType: 'ton_payout', summary: 'PAID 1 TON TO KIT' });
    expect(paid.receipt.explorerUrl).toBe(`https://testnet.tonviewer.com/transaction/${HASH_A}`);
    expect(paid.requesterText).toContain('1 TON on TON testnet');

    const ext = loadMessage(Cell.fromBoc(Buffer.from(sentBoc as unknown as string, 'base64'))[0]!.beginParse());
    expect(ext.info.type).toBe('external-in');
    expect(ext.init).toBeFalsy();
    const body = ext.body.beginParse();
    body.skip(512 + 32 + 32);
    expect(body.loadUint(32)).toBe(5);
    body.loadUint(8);
    body.loadUint(8);
    const inner = loadMessageRelaxed(body.loadRef().beginParse());
    expect(inner.info.type).toBe('internal');
    if (inner.info.type !== 'internal') return;
    expect(inner.info.dest.equals(KIT)).toBe(true);
    expect(inner.info.value.coins).toBe(1_000_000_000n);
    expect(inner.info.bounce).toBe(false);
  }, 20_000);

  it('parses incoming payments from toncenter transactions and ignores outgoing ones', () => {
    const b64 = Buffer.from(HASH_A, 'hex').toString('base64');
    const incoming = incomingTransfers([
      { utime: 10, transaction_id: { lt: '7', hash: b64 }, in_msg: { source: RAW_KIT, value: '2500000000', message: 'hi' } },
      { utime: 11, transaction_id: { lt: '8', hash: b64 }, in_msg: { source: '', value: '0' }, out_msgs: [{ destination: RAW_OTHER, value: '1' }] },
    ]);
    expect(incoming).toEqual([{ hash: HASH_A, lt: '7', from: KIT_TESTNET, amountNano: '2500000000', comment: 'hi', at: 10_000 }]);
    expect(tonHashToHex(HASH_A)).toBe(HASH_A);
  });
});
