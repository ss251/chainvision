import crypto from 'node:crypto';
import path from 'node:path';
import {
  BINANCE_FILL_SIGNAL_MS,
  BINANCE_MAX_PRICE_DEVIATION_PCT,
  BINANCE_NEAR_FILL_PCT,
  BYBIT_DEFAULT_TRIM_PCT,
  BYBIT_MIN_AVAILABLE_USDT,
  BYBIT_MMR_CRITICAL,
  BYBIT_MMR_WARN,
  EXCHANGE_CAPS,
  formatLiqRiskLine,
  twoVenueLine,
  type BinanceBalanceView,
  type BinanceDeskSnapshot,
  type BinanceOrderView,
  type BybitPositionView,
  type ExchangeActionType,
  type ExchangeDeskSnapshot,
  type ExecutionReceipt,
  type PendingAction,
  type ProtocolSnapshots,
  type Signal,
  type UserThresholds,
  type VoiceIntent,
} from '@chainvision/shared';
import type { AppConfig } from '../config.js';
import { BinanceSpotTestnetClient, type BinanceSymbolFilters } from './binance.js';
import { BybitTestnetClient, type BybitInstrument } from './bybit.js';
import { ExchangeCapLedger } from './caps.js';
import { CoinbasePublicClient } from './coinbase.js';
import { floorToStep, stepDecimals } from './signing.js';

export type ActionDraft = Omit<PendingAction, 'id' | 'source' | 'createdAt' | 'expiresAt' | 'requiresTap'>;

export interface SignalSpec {
  base: Pick<Signal, 'id' | 'source' | 'kind' | 'severity' | 'line' | 'lossDistancePct' | 'usdAtRisk'>;
  action: ActionDraft | null;
}

const BYBIT_WEB = 'https://testnet.bybit.com';
const BINANCE_WEB = 'https://testnet.binance.vision';

function usd(n: number): string {
  return '$' + (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function bybitTransferDraft(amount: number, snap: ExchangeDeskSnapshot): ActionDraft {
  const acct = snap.bybit.account;
  const cap = EXCHANGE_CAPS.bybit_transfer;
  return {
    protocol: 'bybit',
    actionType: 'bybit_transfer',
    headline: 'BYBIT TESTNET: MOVE ' + amount + ' USDT FUNDING TO TRADING',
    factLine: acct
      ? 'TRADING FREE ' + usd(acct.tradingAvailableUsd) + ' · MMR ' + (acct.maintenanceMarginRate * 100).toFixed(1) + '% · FUNDING ' + acct.fundingUsdt.toFixed(0) + ' USDT'
      : 'TRADING AND FUNDING BALANCES NOT READ',
    comparisonLine: 'CAP ' + cap.perAction + ' USDT PER ACTION · ' + cap.perDay + ' PER DAY',
    actionPrompt: 'MOVE ' + amount + ' USDT FUNDING TO TRADING',
    params: { tokenIn: 'USDT', amount },
  };
}

export function bybitTrimDraft(p: BybitPositionView, pct: number, snap: ExchangeDeskSnapshot, qty?: number): ActionDraft {
  const liq = p.liqDistancePct !== null ? ' · LIQ ' + p.liqDistancePct.toFixed(1) + '%' : '';
  return {
    protocol: 'bybit',
    actionType: 'bybit_trim',
    headline: 'BYBIT TESTNET: CLOSE ' + pct + '% ' + p.coin + ' ' + p.side + ' (REDUCE-ONLY)',
    factLine:
      qty !== undefined
        ? 'SZ ' + p.size + ' -> ' + Number((p.size - qty).toFixed(8)) + ' ' + p.coin + ' · ' + usd(qty * p.markPx) + liq
        : 'SZ ' + p.size + ' ' + p.coin + ' · MARK ' + usd(p.markPx) + liq,
    comparisonLine: twoVenueLine('BYBIT TESTNET', p.markPx, snap.coinbase.prices[p.coin]),
    actionPrompt: 'CLOSE ' + pct + '% ' + p.coin,
    params: { symbol: p.symbol, coin: p.coin, amountPct: pct, ...(qty !== undefined ? { qty } : {}) },
  };
}

/** Rounds and checks a voice limit order; returns the confirm-card draft or the reason it is refused. */
export function binanceLimitDraft(input: {
  side: 'buy' | 'sell';
  asset: string;
  qty: number;
  price: number;
  filters: BinanceSymbolFilters;
  marketPrice: number | undefined;
  coinbasePrice: number | undefined;
  balances: BinanceBalanceView[] | null;
  allowanceUsd: number;
}): { draft: ActionDraft } | { refusal: string } {
  const { side, asset, filters } = input;
  const price = floorToStep(input.price, filters.tickSize);
  const qty = floorToStep(input.qty, filters.stepSize);
  const notional = qty * price;
  const cap = EXCHANGE_CAPS.binance_limit;
  if (qty <= 0 || qty < filters.minQty) return { refusal: 'BINANCE TESTNET: QTY BELOW MIN ' + filters.minQty + ' ' + asset };
  if (notional < filters.minNotional) return { refusal: 'BINANCE TESTNET: ORDER ' + usd(notional) + ' BELOW MIN ' + usd(filters.minNotional) };
  if (notional > input.allowanceUsd) {
    return {
      refusal:
        input.allowanceUsd < cap.perAction
          ? 'BINANCE TESTNET: DAILY ORDER CAP LEFT ' + usd(input.allowanceUsd)
          : 'BINANCE TESTNET: ORDER ' + usd(notional) + ' OVER CAP ' + usd(cap.perAction),
    };
  }
  if (input.marketPrice && input.marketPrice > 0) {
    const devPct = (Math.abs(price - input.marketPrice) / input.marketPrice) * 100;
    if (devPct > BINANCE_MAX_PRICE_DEVIATION_PCT) {
      return { refusal: 'BINANCE TESTNET: PRICE ' + devPct.toFixed(0) + '% FROM MARKET, LIMIT ' + BINANCE_MAX_PRICE_DEVIATION_PCT + '%' };
    }
  }
  const spendAsset = side === 'buy' ? 'USDT' : asset;
  const free = input.balances?.find((b) => b.asset === spendAsset)?.free;
  if (free !== undefined && free < (side === 'buy' ? notional : qty)) {
    return { refusal: 'BINANCE TESTNET: ONLY ' + free + ' ' + spendAsset + ' FREE' };
  }
  const priceText = price.toFixed(stepDecimals(filters.tickSize));
  const qtyText = qty.toFixed(stepDecimals(filters.stepSize));
  return {
    draft: {
      protocol: 'binance',
      actionType: 'binance_limit',
      headline: 'BINANCE TESTNET: LIMIT ' + side.toUpperCase() + ' ' + Number(qtyText) + ' ' + asset + ' @ ' + Number(priceText),
      factLine:
        usd(notional) + ' · FREE ' + (free !== undefined ? Number(free.toFixed(4)) : 'N/A') + ' ' + spendAsset + ' · CAP ' + usd(cap.perAction),
      comparisonLine: twoVenueLine('BINANCE TESTNET', input.marketPrice, input.coinbasePrice),
      actionPrompt: side.toUpperCase() + ' ' + Number(qtyText) + ' ' + asset,
      params: { symbol: asset + 'USDT', coin: asset, side, qty: Number(qtyText), price: Number(priceText) },
    },
  };
}

export function binanceCancelDraft(orders: BinanceOrderView[], symbol: string | undefined): ActionDraft {
  const counts = new Map<string, number>();
  for (const o of orders) counts.set(o.symbol, (counts.get(o.symbol) ?? 0) + 1);
  const cap = EXCHANGE_CAPS.binance_cancel;
  const n = orders.length;
  return {
    protocol: 'binance',
    actionType: 'binance_cancel',
    headline: 'BINANCE TESTNET: CANCEL ' + n + ' OPEN ORDER' + (n === 1 ? '' : 'S'),
    factLine: [...counts].map(([s, c]) => s + ' ' + c).join(' · '),
    comparisonLine: 'CAP ' + cap.perAction + ' ORDERS PER ACTION · ' + cap.perDay + ' PER DAY',
    actionPrompt: 'CANCEL ' + n + ' ORDER' + (n === 1 ? '' : 'S'),
    params: { ...(symbol ? { symbol } : {}), qty: n },
  };
}

/**
 * Every exchange signal for one round of reads. Bybit: Trading account low on margin (tap moves
 * USDT from Funding, or trims when Funding is empty or capped) and positions near liquidation
 * (tap trims reduce-only). Binance testnet: open orders about to fill and recent fills, read-only.
 */
export function exchangeSignalSpecs(
  snap: ExchangeDeskSnapshot,
  th: UserThresholds,
  allowance: (type: ExchangeActionType) => number,
  liqEtaMinutes?: (p: BybitPositionView) => number | null,
): SignalSpec[] {
  const specs: SignalSpec[] = [];
  const { bybit, binance } = snap;
  const positions = bybit.positions;
  const nearest = positions.reduce<number | null>(
    (min, p) => (p.liqDistancePct === null ? min : min === null ? p.liqDistancePct : Math.min(min, p.liqDistancePct)),
    null,
  );
  const largest = [...positions].sort((a, b) => b.notionalUsd - a.notionalUsd)[0];

  const acct = bybit.account;
  if (acct && largest) {
    const low = acct.tradingAvailableUsd < BYBIT_MIN_AVAILABLE_USDT || acct.maintenanceMarginRate >= BYBIT_MMR_WARN;
    if (low) {
      const critical =
        acct.maintenanceMarginRate >= BYBIT_MMR_CRITICAL || acct.tradingAvailableUsd < BYBIT_MIN_AVAILABLE_USDT / 2;
      const amount = Math.floor(Math.min(acct.fundingUsdt, allowance('bybit_transfer')));
      specs.push({
        base: {
          id: 'bybit:margin',
          source: 'exchange',
          kind: 'margin_low',
          severity: critical ? 'critical' : 'warning',
          line: 'BYBIT MARGIN LOW',
          lossDistancePct: nearest,
          usdAtRisk: acct.tradingEquityUsd,
        },
        action: amount >= 1 ? bybitTransferDraft(amount, snap) : bybitTrimDraft(largest, BYBIT_DEFAULT_TRIM_PCT, snap),
      });
    }
  }

  for (const p of positions) {
    if (p.liqDistancePct === null || p.liqDistancePct >= th.exchangeMinLiqDistancePct) continue;
    const etaMinutes = liqEtaMinutes ? liqEtaMinutes(p) : null;
    specs.push({
      base: {
        id: 'bybit:liq:' + p.symbol,
        source: 'exchange',
        kind: 'liquidation_distance',
        severity: p.liqDistancePct < th.exchangeMinLiqDistancePct / 2 ? 'critical' : 'warning',
        line: formatLiqRiskLine({
          venue: 'BYBIT',
          coin: p.coin,
          side: p.side,
          liqDistancePct: p.liqDistancePct,
          etaMinutes,
        }),
        lossDistancePct: p.liqDistancePct,
        usdAtRisk: p.notionalUsd / Math.max(1, p.leverage),
      },
      action: bybitTrimDraft(p, BYBIT_DEFAULT_TRIM_PCT, snap),
    });
  }

  for (const o of binance.openOrders) {
    const market = binance.prices[o.asset];
    if (!market) continue;
    const dist = (Math.abs(market - o.price) / market) * 100;
    if (dist > BINANCE_NEAR_FILL_PCT) continue;
    specs.push({
      base: {
        id: 'binance:near:' + o.orderId,
        source: 'exchange',
        kind: 'order_near_fill',
        severity: 'notice',
        line: 'BINANCE TESTNET ' + o.side + ' ' + o.origQty + ' ' + o.asset + ' ' + dist.toFixed(1) + '% FROM FILL',
        lossDistancePct: null,
        usdAtRisk: 0,
      },
      action: null,
    });
  }

  for (const f of binance.recentFills) {
    specs.push({
      base: {
        id: 'binance:filled:' + f.orderId,
        source: 'exchange',
        kind: 'order_filled',
        severity: 'notice',
        line: 'BINANCE TESTNET FILLED ' + f.side + ' ' + f.origQty + ' ' + f.asset + ' @ ' + f.price,
        lossDistancePct: null,
        usdAtRisk: 0,
      },
      action: null,
    });
  }

  return specs;
}

/** Bybit and Binance testnet accounts plus Coinbase public prices, as one source of signals and tap actions. */
export class ExchangeDesk {
  readonly bybit: BybitTestnetClient;
  readonly binance: BinanceSpotTestnetClient;
  readonly coinbase: CoinbasePublicClient;
  readonly ledger: ExchangeCapLedger;
  private lastOpenOrders: Map<number, BinanceOrderView> | null = null;
  private fills: Array<BinanceOrderView & { filledAt: number }> = [];
  private refusal: string | null = null;
  private instruments = new Map<string, BybitInstrument>();
  private filters = new Map<string, BinanceSymbolFilters>();

  constructor(config: AppConfig, options: { stateFile?: string | null } = {}) {
    this.bybit = new BybitTestnetClient(config);
    this.binance = new BinanceSpotTestnetClient(config);
    this.coinbase = new CoinbasePublicClient();
    this.ledger = new ExchangeCapLedger(
      options.stateFile ? path.join(path.dirname(options.stateFile), 'exchange-ledger.json') : null,
    );
  }

  async readSnapshot(now = Date.now()): Promise<ExchangeDeskSnapshot> {
    const [bybit, binance, coinbase] = await Promise.all([
      this.bybit.readSnapshot(),
      this.readBinance(now),
      this.coinbase.readSnapshot(),
    ]);
    return { updatedAt: now, bybit, binance, coinbase };
  }

  private async readBinance(now: number): Promise<BinanceDeskSnapshot> {
    let prices: Record<string, number> = {};
    try {
      prices = await this.binance.readPrices();
    } catch (err) {
      return { prices, signed: 'error', balances: [], openOrders: [], recentFills: this.fills, error: errMsg(err) };
    }
    if (!this.binance.hasKey) return { prices, signed: 'skipped', balances: [], openOrders: [], recentFills: [] };
    try {
      const [balances, openOrders] = await Promise.all([this.binance.readBalances(), this.binance.readOpenOrders()]);
      const current = new Map(openOrders.map((o) => [o.orderId, o]));
      if (this.lastOpenOrders) {
        for (const [id, o] of this.lastOpenOrders) {
          if (current.has(id)) continue;
          const status = await this.binance.orderStatus(o.symbol, id).catch(() => 'UNKNOWN');
          if (status === 'FILLED') this.fills.push({ ...o, filledAt: now });
        }
      }
      this.lastOpenOrders = current;
      this.fills = this.fills.filter((f) => now - f.filledAt < BINANCE_FILL_SIGNAL_MS);
      return { prices, signed: 'ok', balances, openOrders, recentFills: this.fills };
    } catch (err) {
      return { prices, signed: 'error', balances: [], openOrders: [], recentFills: this.fills, error: errMsg(err) };
    }
  }

  signalSpecs(
    snap: ExchangeDeskSnapshot,
    th: UserThresholds,
    now = Date.now(),
    liqEtaMinutes?: (p: BybitPositionView) => number | null,
  ): SignalSpec[] {
    return exchangeSignalSpecs(snap, th, (t) => this.ledger.allowance(t, now), liqEtaMinutes);
  }

  /** Why the last voice command could not become an exchange card, once. */
  takeRefusal(): string | null {
    const r = this.refusal;
    this.refusal = null;
    return r;
  }

  private refuse(reason: string): null {
    this.refusal = reason;
    return null;
  }

  private async instrument(symbol: string): Promise<BybitInstrument> {
    const cached = this.instruments.get(symbol);
    if (cached) return cached;
    const inst = await this.bybit.instrument(symbol);
    this.instruments.set(symbol, inst);
    return inst;
  }

  async binanceFilters(symbol: string): Promise<BinanceSymbolFilters> {
    const cached = this.filters.get(symbol);
    if (cached) return cached;
    const f = await this.binance.symbolFilters(symbol);
    this.filters.set(symbol, f);
    return f;
  }

  /** Reduce-only quantity for a trim: the share of the position, rounded down to the lot step, cut to the cap. */
  private async trimQty(p: BybitPositionView, pct: number, limitQty?: number): Promise<{ qty: number; inst: BybitInstrument }> {
    const inst = await this.instrument(p.symbol);
    let qty = floorToStep((p.size * pct) / 100, inst.qtyStep);
    if (limitQty !== undefined) qty = Math.min(qty, limitQty);
    const allowance = this.ledger.allowance('bybit_trim');
    if (qty * p.markPx > allowance) qty = floorToStep(allowance / p.markPx, inst.qtyStep);
    return { qty, inst };
  }

  /**
   * Confirm card for a voice command that targets an exchange, or null. A generic "close half my BTC
   * position" goes to Bybit only when Hyperliquid holds no such position and Bybit does.
   */
  async buildAction(intent: VoiceIntent, protocols: ProtocolSnapshots): Promise<ActionDraft | null> {
    this.refusal = null;
    const isExchange =
      intent.action === 'exchange_transfer' ||
      intent.action === 'exchange_trim' ||
      intent.action === 'exchange_limit' ||
      intent.action === 'exchange_cancel';
    if (!isExchange && (intent.action !== 'hl_trim' || !protocols.exchanges)) return null;
    const snap = protocols.exchanges ?? (await this.readSnapshot());

    if (intent.action === 'hl_trim' || intent.action === 'exchange_trim') {
      const p = snap.bybit.positions.find((x) => x.coin === intent.coin);
      if (intent.action === 'hl_trim' && (!p || protocols.hyperliquid.positions.some((h) => h.coin === intent.coin))) {
        return null;
      }
      if (!this.bybit.hasKey) return this.refuse('BYBIT TESTNET KEY NOT SET');
      if (!p) return this.refuse('NO BYBIT TESTNET ' + intent.coin + ' POSITION');
      const { qty, inst } = await this.trimQty(p, intent.amountPct);
      if (qty < inst.minOrderQty) return this.refuse('BYBIT TRIM BELOW MIN ' + inst.minOrderQty + ' ' + p.coin + ' OR CAP USED');
      return bybitTrimDraft(p, intent.amountPct, snap, qty);
    }

    if (intent.action === 'exchange_transfer') {
      if (!this.bybit.hasKey) return this.refuse('BYBIT TESTNET KEY NOT SET');
      const allowance = this.ledger.allowance('bybit_transfer');
      if (allowance < 1) return this.refuse('BYBIT DAILY TRANSFER CAP REACHED');
      const funding = snap.bybit.account?.fundingUsdt;
      if (funding !== undefined && funding < 1) return this.refuse('BYBIT FUNDING ACCOUNT IS EMPTY');
      const amount = Math.floor(Math.min(intent.amount, allowance, funding ?? Infinity));
      const draft = bybitTransferDraft(amount, snap);
      if (amount < intent.amount) {
        draft.comparisonLine =
          'ASKED ' + intent.amount + ' · CAPPED TO ' + amount + (funding !== undefined && amount === Math.floor(funding) ? ' (FUNDING)' : ' (CAP)');
      }
      return draft;
    }

    if (intent.action === 'exchange_limit') {
      if (!this.binance.hasKey) return this.refuse('BINANCE TESTNET KEY NOT SET');
      const filters = await this.binanceFilters(intent.asset + 'USDT');
      const res = binanceLimitDraft({
        side: intent.side,
        asset: intent.asset,
        qty: intent.qty,
        price: intent.price,
        filters,
        marketPrice: snap.binance.prices[intent.asset],
        coinbasePrice: snap.coinbase.prices[intent.asset],
        balances: snap.binance.signed === 'ok' ? snap.binance.balances : null,
        allowanceUsd: this.ledger.allowance('binance_limit'),
      });
      return 'draft' in res ? res.draft : this.refuse(res.refusal);
    }

    if (!this.binance.hasKey) return this.refuse('BINANCE TESTNET KEY NOT SET');
    const symbol = intent.asset ? intent.asset + 'USDT' : undefined;
    const orders = (await this.binance.readOpenOrders()).filter((o) => !symbol || o.symbol === symbol);
    if (orders.length === 0) return this.refuse('NO OPEN BINANCE TESTNET ORDERS');
    if (orders.length > this.ledger.allowance('binance_cancel')) {
      return this.refuse('BINANCE CANCEL CAP: ' + orders.length + ' ORDERS OPEN');
    }
    return binanceCancelDraft(orders, symbol);
  }

  /** Runs one tapped exchange action. Caps are checked again here against live balances, never trusted from the card. */
  async execute(action: PendingAction): Promise<ExecutionReceipt> {
    const base = {
      id: 'rcpt_' + crypto.randomBytes(4).toString('hex'),
      actionId: action.id,
      actionType: action.actionType,
      telegramPosted: false,
    };

    if (action.actionType === 'bybit_transfer') {
      const amount = Math.floor(action.params.amount ?? 0);
      this.ledger.check('bybit_transfer', amount);
      const before = await this.bybit.readAccount();
      if (before.fundingUsdt < amount) throw new Error('Bybit Funding has only ' + before.fundingUsdt + ' USDT');
      const res = await this.bybit.transferFundingToTrading(amount);
      if (res.status === 'FAILED') throw new Error('Bybit transfer ' + res.transferId + ' failed');
      this.ledger.record('bybit_transfer', amount, res.transferId);
      const after = await this.bybit.readAccount().catch(() => null);
      const fact = (a: { tradingAvailableUsd: number; fundingUsdt: number }) =>
        'TRADING FREE ' + usd(a.tradingAvailableUsd) + ' · FUNDING ' + a.fundingUsdt.toFixed(0);
      return {
        ...base,
        protocol: 'bybit',
        network: 'bybit-testnet',
        summary: 'BYBIT MOVE ' + amount + ' USDT FUNDING TO TRADING',
        beforeFact: fact(before),
        afterFact: after ? fact(after) : 'TRANSFER ' + res.status,
        txHashOrOrderId: res.transferId,
        explorerUrl: BYBIT_WEB,
        timestamp: Date.now(),
      };
    }

    if (action.actionType === 'bybit_trim') {
      const symbol = action.params.symbol ?? '';
      const pct = action.params.amountPct ?? BYBIT_DEFAULT_TRIM_PCT;
      const p = (await this.bybit.readPositions()).find((x) => x.symbol === symbol);
      if (!p) throw new Error('No open Bybit testnet position on ' + symbol);
      const { qty, inst } = await this.trimQty(p, pct, action.params.qty);
      if (qty < inst.minOrderQty) throw new Error('Trim ' + qty + ' is below Bybit minimum ' + inst.minOrderQty + ' or the cap is used');
      const notional = qty * p.markPx;
      this.ledger.check('bybit_trim', notional);
      const side = p.side === 'LONG' ? 'Sell' : 'Buy';
      const order = await this.bybit.placeMarketOrder({
        symbol,
        side,
        qty: qty.toFixed(stepDecimals(inst.qtyStep)),
        reduceOnly: true,
        positionIdx: p.positionIdx,
      });
      this.ledger.record('bybit_trim', notional, order.orderId);
      const after = await this.bybit.readPositions().catch(() => null);
      const afterSize = after ? (after.find((x) => x.symbol === symbol)?.size ?? 0) : null;
      return {
        ...base,
        protocol: 'bybit',
        network: 'bybit-testnet',
        summary: 'BYBIT REDUCE-ONLY ' + side.toUpperCase() + ' ' + qty + ' ' + p.coin,
        beforeFact: 'SZ ' + p.size,
        afterFact: afterSize !== null ? 'SZ ' + afterSize : 'ORDER SENT',
        txHashOrOrderId: order.orderId,
        explorerUrl: BYBIT_WEB,
        timestamp: Date.now(),
      };
    }

    if (action.actionType === 'binance_limit') {
      const symbol = action.params.symbol ?? '';
      const asset = symbol.replace(/USDT$/, '');
      const [filters, prices, balances] = await Promise.all([
        this.binanceFilters(symbol),
        this.binance.readPrices(),
        this.binance.readBalances(),
      ]);
      const check = binanceLimitDraft({
        side: action.params.side ?? 'buy',
        asset,
        qty: action.params.qty ?? 0,
        price: action.params.price ?? 0,
        filters,
        marketPrice: prices[asset],
        coinbasePrice: undefined,
        balances,
        allowanceUsd: this.ledger.allowance('binance_limit'),
      });
      if ('refusal' in check) throw new Error(check.refusal);
      const { qty = 0, price = 0, side = 'buy' } = check.draft.params;
      const notional = qty * price;
      this.ledger.check('binance_limit', notional);
      const order = await this.binance.placeLimitOrder({
        symbol,
        side: side === 'buy' ? 'BUY' : 'SELL',
        quantity: qty.toFixed(stepDecimals(filters.stepSize)),
        price: price.toFixed(stepDecimals(filters.tickSize)),
      });
      this.ledger.record('binance_limit', notional, String(order.orderId));
      const quote = balances.find((b) => b.asset === (side === 'buy' ? 'USDT' : asset));
      return {
        ...base,
        protocol: 'binance',
        network: 'binance-spot-testnet',
        summary: 'BINANCE TESTNET LIMIT ' + side.toUpperCase() + ' ' + qty + ' ' + asset + ' @ ' + price,
        beforeFact: 'FREE ' + (quote?.free ?? 0) + ' ' + (quote?.asset ?? 'USDT'),
        afterFact: 'ORDER ' + order.status,
        txHashOrOrderId: String(order.orderId),
        explorerUrl: BINANCE_WEB,
        timestamp: Date.now(),
      };
    }

    if (action.actionType === 'binance_cancel') {
      const open = await this.binance.readOpenOrders();
      const targets = open.filter((o) => !action.params.symbol || o.symbol === action.params.symbol);
      if (targets.length === 0) throw new Error('No open Binance testnet orders to cancel');
      this.ledger.check('binance_cancel', targets.length);
      const ids: number[] = [];
      for (const symbol of new Set(targets.map((o) => o.symbol))) ids.push(...(await this.binance.cancelOpenOrders(symbol)));
      this.ledger.record('binance_cancel', ids.length, ids.join(','));
      this.lastOpenOrders = null;
      return {
        ...base,
        protocol: 'binance',
        network: 'binance-spot-testnet',
        summary: 'BINANCE TESTNET CANCEL ' + ids.length + ' ORDER' + (ids.length === 1 ? '' : 'S'),
        beforeFact: open.length + ' OPEN',
        afterFact: open.length - ids.length + ' OPEN',
        txHashOrOrderId: ids.join(','),
        explorerUrl: BINANCE_WEB,
        timestamp: Date.now(),
      };
    }

    throw new Error('Not an exchange action: ' + action.actionType);
  }
}
