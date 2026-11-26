import crypto from 'node:crypto';
import {
  BYBIT_TESTNET_URL,
  EXCHANGE_COINS,
  type BybitAccountView,
  type BybitDeskSnapshot,
  type BybitPositionView,
} from '@chainvision/shared';
import type { AppConfig } from '../config.js';
import { assertExchangeHost, bybitSign } from './signing.js';

const RECV_WINDOW = '5000';

interface BybitEnvelope<T> {
  retCode: number;
  retMsg: string;
  result: T;
  time?: number;
}

export interface BybitInstrument {
  symbol: string;
  qtyStep: number;
  minOrderQty: number;
  minNotional: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function parseBybitMark(json: BybitEnvelope<{ list?: Array<{ markPrice?: string }> }>): number {
  return num(json.result?.list?.[0]?.markPrice);
}

export function parseBybitInstrument(
  json: BybitEnvelope<{ list?: Array<{ symbol: string; lotSizeFilter?: Record<string, string> }> }>,
): BybitInstrument {
  const item = json.result?.list?.[0];
  if (!item?.lotSizeFilter) throw new Error('Bybit instrument not found');
  return {
    symbol: item.symbol,
    qtyStep: num(item.lotSizeFilter.qtyStep),
    minOrderQty: num(item.lotSizeFilter.minOrderQty),
    minNotional: num(item.lotSizeFilter.minNotionalValue),
  };
}

export function parseBybitWallet(json: BybitEnvelope<{ list?: Array<Record<string, unknown>> }>): {
  tradingEquityUsd: number;
  tradingAvailableUsd: number;
  maintenanceMarginRate: number;
} {
  const acct = json.result?.list?.[0];
  if (!acct) throw new Error('Bybit wallet-balance returned no Unified account');
  return {
    tradingEquityUsd: num(acct.totalEquity),
    tradingAvailableUsd: num(acct.totalAvailableBalance),
    maintenanceMarginRate: num(acct.accountMMRate),
  };
}

export function parseBybitFundingUsdt(
  json: BybitEnvelope<{ balance?: Array<{ coin: string; transferBalance?: string; walletBalance?: string }> }>,
): number {
  const usdt = json.result?.balance?.find((b) => b.coin === 'USDT');
  return num(usdt?.transferBalance ?? usdt?.walletBalance);
}

export function parseBybitPositions(json: BybitEnvelope<{ list?: Array<Record<string, string | number>> }>): BybitPositionView[] {
  return (json.result?.list ?? [])
    .filter((p) => num(p.size) > 0 && (p.side === 'Buy' || p.side === 'Sell'))
    .map((p) => {
      const markPx = num(p.markPrice);
      const liqPx = num(p.liqPrice) > 0 ? num(p.liqPrice) : null;
      const symbol = String(p.symbol);
      return {
        symbol,
        coin: symbol.replace(/USDT$/, ''),
        side: p.side === 'Buy' ? 'LONG' : 'SHORT',
        size: num(p.size),
        entryPx: num(p.avgPrice),
        markPx,
        liqPx,
        liqDistancePct: liqPx !== null && markPx > 0 ? (Math.abs(markPx - liqPx) / markPx) * 100 : null,
        notionalUsd: num(p.positionValue) || num(p.size) * markPx,
        unrealizedPnlUsd: num(p.unrealisedPnl),
        leverage: num(p.leverage),
        positionIdx: num(p.positionIdx),
      } satisfies BybitPositionView;
    });
}

/** Bybit testnet V5 client: public market reads, signed account reads, Funding-to-Trading transfer and reduce-only orders. */
export class BybitTestnetClient {
  private clockOffsetMs: number | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly baseUrl: string = BYBIT_TESTNET_URL,
  ) {
    assertExchangeHost(baseUrl, true);
  }

  get hasKey(): boolean {
    return Boolean(this.config.bybitTestnetApiKey && this.config.bybitTestnetApiSecret);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, params: Record<string, string> | object, signed: boolean): Promise<T> {
    const query = method === 'GET' ? new URLSearchParams(params as Record<string, string>).toString() : '';
    const body = method === 'POST' ? JSON.stringify(params) : undefined;
    const url = this.baseUrl + path + (query ? '?' + query : '');
    assertExchangeHost(url, signed);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (signed) {
      const key = this.config.bybitTestnetApiKey;
      const secret = this.config.bybitTestnetApiSecret;
      if (!key || !secret) throw new Error('BYBIT_TESTNET_API_KEY / BYBIT_TESTNET_API_SECRET not configured');
      const timestamp = String(Date.now() + (await this.clockOffset()));
      headers['X-BAPI-API-KEY'] = key;
      headers['X-BAPI-TIMESTAMP'] = timestamp;
      headers['X-BAPI-RECV-WINDOW'] = RECV_WINDOW;
      headers['X-BAPI-SIGN'] = bybitSign(secret, timestamp, key, RECV_WINDOW, body ?? query);
    }
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(10_000) });
    const json = (await res.json()) as BybitEnvelope<T>;
    if (json.retCode !== 0) throw new Error('Bybit ' + path + ': ' + json.retCode + ' ' + json.retMsg);
    return json as unknown as T;
  }

  private async clockOffset(): Promise<number> {
    if (this.clockOffsetMs === null) {
      const json = await this.request<BybitEnvelope<{ timeSecond: string }>>('GET', '/v5/market/time', {}, false);
      this.clockOffsetMs = (json.time ?? Date.now()) - Date.now();
    }
    return this.clockOffsetMs;
  }

  async serverTime(): Promise<number> {
    const json = await this.request<BybitEnvelope<unknown>>('GET', '/v5/market/time', {}, false);
    return json.time ?? 0;
  }

  async readMarks(): Promise<Record<string, number>> {
    const entries = await Promise.all(
      EXCHANGE_COINS.map(async (coin) => {
        const json = await this.request<BybitEnvelope<{ list?: Array<{ markPrice?: string }> }>>(
          'GET',
          '/v5/market/tickers',
          { category: 'linear', symbol: coin + 'USDT' },
          false,
        );
        return [coin, parseBybitMark(json)] as const;
      }),
    );
    return Object.fromEntries(entries.filter(([, px]) => px > 0));
  }

  async instrument(symbol: string): Promise<BybitInstrument> {
    return parseBybitInstrument(
      await this.request('GET', '/v5/market/instruments-info', { category: 'linear', symbol }, false),
    );
  }

  async readAccount(): Promise<BybitAccountView> {
    const [wallet, fund] = await Promise.all([
      this.request<BybitEnvelope<{ list?: Array<Record<string, unknown>> }>>(
        'GET',
        '/v5/account/wallet-balance',
        { accountType: 'UNIFIED' },
        true,
      ),
      this.request<BybitEnvelope<{ balance?: Array<{ coin: string; transferBalance?: string }> }>>(
        'GET',
        '/v5/asset/transfer/query-account-coins-balance',
        { accountType: 'FUND', coin: 'USDT' },
        true,
      ),
    ]);
    return { ...parseBybitWallet(wallet), fundingUsdt: parseBybitFundingUsdt(fund) };
  }

  async readPositions(): Promise<BybitPositionView[]> {
    return parseBybitPositions(
      await this.request('GET', '/v5/position/list', { category: 'linear', settleCoin: 'USDT' }, true),
    );
  }

  async readSnapshot(): Promise<BybitDeskSnapshot> {
    let marks: Record<string, number> = {};
    try {
      marks = await this.readMarks();
    } catch (err) {
      return { marks, signed: 'error', account: null, positions: [], error: err instanceof Error ? err.message : String(err) };
    }
    if (!this.hasKey) return { marks, signed: 'skipped', account: null, positions: [] };
    try {
      const [account, positions] = await Promise.all([this.readAccount(), this.readPositions()]);
      return { marks, signed: 'ok', account, positions };
    } catch (err) {
      return { marks, signed: 'error', account: null, positions: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Internal transfer Funding -> Trading (Unified). The only direction this app moves money. */
  async transferFundingToTrading(amountUsdt: number): Promise<{ transferId: string; status: string }> {
    const transferId = crypto.randomUUID();
    const json = await this.request<BybitEnvelope<{ transferId: string; status?: string }>>(
      'POST',
      '/v5/asset/transfer/inter-transfer',
      { transferId, coin: 'USDT', amount: String(amountUsdt), fromAccountType: 'FUND', toAccountType: 'UNIFIED' },
      true,
    );
    return { transferId: json.result.transferId || transferId, status: json.result.status ?? 'SUCCESS' };
  }

  /** Market order on a linear perp. reduceOnly is true for every tap action; false only for the testnet setup script. */
  async placeMarketOrder(params: {
    symbol: string;
    side: 'Buy' | 'Sell';
    qty: string;
    reduceOnly: boolean;
    positionIdx: number;
  }): Promise<{ orderId: string; orderLinkId: string }> {
    const orderLinkId = 'cv-' + crypto.randomBytes(6).toString('hex');
    const json = await this.request<BybitEnvelope<{ orderId: string; orderLinkId: string }>>(
      'POST',
      '/v5/order/create',
      {
        category: 'linear',
        symbol: params.symbol,
        side: params.side,
        orderType: 'Market',
        qty: params.qty,
        reduceOnly: params.reduceOnly,
        positionIdx: params.positionIdx,
        orderLinkId,
      },
      true,
    );
    return { orderId: json.result.orderId, orderLinkId: json.result.orderLinkId || orderLinkId };
  }
}
