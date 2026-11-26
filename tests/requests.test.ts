import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  REQUEST_TTL_MS,
  checkAsk,
  checkPayout,
  parseAskAmount,
  renderLensPage,
  requesterDisplayName,
  validateLensLayout,
  type MoneyRequest,
  type ProtocolSnapshots,
  type Requester,
} from '@chainvision/shared';
import { SEPOLIA_TOKENS, loadConfig } from '../packages/server/src/config.js';
import { SafetyPolicyError, assertAllowedPayout } from '../packages/server/src/safety/policy.js';
import { TelegramBotService, type CommandContext } from '../packages/server/src/telegram/bot.js';
import { isWearerRequest, verifyInitData } from '../packages/server/src/telegram/initdata.js';
import { ChainVisionEngine } from '../packages/server/src/watcher/engine.js';

const NOW = 1_800_000_000_000;
const ADDR = '0x1111111111111111111111111111111111111111' as const;
const CAPS = { perRequestUsdc: 25, dailyUsdc: 50 };
const WEARER = '1000';
const KIT = '2000';

const approved: Requester = {
  telegramUserId: KIT,
  name: 'KIT',
  username: 'kit',
  address: ADDR,
  status: 'approved',
  registeredAt: NOW,
  approvedAt: NOW,
};

function req(over: Partial<MoneyRequest> = {}): MoneyRequest {
  return {
    id: 'rq_1',
    requesterId: KIT,
    amount: 20,
    createdAt: NOW,
    expiresAt: NOW + REQUEST_TTL_MS,
    status: 'open',
    askedInChatId: KIT,
    askedInGroup: false,
    resolvedAt: null,
    resolvedVia: null,
    txHash: null,
    error: null,
    messages: [],
    ...over,
  };
}

describe('request parsing', () => {
  it('reads /ask amounts in USDC only', () => {
    expect(parseAskAmount('/ask 20 USDC')).toBe(20);
    expect(parseAskAmount('/ask@evenchainvisionbot 20.5 usdc')).toBe(20.5);
    expect(parseAskAmount('/ask 20')).toBe(20);
    expect(parseAskAmount('/ask 20 ETH')).toBeNull();
    expect(parseAskAmount('/ask -5 USDC')).toBeNull();
    expect(parseAskAmount('/ask 0 USDC')).toBeNull();
    expect(parseAskAmount('/ask 1.1234567 USDC')).toBeNull();
    expect(parseAskAmount('/ask')).toBeNull();
  });

  it('keeps requester names lens-safe and short', () => {
    expect(requesterDisplayName('Kit')).toBe('KIT');
    expect(requesterDisplayName('Ana-María 🚀 Long Surname')).toBe('ANAMARA LONG');
    expect(requesterDisplayName('')).toBe('SOMEONE');
  });
});

describe('request rules', () => {
  it('only lets known, approved requesters ask', () => {
    expect(checkAsk({ requester: null, amount: 5, requests: [], payouts: [], caps: CAPS, now: NOW }).ok).toBe(false);
    const pending = { ...approved, status: 'pending' as const };
    const out = checkAsk({ requester: pending, amount: 5, requests: [], payouts: [], caps: CAPS, now: NOW });
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining('not approved') });
    expect(checkAsk({ requester: approved, amount: 5, requests: [], payouts: [], caps: CAPS, now: NOW }).ok).toBe(true);
  });

  it('enforces the per-request cap, the daily cap and one open request per requester', () => {
    expect(checkAsk({ requester: approved, amount: 26, requests: [], payouts: [], caps: CAPS, now: NOW }).ok).toBe(false);
    expect(checkAsk({ requester: approved, amount: 5, requests: [req()], payouts: [], caps: CAPS, now: NOW }).ok).toBe(false);
    expect(
      checkAsk({ requester: approved, amount: 5, requests: [req({ expiresAt: NOW })], payouts: [], caps: CAPS, now: NOW }).ok,
    ).toBe(true);
    const payouts = [{ requestId: 'a', requesterId: KIT, amount: 40, txHash: '0x1', at: NOW - 1000 }];
    expect(checkAsk({ requester: approved, amount: 11, requests: [], payouts, caps: CAPS, now: NOW })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('10 USDC left'),
    });
    expect(checkAsk({ requester: approved, amount: 10, requests: [], payouts, caps: CAPS, now: NOW }).ok).toBe(true);
    expect(checkAsk({ requester: approved, amount: 25, requests: [], payouts, caps: CAPS, now: NOW + DAY_MS }).ok).toBe(true);
  });

  it('checks again at payment time', () => {
    const base = { requester: approved, payouts: [], caps: CAPS, now: NOW };
    expect(checkPayout({ ...base, request: req() }).ok).toBe(true);
    expect(checkPayout({ ...base, request: req({ expiresAt: NOW }) }).ok).toBe(false);
    expect(checkPayout({ ...base, request: req({ status: 'declined' }) }).ok).toBe(false);
    expect(checkPayout({ ...base, requester: { ...approved, status: 'pending' }, request: req() }).ok).toBe(false);
    expect(checkPayout({ ...base, caps: { perRequestUsdc: 10, dailyUsdc: 50 }, request: req() }).ok).toBe(false);
  });

  it('blocks payouts off Sepolia, in other tokens, to unapproved addresses, or over caps', () => {
    const ok = {
      chainId: 11155111,
      token: SEPOLIA_TOKENS.AAVE_USDC.address,
      to: ADDR,
      amountUsdc: 20,
      approvedRecipients: new Set([ADDR.toLowerCase()]),
      perRequestCapUsdc: 25,
      dailyCapUsdc: 50,
      paidLastDayUsdc: 0,
    };
    expect(() => assertAllowedPayout(ok)).not.toThrow();
    expect(() => assertAllowedPayout({ ...ok, token: SEPOLIA_TOKENS.CIRCLE_USDC.address })).not.toThrow();
    expect(() => assertAllowedPayout({ ...ok, chainId: 1 })).toThrow(SafetyPolicyError);
    expect(() => assertAllowedPayout({ ...ok, token: SEPOLIA_TOKENS.AAVE_DAI.address })).toThrow(/token/);
    expect(() => assertAllowedPayout({ ...ok, approvedRecipients: new Set() })).toThrow(/approved/);
    expect(() => assertAllowedPayout({ ...ok, amountUsdc: 30 })).toThrow(/per-request/);
    expect(() => assertAllowedPayout({ ...ok, paidLastDayUsdc: 35 })).toThrow(/daily/);
  });
});

describe('wearer authorization for the Mini App', () => {
  const token = '123456:TEST-TOKEN';
  function initData(userId: number, authDate: number): string {
    const params = new URLSearchParams({ auth_date: String(authDate), query_id: 'q1', user: JSON.stringify({ id: userId }) });
    const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    params.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
    return params.toString();
  }

  it('accepts valid initData from the paired user and rejects tampering, staleness and other users', () => {
    const now = NOW;
    const good = initData(1000, now / 1000 - 60);
    expect(verifyInitData(good, token, now)).toEqual({ ok: true, userId: '1000' });
    expect(verifyInitData(good.replace('1000', '1001'), token, now).ok).toBe(false);
    expect(verifyInitData(initData(1000, now / 1000 - 2 * 86400), token, now).ok).toBe(false);
    const base = { botToken: token, wearerChatId: '1000', remoteAddress: '203.0.113.9', host: 'x.example', forwarded: true, now };
    expect(isWearerRequest({ ...base, initData: good })).toBe(true);
    expect(isWearerRequest({ ...base, initData: initData(2000, now / 1000) })).toBe(false);
  });

  it('accepts a direct loopback request but not one through a proxy or tunnel', () => {
    const base = { initData: undefined, botToken: null, wearerChatId: null };
    expect(isWearerRequest({ ...base, remoteAddress: '127.0.0.1', host: '127.0.0.1:8787', forwarded: false })).toBe(true);
    expect(isWearerRequest({ ...base, remoteAddress: '127.0.0.1', host: '127.0.0.1:8787', forwarded: true })).toBe(false);
    expect(isWearerRequest({ ...base, remoteAddress: '127.0.0.1', host: 'abc.trycloudflare.com', forwarded: false })).toBe(false);
  });
});

function calm(): ProtocolSnapshots {
  return {
    updatedAt: Date.now(),
    aave: {
      network: 'sepolia', address: ADDR, healthFactor: 2.1, totalCollateralUsd: 900, totalDebtUsd: 400,
      availableBorrowsUsd: 300, currentLiquidationThresholdPct: 82, ltvPct: 75, usdcBalance: 500, daiBalance: 0,
      ethBalance: 0.1, rates: [],
    },
    uniswap: {
      network: 'sepolia', address: ADDR, poolAddress: ADDR, pair: 'WETH/USDC', feeTier: 500, currentTick: 0,
      ethQuoteUsdc: 0, usdcToDaiRate: 1, lpPositions: [],
    },
    hyperliquid: {
      network: 'hyperliquid-testnet', accountAddress: ADDR, agentAddress: ADDR, accountValueUsd: 1000, marginUsedUsd: 0,
      ethMarkPx: 1700, btcMarkPx: 60000, ethFundingPctHr: 0, markPrices: { ETH: 1700 }, positions: [],
    },
    exchange: { venue: 'bybit-testnet', mode: 'public', ethMarkPx: 1700, ethFundingPct: 0, equityUsd: null, positions: [] },
  };
}

function ctx(from: string, text: string, isGroup = false, chatId = from): CommandContext {
  return { chatId, isGroup, from: { id: from, firstName: 'Kit', username: 'kit' }, text, args: text.split(/\s+/).slice(1) };
}

function setup() {
  const engine = new ChainVisionEngine(loadConfig());
  engine.pairFromMiniApp({ code: engine.getSession().code, telegramChatId: WEARER });
  engine.applySnapshots(calm());
  engine.pollNow = async () => calm();
  const transfers: Array<{ to: string; amount: number; perRequestCapUsdc: number; approved: string[] }> = [];
  engine.payout.transferUsdc = async (p) => {
    transfers.push({ to: p.to, amount: p.amount, perRequestCapUsdc: p.perRequestCapUsdc, approved: [...p.approvedRecipients] });
    return { txHash: `0x${'ab'.repeat(32)}`, explorerUrl: 'https://sepolia.etherscan.io/tx/0xab', before: 100, after: 100 - p.amount };
  };
  return { engine, transfers };
}

describe('money requests through Telegram, approved on the lens', () => {
  it('registers in private only, and a new requester needs the wearer\'s approval before asking', async () => {
    const { engine } = setup();
    expect((await engine.handleRegister(ctx(KIT, `/register ${ADDR} Kit`, true, '-100'))).text).toMatch(/private chat/);
    expect((await engine.handleRegister(ctx(KIT, '/register nope'))).text).toMatch(/Sepolia address/);
    expect((await engine.handleRegister(ctx(KIT, `/register ${ADDR} Kit`))).text).toMatch(/approves new requesters once/);
    expect((await engine.handleAsk(ctx(KIT, '/ask 20 USDC'))).text).toMatch(/not approved/);
    expect((await engine.handleAsk(ctx('3000', '/ask 20 USDC'))).text).toMatch(/Register first/);
    expect(engine.getLensState().mode).toBe('idle');
  });

  it('shows one line, pays only on a tap, and both rules and caps hold', async () => {
    const { engine, transfers } = setup();
    await engine.handleRegister(ctx(KIT, `/register ${ADDR} Kit`));
    engine.requests.approve(KIT, Date.now());

    expect((await engine.handleAsk(ctx(KIT, '/ask 30 USDC'))).text).toMatch(/capped at 25/);
    expect((await engine.handleAsk(ctx(KIT, '/ask 20 USDC'))).text).toMatch(/Sent to the wearer/);
    expect((await engine.handleAsk(ctx(KIT, '/ask 5 USDC'))).text).toMatch(/already have an open request/);

    const state = engine.getLensState();
    const layout = renderLensPage(state);
    expect(layout.textObject[0]?.content).toBe('KIT ASKS 20 USDC - TAP: PAY');
    expect(validateLensLayout(layout).valid).toBe(true);
    expect(transfers).toHaveLength(0);

    const receipt = await engine.confirmPendingAction(state.signal!.action!.id);
    expect(transfers).toEqual([{ to: ADDR, amount: 20, perRequestCapUsdc: 25, approved: [ADDR.toLowerCase()] }]);
    expect(receipt.summary).toBe('PAID 20 USDC TO KIT');
    expect(engine.requests.requests[0]).toMatchObject({ status: 'paid', resolvedVia: 'glasses_tap' });
    expect(engine.requests.paidLastDay(Date.now())).toBe(20);
    expect(engine.queue.size).toBe(0);

    expect((await engine.handleAsk(ctx(KIT, '/ask 25 USDC'))).text).toMatch(/Sent to the wearer/);
    expect(engine.getLensState().mode).toBe('result');
    engine.dismissToBlank();
    const next = engine.getLensState().signal!;
    await engine.confirmPendingAction(next.action!.id);
    expect((await engine.handleAsk(ctx(KIT, '/ask 10 USDC'))).text).toMatch(/daily limit \(5 USDC left/);
    expect(transfers).toHaveLength(2);
  });

  it('a swipe declines the request, and an unanswered one expires; neither pays', async () => {
    const { engine, transfers } = setup();
    await engine.handleRegister(ctx(KIT, `/register ${ADDR} Kit`));
    engine.requests.approve(KIT, Date.now());

    await engine.handleAsk(ctx(KIT, '/ask 20 USDC'));
    engine.dismissToBlank();
    expect(engine.requests.requests[0]).toMatchObject({ status: 'declined', resolvedVia: 'lens_swipe' });
    expect(engine.getLensState().mode).toBe('idle');

    await engine.handleAsk(ctx(KIT, '/ask 20 USDC'));
    const created = engine.requests.requests[1]!;
    engine.tick(created.expiresAt);
    expect(created.status).toBe('expired');
    expect(engine.getLensState(created.expiresAt).mode).toBe('idle');
    expect(transfers).toHaveLength(0);
  });

  it('a changed address needs approval again', async () => {
    const { engine } = setup();
    await engine.handleRegister(ctx(KIT, `/register ${ADDR} Kit`));
    engine.requests.approve(KIT, Date.now());
    await engine.handleRegister(ctx(KIT, '/register 0x2222222222222222222222222222222222222222 Kit'));
    expect(engine.requests.requester(KIT)?.status).toBe('pending');
  });

  it('Telegram approval needs the wearer, glasses offline, and a second confirmation', async () => {
    const { engine, transfers } = setup();
    await engine.handleRegister(ctx(KIT, `/register ${ADDR} Kit`));
    engine.requests.approve(KIT, Date.now());
    await engine.handleAsk(ctx(KIT, '/ask 20 USDC'));
    const id = engine.requests.requests[0]!.id;
    const cb = (from: string, data: string) =>
      engine.handleRequestCallback({ data, from: { id: from, firstName: '', username: null }, chatId: from, messageId: 1 });

    expect((await cb(KIT, `rq:pay:${id}`)).answer).toMatch(/Only the paired wearer/);
    engine.setGlassesConnected(1);
    expect((await cb(WEARER, `rq:approve:${id}`)).answer).toMatch(/tap PAY on the lens/);
    expect((await cb(WEARER, `rq:pay:${id}`)).answer).toMatch(/tap PAY on the lens/);
    engine.setGlassesConnected(-1);

    const first = await cb(WEARER, `rq:approve:${id}`);
    expect(first.editText).toMatch(/Second confirmation/);
    expect(JSON.stringify(first.keyboard)).toContain(`rq:pay:${id}`);
    expect(transfers).toHaveLength(0);

    const paid = await cb(WEARER, `rq:pay:${id}`);
    expect(paid.answer).toBe('Paid');
    expect(transfers).toHaveLength(1);
    expect(engine.requests.requests[0]).toMatchObject({ status: 'paid', resolvedVia: 'telegram_confirm' });
    expect((await cb(WEARER, `rq:pay:${id}`)).editText).toMatch(/no longer open/);
    expect(transfers).toHaveLength(1);
  });

  it('the bot ignores commands addressed to another bot in a group', async () => {
    const bot = new TelegramBotService(loadConfig());
    (bot as unknown as { username: string }).username = 'evenchainvisionbot';
    bot.sendMessage = async () => ({ message_id: 7 });
    const asks: string[] = [];
    const handlers = {
      onPairCode: () => ({ ok: true, message: '' }),
      onStatusRequest: async () => calm(),
      onGetLastReceipt: () => null,
      onAsk: (c: CommandContext) => {
        asks.push(`${c.isGroup}:${c.from.id}:${c.text}`);
        return { text: 'ok' };
      },
    };
    const update = (text: string) => ({
      update_id: 1,
      message: { message_id: 1, chat: { id: -100, type: 'supergroup' }, from: { id: 2000, first_name: 'Kit' }, text },
    });
    expect(await bot.handleUpdate(update('/ask@otherbot 20 USDC'), handlers)).toEqual([]);
    expect(await bot.handleUpdate(update('/ask@EvenChainVisionBot 20 USDC'), handlers)).toEqual([7]);
    expect(await bot.handleUpdate(update('/ask 5 USDC'), handlers)).toEqual([7]);
    expect(asks).toEqual(['true:2000:/ask@EvenChainVisionBot 20 USDC', 'true:2000:/ask 5 USDC']);
  });
});
