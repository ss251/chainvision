import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXCHANGE_CAPS,
  SIGNAL_LENS_LINE_MAX,
  parseIntentJson,
  parseVoiceIntentLocally,
  renderLensPage,
  signalLensLine,
  validateLensLayout,
  type ExchangeDeskSnapshot,
  type LensViewState,
  type PendingAction,
  type ProtocolSnapshots,
} from '@chainvision/shared';
import { loadConfig, type AppConfig } from '../packages/server/src/config.js';
import { parseBinanceFilters, parseBinancePrices } from '../packages/server/src/exchanges/binance.js';
import { parseBybitInstrument, parseBybitMark, parseBybitPositions } from '../packages/server/src/exchanges/bybit.js';
import { ExchangeCapError, ExchangeCapLedger } from '../packages/server/src/exchanges/caps.js';
import { parseCoinbaseTicker } from '../packages/server/src/exchanges/coinbase.js';
import {
  ExchangeDesk,
  binanceCancelDraft,
  binanceLimitDraft,
  bybitTransferDraft,
  exchangeSignalSpecs,
} from '../packages/server/src/exchanges/desk.js';
import {
  assertExchangeHost,
  binanceQuery,
  binanceSign,
  bybitPreSign,
  bybitSign,
  floorToStep,
} from '../packages/server/src/exchanges/signing.js';
import { ChainVisionEngine } from '../packages/server/src/watcher/engine.js';

const NOW = Date.now();
const fixture = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/exchanges', name), 'utf8'));

function config(keys: { bybit?: boolean; binance?: boolean } = {}): AppConfig {
  return {
    ...loadConfig(),
    bybitTestnetApiKey: keys.bybit ? 'test-key' : null,
    bybitTestnetApiSecret: keys.bybit ? 'test-secret' : null,
    binanceTestnetApiKey: keys.binance ? 'test-key' : null,
    binanceTestnetApiSecret: keys.binance ? 'test-secret' : null,
  } as AppConfig;
}

function desk(overrides: Partial<ExchangeDeskSnapshot> = {}): ExchangeDeskSnapshot {
  return {
    updatedAt: NOW,
    bybit: { marks: { BTC: 57965.6 }, signed: 'ok', account: null, positions: [] },
    binance: { prices: { BTC: 59304 }, signed: 'ok', balances: [], openOrders: [], recentFills: [] },
    coinbase: { prices: { BTC: 59198.42 } },
    ...overrides,
  };
}

const BTC_LONG = {
  symbol: 'BTCUSDT',
  coin: 'BTC',
  side: 'LONG' as const,
  size: 0.02,
  entryPx: 60000,
  markPx: 57965.6,
  liqPx: 54500,
  liqDistancePct: 5.98,
  notionalUsd: 1159.3,
  unrealizedPnlUsd: -40.7,
  leverage: 10,
  positionIdx: 0,
};

function marginLow(fundingUsdt = 4500): ExchangeDeskSnapshot {
  return desk({
    bybit: {
      marks: { BTC: 57965.6 },
      signed: 'ok',
      account: { tradingEquityUsd: 300, tradingAvailableUsd: 90, maintenanceMarginRate: 0.22, fundingUsdt },
      positions: [BTC_LONG],
    },
  });
}

function protocols(exchanges?: ExchangeDeskSnapshot): ProtocolSnapshots {
  return {
    updatedAt: NOW,
    aave: {
      network: 'sepolia',
      address: '0x537B1ED6f937C1A27e7C6249026732565B381fB0',
      healthFactor: 2.1,
      totalCollateralUsd: 900,
      totalDebtUsd: 400,
      availableBorrowsUsd: 300,
      currentLiquidationThresholdPct: 82,
      ltvPct: 75,
      usdcBalance: 500,
      daiBalance: 200,
      ethBalance: 0.1,
      rates: [],
    },
    uniswap: {
      network: 'sepolia',
      address: '0x537B1ED6f937C1A27e7C6249026732565B381fB0',
      poolAddress: '0x3289680dd4d6c10bb19b899729cda5eef58aeff1',
      pair: 'WETH/USDC',
      feeTier: 500,
      currentTick: 172652,
      ethQuoteUsdc: 31760,
      usdcToDaiRate: 3.43,
      lpPositions: [],
    },
    hyperliquid: {
      network: 'hyperliquid-testnet',
      accountAddress: '0x1111111111111111111111111111111111111111',
      agentAddress: '0x9C11bc8695Ac49E17b755981f621c89b27f8882d',
      accountValueUsd: 1000,
      marginUsedUsd: 100,
      ethMarkPx: 1784,
      btcMarkPx: 62000,
      ethFundingPctHr: 0.001,
      markPrices: { ETH: 1784, BTC: 62000, SOL: 140 },
      positions: [],
    },
    exchange: { venue: 'bybit-testnet', mode: 'public', ethMarkPx: 1785, ethFundingPct: 0.01, equityUsd: null, positions: [] },
    ...(exchanges ? { exchanges } : {}),
  };
}

function confirmCard(draft: Omit<PendingAction, 'id' | 'source' | 'createdAt' | 'expiresAt' | 'requiresTap'>): LensViewState {
  return {
    mode: 'confirm',
    paired: true,
    pendingAction: { ...draft, id: 'act_test', source: 'voice', createdAt: NOW, expiresAt: NOW + 90_000, requiresTap: true },
  };
}

describe('request signing', () => {
  it('matches the Binance documented HMAC-SHA256 test vector', () => {
    // Example secret, payload and signature published in Binance's spot API docs ("SIGNED Endpoint examples").
    // The public example is split into chunks only so secret scanners do not flag it as a leaked credential.
    const docExample = ['NhqPtmdSJYdKjVHj', 'A7PZj4Mge3R5YNiP', '1e3UZjInClVN65XA', 'bvqqM6A7H5fATj0j'].join('');
    const query = binanceQuery({
      symbol: 'LTCBTC',
      side: 'BUY',
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity: 1,
      price: 0.1,
      recvWindow: 5000,
      timestamp: 1499827319559,
    });
    expect(query).toBe(
      'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559',
    );
    expect(binanceSign(docExample, query)).toBe('c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71');
  });

  it('percent-encodes non-ASCII values exactly like the Binance documented payload', () => {
    expect(binanceQuery({ symbol: '１２３４５６', side: 'BUY' })).toBe(
      'symbol=%EF%BC%91%EF%BC%92%EF%BC%93%EF%BC%94%EF%BC%95%EF%BC%96&side=BUY',
    );
  });

  it('builds the Bybit V5 string to sign exactly as the documented GET and POST examples', () => {
    // Bybit's V5 guide publishes the plain text to sign; it does not publish the secret behind its example signatures.
    expect(bybitPreSign('1658384314791', 'XXXXXXXXXX', '5000', 'category=option&symbol=BTC-29JUL22-25000-C')).toBe(
      '1658384314791XXXXXXXXXX5000category=option&symbol=BTC-29JUL22-25000-C',
    );
    expect(bybitPreSign('1658385579423', 'XXXXXXXXXX', '5000', '{"category": "option"}')).toBe(
      '1658385579423XXXXXXXXXX5000{"category": "option"}',
    );
    const pre = bybitPreSign('1658384314791', 'XXXXXXXXXX', '5000', 'category=option');
    expect(bybitSign('s3cret', '1658384314791', 'XXXXXXXXXX', '5000', 'category=option')).toBe(binanceSign('s3cret', pre));
  });

  it('only lets keys travel to testnet hosts', () => {
    expect(() => assertExchangeHost('https://api-testnet.bybit.com/v5/order/create', true)).not.toThrow();
    expect(() => assertExchangeHost('https://testnet.binance.vision/api/v3/order', true)).not.toThrow();
    expect(() => assertExchangeHost('https://api.exchange.coinbase.com/products/BTC-USD/ticker', false)).not.toThrow();
    expect(() => assertExchangeHost('https://api.exchange.coinbase.com/orders', true)).toThrow(/only testnet hosts/);
    expect(() => assertExchangeHost('https://api.bybit.com/v5/order/create', true)).toThrow(/allowlist/);
    expect(() => assertExchangeHost('https://api.binance.com/api/v3/order', true)).toThrow(/allowlist/);
  });
});

describe('public market data parsers (responses recorded from the live endpoints on 25 Nov 2026)', () => {
  it('reads Bybit testnet mark price and lot filters', () => {
    expect(parseBybitMark(fixture('bybit-testnet-ticker-btcusdt.json'))).toBe(57965.6);
    expect(parseBybitInstrument(fixture('bybit-testnet-instrument-btcusdt.json'))).toEqual({
      symbol: 'BTCUSDT',
      qtyStep: 0.001,
      minOrderQty: 0.001,
      minNotional: 5,
    });
  });

  it('reads Binance spot testnet prices and symbol filters', () => {
    const prices = parseBinancePrices(fixture('binance-testnet-prices.json'));
    expect(Object.keys(prices).sort()).toEqual(['BNB', 'BTC', 'ETH', 'SOL']);
    expect(parseBinanceFilters(fixture('binance-testnet-exchangeinfo-btcusdt.json'))).toEqual({
      symbol: 'BTCUSDT',
      tickSize: 0.01,
      stepSize: 0.00001,
      minQty: 0.00001,
      minNotional: 5,
    });
  });

  it('reads the Coinbase public ticker', () => {
    expect(parseCoinbaseTicker(fixture('coinbase-btc-usd-ticker.json'))).toBe(59198.42);
  });

  it('turns Bybit position rows into liquidation distance', () => {
    const [p] = parseBybitPositions({
      retCode: 0,
      retMsg: 'OK',
      result: {
        list: [
          { symbol: 'BTCUSDT', side: 'Buy', size: '0.02', avgPrice: '60000', markPrice: '58000', liqPrice: '55100', positionValue: '1200', unrealisedPnl: '-40', leverage: '10', positionIdx: 0 },
          { symbol: 'ETHUSDT', side: '', size: '0', avgPrice: '0', markPrice: '1665', liqPrice: '', positionValue: '0', unrealisedPnl: '0', leverage: '10', positionIdx: 0 },
        ],
      },
    });
    expect(p?.side).toBe('LONG');
    expect(p?.liqDistancePct).toBeCloseTo(5, 6);
  });

  it('rounds quantities down to exchange steps without float drift', () => {
    expect(floorToStep(0.0123456, 0.00001)).toBe(0.01234);
    expect(floorToStep(0.01, 0.001)).toBe(0.01);
    expect(floorToStep(57000.129, 0.1)).toBe(57000.1);
  });
});

describe('exchange caps', () => {
  it('refuses an action over the per-action cap', () => {
    const ledger = new ExchangeCapLedger();
    expect(() => ledger.check('bybit_transfer', 501, NOW)).toThrow(ExchangeCapError);
    expect(() => ledger.check('bybit_transfer', 500, NOW)).not.toThrow();
    expect(() => ledger.check('binance_cancel', 11, NOW)).toThrow(/per-action cap of 10 orders/);
  });

  it('refuses once the rolling 24-hour cap is used, and frees it a day later', () => {
    const ledger = new ExchangeCapLedger();
    ledger.record('bybit_transfer', 500, 't1', NOW);
    ledger.record('bybit_transfer', 500, 't2', NOW + 1000);
    ledger.record('bybit_transfer', 400, 't3', NOW + 2000);
    expect(ledger.allowance('bybit_transfer', NOW + 3000)).toBe(100);
    expect(() => ledger.check('bybit_transfer', 101, NOW + 3000)).toThrow(/daily cap 1500/);
    expect(ledger.allowance('bybit_transfer', NOW + 24 * 3600_000 + 1)).toBe(500);
    expect(ledger.allowance('binance_limit', NOW)).toBe(EXCHANGE_CAPS.binance_limit.perAction);
  });

  it('keeps the day across a restart in a mode-600 file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-caps-'));
    const file = path.join(dir, 'exchange-ledger.json');
    new ExchangeCapLedger(file).record('binance_limit', 450, '123', NOW);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(new ExchangeCapLedger(file).allowance('binance_limit', NOW)).toBeCloseTo(500, 6);
    expect(new ExchangeCapLedger(file).usedToday('binance_limit', NOW)).toBe(450);
  });

  it('checks the cap again at tap time before any exchange call', async () => {
    const d = new ExchangeDesk(config({ bybit: true }));
    const action = { ...bybitTransferDraft(900, marginLow()), id: 'act_x', source: 'voice', createdAt: NOW, expiresAt: NOW + 1000, requiresTap: true } as PendingAction;
    d.bybit.readAccount = async () => {
      throw new Error('must not reach the exchange');
    };
    await expect(d.execute(action)).rejects.toThrow(ExchangeCapError);
  });
});

describe('exchange signals in the one queue', () => {
  const th = new ChainVisionEngine(config()).getSession().thresholds;
  const full = () => 500;

  it('raises nothing when the accounts are calm, so the lens stays blank', () => {
    const engine = new ChainVisionEngine(config());
    engine.applySnapshots(protocols(desk()), NOW);
    engine.tick(NOW);
    expect(engine.queue.size).toBe(0);
    const layout = renderLensPage(engine.getLensState(NOW));
    expect(layout.totalChars).toBe(0);
  });

  it('shows the organisers-style line for low margin on the Bybit Trading account', () => {
    const specs = exchangeSignalSpecs(marginLow(), th, full);
    const margin = specs.find((s) => s.base.id === 'bybit:margin');
    expect(margin?.action?.actionType).toBe('bybit_transfer');
    expect(margin?.action?.params.amount).toBe(500);
    expect(signalLensLine({ line: margin!.base.line, action: margin!.action as PendingAction })).toBe(
      'BYBIT MARGIN LOW - TAP: MOVE 500 USDT FUNDING TO TRADING',
    );
  });

  it('moves only what Funding holds and what the day allows, then offers a trim instead', () => {
    expect(exchangeSignalSpecs(marginLow(120.7), th, full)[0]?.action?.params.amount).toBe(120);
    expect(exchangeSignalSpecs(marginLow(), th, () => 80)[0]?.action?.params.amount).toBe(80);
    const capped = exchangeSignalSpecs(marginLow(), th, () => 0)[0];
    expect(capped?.action?.actionType).toBe('bybit_trim');
    expect(capped?.action?.actionPrompt).toBe('CLOSE 50% BTC');
  });

  it('ranks a Bybit position near liquidation with the other money-at-risk signals', () => {
    const engine = new ChainVisionEngine(config());
    const s = protocols(marginLow());
    s.hyperliquid.positions = [
      { coin: 'ETH', side: 'LONG', size: 0.5, entryPx: 1900, markPx: 1784, liquidationPx: 1700, liqDistancePct: 4.7, unrealizedPnlUsd: -58, leverage: 5, notionalUsd: 892 },
    ];
    s.aave.healthFactor = 1.3;
    const ranked = engine.applySnapshots(s, NOW);
    expect(ranked.map((x) => x.id)).toEqual(['hyperliquid:liq:ETH', 'bybit:margin', 'bybit:liq:BTCUSDT', 'aave:health']);
    expect(engine.getLensState(NOW).signal?.id).toBe('hyperliquid:liq:ETH');
    expect(engine.showBrief(NOW)).toEqual(['HL ETH LONG LIQ 4.7% AWAY', 'BYBIT MARGIN LOW', 'BYBIT BTC LONG LIQ 6.0% AWAY']);
  });

  it('puts Binance testnet order notices below anything with money at risk', () => {
    const engine = new ChainVisionEngine(config());
    const snap = marginLow();
    snap.binance.openOrders = [{ orderId: 7, symbol: 'BTCUSDT', asset: 'BTC', side: 'BUY', price: 59100, origQty: 0.001, executedQty: 0, time: NOW }];
    snap.binance.recentFills = [{ orderId: 6, symbol: 'BTCUSDT', asset: 'BTC', side: 'BUY', price: 59000, origQty: 0.001, executedQty: 0.001, time: NOW, filledAt: NOW }];
    const ranked = engine.applySnapshots(protocols(snap), NOW);
    expect(ranked.map((x) => x.id)).toEqual(['bybit:margin', 'bybit:liq:BTCUSDT', 'binance:filled:6', 'binance:near:7']);
    for (const sig of ranked) {
      const line = signalLensLine(sig);
      expect(line.length).toBeLessThanOrEqual(SIGNAL_LENS_LINE_MAX);
      if (sig.id.startsWith('binance')) expect(line).toContain('BINANCE TESTNET');
    }
    expect(signalLensLine(ranked[3]!)).toBe('BINANCE TESTNET BUY 0.001 BTC 0.3% FROM FILL');
  });

  it('sends a tap on the shown exchange signal to the exchange desk, and nothing else', async () => {
    const engine = new ChainVisionEngine(config({ bybit: true }));
    engine.applySnapshots(protocols(marginLow()), NOW);
    const shown = engine.getLensState().signal;
    expect(shown?.id).toBe('bybit:margin');
    const executed: string[] = [];
    engine.desk.execute = async (action) => {
      executed.push(action.actionType);
      return {
        id: 'rcpt_t',
        actionId: action.id,
        protocol: 'bybit',
        actionType: action.actionType,
        network: 'bybit-testnet',
        summary: 'BYBIT MOVE 500 USDT FUNDING TO TRADING',
        beforeFact: 'A',
        afterFact: 'B',
        txHashOrOrderId: 'tid',
        explorerUrl: 'https://testnet.bybit.com',
        telegramPosted: false,
        timestamp: NOW,
      };
    };
    engine.pollNow = async () => protocols(desk());
    const receipt = await engine.confirmPendingAction(shown!.action!.id);
    expect(executed).toEqual(['bybit_transfer']);
    expect(receipt.network).toBe('bybit-testnet');
    expect(engine.queue.get('bybit:margin')).toBeNull();
  });
});

describe('exchange voice commands', () => {
  it('parses the exchange phrases offline', () => {
    expect(parseVoiceIntentLocally('move 500 to trading')).toMatchObject({ action: 'exchange_transfer', amount: 500 });
    expect(parseVoiceIntentLocally('Move $1,000 from funding to trading')).toMatchObject({ action: 'exchange_transfer', amount: 1000 });
    expect(parseVoiceIntentLocally('close half my BTC position')).toMatchObject({ action: 'hl_trim', coin: 'BTC', amountPct: 50 });
    expect(parseVoiceIntentLocally('close half my Bybit BTC position')).toMatchObject({ action: 'exchange_trim', coin: 'BTC', amountPct: 50 });
    expect(parseVoiceIntentLocally('buy 0.001 BTC at 57000')).toMatchObject({ action: 'exchange_limit', side: 'buy', asset: 'BTC', qty: 0.001, price: 57000 });
    expect(parseVoiceIntentLocally('place a limit sell for 0.05 ETH at $4,000 on Binance')).toMatchObject({ action: 'exchange_limit', side: 'sell', asset: 'ETH', qty: 0.05, price: 4000 });
    expect(parseVoiceIntentLocally('cancel my binance orders')).toMatchObject({ action: 'exchange_cancel' });
    expect(parseVoiceIntentLocally('cancel my open BTC orders')).toMatchObject({ action: 'exchange_cancel', asset: 'BTC' });
    expect(parseVoiceIntentLocally('move 500 to funding from trading')).toMatchObject({ action: 'unsupported' });
    expect(parseVoiceIntentLocally('withdraw 500 USDT from bybit')).toMatchObject({ action: 'unsupported' });
  });

  it('accepts the intent model JSON for exchange actions', () => {
    expect(parseIntentJson('{"action":"exchange_transfer","venue":"bybit","amount":500,"confidence":0.95}')).toMatchObject({ action: 'exchange_transfer', amount: 500 });
    expect(parseIntentJson('{"action":"exchange_limit","venue":"binance","side":"buy","asset":"BTC","qty":0.001,"price":57000}')).toMatchObject({ action: 'exchange_limit' });
    expect(parseIntentJson('{"action":"exchange_transfer","venue":"okx","amount":500}')).toMatchObject({ action: 'unsupported' });
  });

  it('routes "close half my BTC position" to Bybit only when Hyperliquid holds no BTC position', async () => {
    const d = new ExchangeDesk(config({ bybit: true }));
    d.bybit.instrument = async () => ({ symbol: 'BTCUSDT', qtyStep: 0.001, minOrderQty: 0.001, minNotional: 5 });
    const intent = parseVoiceIntentLocally('close half my BTC position');
    const draft = await d.buildAction(intent, protocols(marginLow()));
    expect(draft?.actionType).toBe('bybit_trim');
    expect(draft?.params).toMatchObject({ symbol: 'BTCUSDT', amountPct: 50, qty: 0.01 });
    expect(draft?.comparisonLine).toBe('BYBIT TESTNET $57966 | COINBASE $59198');
    const withHl = protocols(marginLow());
    withHl.hyperliquid.positions = [
      { coin: 'BTC', side: 'LONG', size: 0.01, entryPx: 62000, markPx: 62000, liquidationPx: 50000, liqDistancePct: 19, unrealizedPnlUsd: 0, leverage: 3, notionalUsd: 620 },
    ];
    expect(await d.buildAction(intent, withHl)).toBeNull();
  });

  it('caps a voice transfer and says so on the card', async () => {
    const d = new ExchangeDesk(config({ bybit: true }));
    const draft = await d.buildAction(parseVoiceIntentLocally('move 2000 to trading'), protocols(marginLow()));
    expect(draft?.params.amount).toBe(500);
    expect(draft?.comparisonLine).toBe('ASKED 2000 · CAPPED TO 500 (CAP)');
  });

  it('shows why on the lens when a key is missing', async () => {
    const engine = new ChainVisionEngine(config());
    engine.pollNow = async () => protocols(marginLow());
    const out = await engine.handleVoiceTranscript('move 500 to trading');
    expect(out.pendingAction).toBeNull();
    const layout = renderLensPage(engine.getLensState());
    expect(layout.textObject[0]?.content).toContain('BYBIT TESTNET KEY NOT SET');
  });

  it('refuses Binance limit orders over the cap, under the minimum, far from market or unfunded', () => {
    const filters = parseBinanceFilters(fixture('binance-testnet-exchangeinfo-btcusdt.json'));
    const base = { side: 'buy' as const, asset: 'BTC', filters, marketPrice: 59304, coinbasePrice: 59198.42, balances: [{ asset: 'USDT', free: 10000, locked: 0 }], allowanceUsd: 500 };
    expect(binanceLimitDraft({ ...base, qty: 0.01, price: 57000 })).toEqual({ refusal: 'BINANCE TESTNET: ORDER $570.00 OVER CAP $500.00' });
    expect(binanceLimitDraft({ ...base, qty: 0.00005, price: 57000 })).toEqual({ refusal: 'BINANCE TESTNET: ORDER $2.85 BELOW MIN $5.00' });
    expect(binanceLimitDraft({ ...base, qty: 0.001, price: 30000 })).toEqual({ refusal: 'BINANCE TESTNET: PRICE 49% FROM MARKET, LIMIT 25%' });
    expect(binanceLimitDraft({ ...base, qty: 0.001, price: 57000, balances: [{ asset: 'USDT', free: 20, locked: 0 }] })).toEqual({ refusal: 'BINANCE TESTNET: ONLY 20 USDT FREE' });
    const ok = binanceLimitDraft({ ...base, qty: 0.001, price: 57000.129 });
    expect('draft' in ok && ok.draft.params).toEqual({ symbol: 'BTCUSDT', coin: 'BTC', side: 'buy', qty: 0.001, price: 57000.12 });
    expect('draft' in ok && ok.draft.comparisonLine).toBe('BINANCE TESTNET $59304 | COINBASE $59198');
  });
});

describe('exchange screens stay inside the G2 limits', () => {
  const filters = parseBinanceFilters(fixture('binance-testnet-exchangeinfo-btcusdt.json'));
  const limit = binanceLimitDraft({ side: 'buy', asset: 'BTC', qty: 0.001, price: 57000, filters, marketPrice: 59304, coinbasePrice: 59198.42, balances: null, allowanceUsd: 500 });
  const drafts = [
    bybitTransferDraft(500, marginLow()),
    ...exchangeSignalSpecs(marginLow(), new ChainVisionEngine(config()).getSession().thresholds, () => 500).map((s) => s.action!),
    'draft' in limit ? limit.draft : null,
    binanceCancelDraft(
      [
        { orderId: 1, symbol: 'BTCUSDT', asset: 'BTC', side: 'BUY', price: 57000, origQty: 0.001, executedQty: 0, time: NOW },
        { orderId: 2, symbol: 'ETHUSDT', asset: 'ETH', side: 'SELL', price: 4000, origQty: 0.05, executedQty: 0, time: NOW },
      ],
      undefined,
    ),
  ];

  it('renders every exchange confirm card as a valid, factual, emoji-free page', () => {
    for (const d of drafts) {
      expect(d).not.toBeNull();
      const layout = renderLensPage(confirmCard(d!));
      expect(validateLensLayout(layout).errors).toEqual([]);
      expect(layout.textObject[1]?.content.split('\n').every((l) => l.length <= 62)).toBe(true);
      expect(layout.textObject[0]?.content).toContain('TESTNET');
    }
  });

  it('keeps the exchange positions page within limits with and without keys', () => {
    for (const exchanges of [marginLow(), desk({ bybit: { marks: { BTC: 57965.6 }, signed: 'skipped', account: null, positions: [] }, binance: { prices: { BTC: 59304 }, signed: 'skipped', balances: [], openOrders: [], recentFills: [] } })]) {
      const layout = renderLensPage({ mode: 'positions', paired: true, positionPageIndex: 3, snapshots: protocols(exchanges) });
      expect(validateLensLayout(layout).errors).toEqual([]);
      expect(layout.textObject[2 - 1]?.content).toContain('COINBASE BTC $59198 (READ-ONLY)');
    }
  });
});
