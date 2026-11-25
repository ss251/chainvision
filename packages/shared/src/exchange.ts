import { z } from 'zod';
import type { VoiceIntent } from './intent.js';

/** Hosts the exchange clients may call: testnets for every write, Coinbase public market data read-only. */
export const BYBIT_TESTNET_URL = 'https://api-testnet.bybit.com' as const;
export const BINANCE_SPOT_TESTNET_URL = 'https://testnet.binance.vision' as const;
export const COINBASE_PUBLIC_URL = 'https://api.exchange.coinbase.com' as const;

export type ExchangeActionType = 'bybit_transfer' | 'bybit_trim' | 'binance_limit' | 'binance_cancel';
export type ExchangeSignalKind = 'margin_low' | 'order_near_fill' | 'order_filled';

export const EXCHANGE_ACTION_TYPES: readonly ExchangeActionType[] = [
  'bybit_transfer',
  'bybit_trim',
  'binance_limit',
  'binance_cancel',
];

export function isExchangeActionType(t: string): t is ExchangeActionType {
  return (EXCHANGE_ACTION_TYPES as readonly string[]).includes(t);
}

/**
 * Hard limits for every exchange write, per action and per rolling 24 hours.
 * Transfers, trims and limit orders are measured in USD notional; cancels in orders.
 */
export const EXCHANGE_CAPS: Record<ExchangeActionType, { perAction: number; perDay: number; unit: 'USD' | 'ORDERS' }> = {
  bybit_transfer: { perAction: 500, perDay: 1500, unit: 'USD' },
  bybit_trim: { perAction: 1000, perDay: 3000, unit: 'USD' },
  binance_limit: { perAction: 500, perDay: 1500, unit: 'USD' },
  binance_cancel: { perAction: 10, perDay: 50, unit: 'ORDERS' },
};

/** The Bybit Trading account counts as low on margin below this available balance or at these maintenance margin rates. */
export const BYBIT_MIN_AVAILABLE_USDT = 250;
export const BYBIT_MMR_WARN = 0.3;
export const BYBIT_MMR_CRITICAL = 0.6;
/** Share of a position a tap trims when a Bybit position nears liquidation. */
export const BYBIT_DEFAULT_TRIM_PCT = 50;
/** A Binance testnet open order this close to the market raises a notice. */
export const BINANCE_NEAR_FILL_PCT = 0.5;
/** A filled Binance testnet order stays in the queue this long. */
export const BINANCE_FILL_SIGNAL_MS = 10 * 60_000;
/** Voice limit orders priced further than this from the testnet market are refused. */
export const BINANCE_MAX_PRICE_DEVIATION_PCT = 25;

export const EXCHANGE_COINS = ['BTC', 'ETH', 'SOL'] as const;
export const BINANCE_ASSETS = ['BTC', 'ETH', 'BNB', 'SOL'] as const;
export type ExchangeCoin = (typeof EXCHANGE_COINS)[number];
export type BinanceAsset = (typeof BINANCE_ASSETS)[number];

/** Where a signed read stands: done, skipped because no key is configured, or failed. */
export type SignedReadStatus = 'ok' | 'skipped' | 'error';

export interface BybitAccountView {
  /** Trading (Unified) account equity and the part free to hold positions, in USD. */
  tradingEquityUsd: number;
  tradingAvailableUsd: number;
  /** Account maintenance margin rate, 0..1; liquidation happens at 1. */
  maintenanceMarginRate: number;
  /** USDT in the Funding account that can be moved now. */
  fundingUsdt: number;
}

export interface BybitPositionView {
  symbol: string;
  coin: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPx: number;
  markPx: number;
  liqPx: number | null;
  liqDistancePct: number | null;
  notionalUsd: number;
  unrealizedPnlUsd: number;
  leverage: number;
  positionIdx: number;
}

export interface BybitDeskSnapshot {
  marks: Record<string, number>;
  signed: SignedReadStatus;
  account: BybitAccountView | null;
  positions: BybitPositionView[];
  error?: string;
}

export interface BinanceOrderView {
  orderId: number;
  symbol: string;
  asset: string;
  side: 'BUY' | 'SELL';
  price: number;
  origQty: number;
  executedQty: number;
  time: number;
}

export interface BinanceBalanceView {
  asset: string;
  free: number;
  locked: number;
}

export interface BinanceDeskSnapshot {
  prices: Record<string, number>;
  signed: SignedReadStatus;
  balances: BinanceBalanceView[];
  openOrders: BinanceOrderView[];
  /** Orders seen open earlier that the testnet now reports FILLED, kept for BINANCE_FILL_SIGNAL_MS. */
  recentFills: Array<BinanceOrderView & { filledAt: number }>;
  error?: string;
}

export interface CoinbaseSnapshot {
  /** Public Coinbase Exchange last trade prices in USD (read-only, no key). */
  prices: Record<string, number>;
  error?: string;
}

export interface ExchangeDeskSnapshot {
  updatedAt: number;
  bybit: BybitDeskSnapshot;
  binance: BinanceDeskSnapshot;
  coinbase: CoinbaseSnapshot;
}

/** Two venues' prices on one confirm-card line, e.g. "BINANCE TESTNET $59356 | COINBASE $59268". */
export function twoVenueLine(venueLabel: string, venuePrice: number | undefined, coinbasePrice: number | undefined): string {
  const fmt = (p: number | undefined) => (p && p > 0 ? '$' + (p >= 1000 ? p.toFixed(0) : p.toFixed(2)) : 'N/A');
  return venueLabel + ' ' + fmt(venuePrice) + ' | COINBASE ' + fmt(coinbasePrice);
}

const confidence = z.number().min(0).max(1).default(0.9);

export const EXCHANGE_INTENT_SCHEMAS = [
  z.object({
    action: z.literal('exchange_transfer'),
    venue: z.literal('bybit').default('bybit'),
    amount: z.number().positive(),
    confidence,
  }),
  z.object({
    action: z.literal('exchange_trim'),
    venue: z.literal('bybit').default('bybit'),
    coin: z.enum(EXCHANGE_COINS),
    amountPct: z.number().min(1).max(100),
    confidence,
  }),
  z.object({
    action: z.literal('exchange_limit'),
    venue: z.literal('binance').default('binance'),
    side: z.enum(['buy', 'sell']),
    asset: z.enum(BINANCE_ASSETS),
    qty: z.number().positive(),
    price: z.number().positive(),
    confidence,
  }),
  z.object({
    action: z.literal('exchange_cancel'),
    venue: z.literal('binance').default('binance'),
    asset: z.enum(BINANCE_ASSETS).optional(),
    confidence,
  }),
] as const;

export const EXCHANGE_INTENT_PROMPT = `9) {"action":"exchange_transfer","venue":"bybit","amount":<number>,"confidence":0.95}
   Use for moving USDT inside Bybit testnet from the Funding account to the Trading account: "move 500 to trading", "top up my Bybit margin with 300". Only Funding to Trading is supported.
10) {"action":"exchange_trim","venue":"bybit","coin":"BTC"|"ETH"|"SOL","amountPct":<1..100>,"confidence":0.95}
   Use only when the user names Bybit: "close half my Bybit BTC position" (amountPct:50). Without a named venue use hl_trim.
11) {"action":"exchange_limit","venue":"binance","side":"buy"|"sell","asset":"BTC"|"ETH"|"BNB"|"SOL","qty":<number>,"price":<number>,"confidence":0.95}
   Use for limit orders: "buy 0.001 BTC at 57000", "place a limit sell for 0.05 ETH at 4000 on Binance".
12) {"action":"exchange_cancel","venue":"binance","asset":"BTC"|"ETH"|"BNB"|"SOL" (optional),"confidence":0.95}
   Use for: "cancel my Binance orders", "cancel my open BTC orders".`;

function coinIn(text: string): ExchangeCoin | null {
  if (/\b(btc|bitcoin)\b/.test(text)) return 'BTC';
  if (/\b(sol|solana)\b/.test(text)) return 'SOL';
  if (/\b(eth|ether|ethereum)\b/.test(text)) return 'ETH';
  return null;
}

function pctIn(text: string): number {
  if (/\b(all|full|entire|whole)\b/.test(text)) return 100;
  if (/\bhalf\b/.test(text)) return 50;
  if (/\bquarter\b/.test(text)) return 25;
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)/);
  const v = m?.[1] ? Number(m[1]) : NaN;
  return v >= 1 && v <= 100 ? v : 50;
}

/** Rule-based parser for exchange commands; null when the transcript is not one. */
export function parseExchangeIntentLocally(lower: string): VoiceIntent | null {
  const text = lower.replace(/,/g, '');

  if (/\b(move|transfer|top up|top-up|add)\b/.test(text) && /\b(trading|margin|unified)\b/.test(text)) {
    if (/\b(to|into)\s+(?:my\s+)?(funding|spot)\b/.test(text)) {
      return { action: 'unsupported', reason: 'Only Bybit Funding to Trading transfers are supported', confidence: 0.9 };
    }
    const m = text.match(/\$?(\d+(?:\.\d+)?)/);
    const amount = m?.[1] ? Number(m[1]) : NaN;
    if (!Number.isFinite(amount) || amount <= 0) {
      return { action: 'unsupported', reason: 'Say how much USDT to move to Trading', confidence: 0.9 };
    }
    return { action: 'exchange_transfer', venue: 'bybit', amount, confidence: 0.92 };
  }

  if (/\bbybit\b/.test(text) && /\b(trim|reduce|close|cut)\b/.test(text)) {
    return { action: 'exchange_trim', venue: 'bybit', coin: coinIn(text) ?? 'BTC', amountPct: pctIn(text), confidence: 0.92 };
  }

  if (/\bcancel\b/.test(text) && /\borders?\b/.test(text)) {
    const asset = /\bbnb\b/.test(text) ? 'BNB' : (coinIn(text) ?? undefined);
    return asset
      ? { action: 'exchange_cancel', venue: 'binance', asset, confidence: 0.92 }
      : { action: 'exchange_cancel', venue: 'binance', confidence: 0.92 };
  }

  const limit = text.match(
    /\b(buy|sell)(?:\s+order)?\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*(btc|bitcoin|eth|ether|ethereum|bnb|sol|solana)\b.*?(?:\bat\b|@)\s*\$?(\d+(?:\.\d+)?)/,
  );
  if (limit?.[1] && limit[2] && limit[3] && limit[4]) {
    return {
      action: 'exchange_limit',
      venue: 'binance',
      side: limit[1] as 'buy' | 'sell',
      asset: limit[3] === 'bnb' ? 'BNB' : (coinIn(limit[3]) ?? 'BTC'),
      qty: Number(limit[2]),
      price: Number(limit[4]),
      confidence: 0.92,
    };
  }

  return null;
}
