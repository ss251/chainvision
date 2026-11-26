import crypto from 'node:crypto';
import {
  BINANCE_ASSETS,
  BINANCE_SPOT_TESTNET_URL,
  type BinanceBalanceView,
  type BinanceOrderView,
} from '@chainvision/shared';
import type { AppConfig } from '../config.js';
import { assertExchangeHost, binanceQuery, binanceSign } from './signing.js';

export interface BinanceSymbolFilters {
  symbol: string;
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function parseBinancePrices(json: Array<{ symbol: string; price: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of json) {
    if (row.symbol.endsWith('USDT') && num(row.price) > 0) out[row.symbol.slice(0, -4)] = num(row.price);
  }
  return out;
}

export function parseBinanceFilters(json: {
  symbols?: Array<{ symbol: string; filters: Array<Record<string, string>> }>;
}): BinanceSymbolFilters {
  const s = json.symbols?.[0];
  if (!s) throw new Error('Binance symbol not found');
  const f = (type: string) => s.filters.find((x) => x.filterType === type) ?? {};
  return {
    symbol: s.symbol,
    tickSize: num(f('PRICE_FILTER').tickSize),
    stepSize: num(f('LOT_SIZE').stepSize),
    minQty: num(f('LOT_SIZE').minQty),
    minNotional: num(f('NOTIONAL').minNotional ?? f('MIN_NOTIONAL').minNotional),
  };
}

export function parseBinanceOrders(
  json: Array<{ orderId: number; symbol: string; side: string; price: string; origQty: string; executedQty: string; time: number }>,
): BinanceOrderView[] {
  return json.map((o) => ({
    orderId: o.orderId,
    symbol: o.symbol,
    asset: o.symbol.replace(/USDT$/, ''),
    side: o.side === 'SELL' ? 'SELL' : 'BUY',
    price: num(o.price),
    origQty: num(o.origQty),
    executedQty: num(o.executedQty),
    time: o.time,
  }));
}

/** Binance spot testnet client: public prices and filters, signed balances and orders, limit orders and cancels. No transfer endpoints exist on this testnet. */
export class BinanceSpotTestnetClient {
  private clockOffsetMs: number | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly baseUrl: string = BINANCE_SPOT_TESTNET_URL,
  ) {
    assertExchangeHost(baseUrl, true);
  }

  get hasKey(): boolean {
    return Boolean(this.config.binanceTestnetApiKey && this.config.binanceTestnetApiSecret);
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, string | number>,
    signed: boolean,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    let query = binanceQuery(params);
    if (signed) {
      const key = this.config.binanceTestnetApiKey;
      const secret = this.config.binanceTestnetApiSecret;
      if (!key || !secret) throw new Error('BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET not configured');
      const timestamp = Date.now() + (await this.clockOffset());
      query = binanceQuery({ ...params, recvWindow: 5000, timestamp });
      query += '&signature=' + binanceSign(secret, query);
      headers['X-MBX-APIKEY'] = key;
    }
    const url = this.baseUrl + path + (query ? '?' + query : '');
    assertExchangeHost(url, signed);
    const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(10_000) });
    const json = (await res.json()) as T | { code: number; msg: string };
    if (!res.ok) {
      const e = json as { code?: number; msg?: string };
      throw new Error('Binance ' + path + ': HTTP ' + res.status + ' ' + (e.code ?? '') + ' ' + (e.msg ?? ''));
    }
    return json as T;
  }

  private async clockOffset(): Promise<number> {
    if (this.clockOffsetMs === null) this.clockOffsetMs = (await this.serverTime()) - Date.now();
    return this.clockOffsetMs;
  }

  async serverTime(): Promise<number> {
    return (await this.request<{ serverTime: number }>('GET', '/api/v3/time', {}, false)).serverTime;
  }

  async readPrices(): Promise<Record<string, number>> {
    const symbols = JSON.stringify(BINANCE_ASSETS.map((a) => a + 'USDT'));
    return parseBinancePrices(await this.request('GET', '/api/v3/ticker/price', { symbols }, false));
  }

  async symbolFilters(symbol: string): Promise<BinanceSymbolFilters> {
    return parseBinanceFilters(await this.request('GET', '/api/v3/exchangeInfo', { symbol }, false));
  }

  async readBalances(): Promise<BinanceBalanceView[]> {
    const acct = await this.request<{ balances?: Array<{ asset: string; free: string; locked: string }> }>(
      'GET',
      '/api/v3/account',
      { omitZeroBalances: 'true' },
      true,
    );
    return (acct.balances ?? []).map((b) => ({ asset: b.asset, free: num(b.free), locked: num(b.locked) }));
  }

  async readOpenOrders(): Promise<BinanceOrderView[]> {
    return parseBinanceOrders(await this.request('GET', '/api/v3/openOrders', {}, true));
  }

  async orderStatus(symbol: string, orderId: number): Promise<string> {
    return (await this.request<{ status: string }>('GET', '/api/v3/order', { symbol, orderId }, true)).status;
  }

  async placeLimitOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    quantity: string;
    price: string;
  }): Promise<{ orderId: number; status: string; clientOrderId: string }> {
    const newClientOrderId = 'cv-' + crypto.randomBytes(6).toString('hex');
    const res = await this.request<{ orderId: number; status: string; clientOrderId: string }>(
      'POST',
      '/api/v3/order',
      {
        symbol: params.symbol,
        side: params.side,
        type: 'LIMIT',
        timeInForce: 'GTC',
        quantity: params.quantity,
        price: params.price,
        newClientOrderId,
      },
      true,
    );
    return { orderId: res.orderId, status: res.status, clientOrderId: res.clientOrderId };
  }

  /** Cancels every open order on one symbol and returns the cancelled order ids. */
  async cancelOpenOrders(symbol: string): Promise<number[]> {
    const res = await this.request<Array<{ orderId?: number }>>('DELETE', '/api/v3/openOrders', { symbol }, true);
    return res.map((o) => o.orderId).filter((id): id is number => typeof id === 'number');
  }
}
