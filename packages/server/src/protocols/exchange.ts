import crypto from 'node:crypto';
import type { ExchangePosition, ExchangeSnapshot } from '@chainvision/shared';
import type { AppConfig } from '../config.js';

/**
 * Read-only Exchange Testnet Watcher (Bybit Testnet or Binance Futures Testnet).
 * Never places exchange trades (Phase 1 scope is read-only positions & balances).
 */
export class ExchangeTestnetWatcher {
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async readSnapshot(): Promise<ExchangeSnapshot> {
    if (this.config.binanceTestnetApiKey && this.config.binanceTestnetApiSecret) {
      return this.readBinanceFuturesTestnet(true);
    }
    if (this.config.bybitTestnetApiKey && this.config.bybitTestnetApiSecret) {
      return this.readBybitTestnet(true);
    }
    // Default public live testnet feed (Bybit Testnet first, fallback to Binance Futures Testnet)
    const bybit = await this.readBybitTestnet(false);
    if (!bybit.error) return bybit;
    return this.readBinanceFuturesTestnet(false);
  }

  private async readBybitTestnet(authenticated: boolean): Promise<ExchangeSnapshot> {
    const base = 'https://api-testnet.bybit.com';
    try {
      const tickerRes = await fetch(
        `${base}/v5/market/tickers?category=linear&symbol=ETHUSDT`,
        { signal: AbortSignal.timeout(8000) },
      );
      const tickerJson = (await tickerRes.json()) as {
        result?: { list?: Array<{ markPrice?: string; fundingRate?: string }> };
      };
      const item = tickerJson.result?.list?.[0];
      const ethMarkPx = Number(item?.markPrice ?? 0);
      const ethFundingPct = Number(item?.fundingRate ?? 0) * 100;

      if (!authenticated || !this.config.bybitTestnetApiKey || !this.config.bybitTestnetApiSecret) {
        return {
          venue: 'bybit-testnet',
          mode: 'public',
          ethMarkPx,
          ethFundingPct,
          equityUsd: null,
          positions: [],
        };
      }

      const timestamp = String(Date.now());
      const recvWindow = '5000';
      const signBybit = (query: string) =>
        crypto
          .createHmac('sha256', this.config.bybitTestnetApiSecret!)
          .update(`${timestamp}${this.config.bybitTestnetApiKey}${recvWindow}${query}`)
          .digest('hex');

      const balQuery = 'accountType=UNIFIED';
      const posQuery = 'category=linear&settleCoin=USDT';

      const [balRes, posRes] = await Promise.all([
        fetch(`${base}/v5/account/wallet-balance?${balQuery}`, {
          headers: {
            'X-BAPI-API-KEY': this.config.bybitTestnetApiKey,
            'X-BAPI-TIMESTAMP': timestamp,
            'X-BAPI-RECV-WINDOW': recvWindow,
            'X-BAPI-SIGN': signBybit(balQuery),
          },
          signal: AbortSignal.timeout(8000),
        }).then((r) => r.json() as Promise<{ result?: { list?: Array<{ totalEquity?: string }> } }>),
        fetch(`${base}/v5/position/list?${posQuery}`, {
          headers: {
            'X-BAPI-API-KEY': this.config.bybitTestnetApiKey,
            'X-BAPI-TIMESTAMP': timestamp,
            'X-BAPI-RECV-WINDOW': recvWindow,
            'X-BAPI-SIGN': signBybit(posQuery),
          },
          signal: AbortSignal.timeout(8000),
        }).then(
          (r) =>
            r.json() as Promise<{
              result?: {
                list?: Array<{
                  symbol: string;
                  side: string;
                  size: string;
                  avgPrice: string;
                  markPrice: string;
                  unrealisedPnl: string;
                  liqPrice: string;
                }>;
              };
            }>,
        ),
      ]);

      const equityUsd = Number(balRes.result?.list?.[0]?.totalEquity ?? 0);
      const positions: ExchangePosition[] = (posRes.result?.list ?? [])
        .filter((p) => Number(p.size) > 0)
        .map((p) => {
          const mark = Number(p.markPrice);
          const liq = Number(p.liqPrice);
          return {
            symbol: p.symbol,
            side: p.side.toUpperCase() === 'SELL' ? 'SHORT' : 'LONG',
            size: Number(p.size),
            entryPx: Number(p.avgPrice),
            markPx: mark,
            unrealizedPnlUsd: Number(p.unrealisedPnl),
            liqDistancePct: liq > 0 && mark > 0 ? (Math.abs(mark - liq) / mark) * 100 : null,
          };
        });

      return {
        venue: 'bybit-testnet',
        mode: 'authenticated',
        ethMarkPx,
        ethFundingPct,
        equityUsd,
        positions,
      };
    } catch (err) {
      return {
        venue: 'bybit-testnet',
        mode: authenticated ? 'authenticated' : 'public',
        ethMarkPx: 0,
        ethFundingPct: 0,
        equityUsd: null,
        positions: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async readBinanceFuturesTestnet(authenticated: boolean): Promise<ExchangeSnapshot> {
    const base = 'https://testnet.binancefuture.com';
    try {
      const premRes = await fetch(`${base}/fapi/v1/premiumIndex?symbol=ETHUSDT`, {
        signal: AbortSignal.timeout(8000),
      });
      const prem = (await premRes.json()) as { markPrice?: string; lastFundingRate?: string };
      const ethMarkPx = Number(prem.markPrice ?? 0);
      const ethFundingPct = Number(prem.lastFundingRate ?? 0) * 100;

      if (
        !authenticated ||
        !this.config.binanceTestnetApiKey ||
        !this.config.binanceTestnetApiSecret
      ) {
        return {
          venue: 'binance-testnet',
          mode: 'public',
          ethMarkPx,
          ethFundingPct,
          equityUsd: null,
          positions: [],
        };
      }

      const qs = `timestamp=${Date.now()}&recvWindow=5000`;
      const sig = crypto
        .createHmac('sha256', this.config.binanceTestnetApiSecret)
        .update(qs)
        .digest('hex');

      const acctRes = await fetch(`${base}/fapi/v2/account?${qs}&signature=${sig}`, {
        headers: { 'X-MBX-APIKEY': this.config.binanceTestnetApiKey },
        signal: AbortSignal.timeout(8000),
      });
      const acct = (await acctRes.json()) as {
        totalWalletBalance?: string;
        positions?: Array<{
          symbol: string;
          positionAmt: string;
          entryPrice: string;
          unrealizedProfit: string;
        }>;
      };

      const equityUsd = Number(acct.totalWalletBalance ?? 0);
      const positions: ExchangePosition[] = (acct.positions ?? [])
        .filter((p) => Math.abs(Number(p.positionAmt)) > 0)
        .map((p) => {
          const amt = Number(p.positionAmt);
          return {
            symbol: p.symbol,
            side: amt > 0 ? 'LONG' : 'SHORT',
            size: Math.abs(amt),
            entryPx: Number(p.entryPrice),
            markPx: p.symbol === 'ETHUSDT' ? ethMarkPx : Number(p.entryPrice),
            unrealizedPnlUsd: Number(p.unrealizedProfit),
            liqDistancePct: null,
          };
        });

      return {
        venue: 'binance-testnet',
        mode: 'authenticated',
        ethMarkPx,
        ethFundingPct,
        equityUsd,
        positions,
      };
    } catch (err) {
      return {
        venue: 'binance-testnet',
        mode: authenticated ? 'authenticated' : 'public',
        ethMarkPx: 0,
        ethFundingPct: 0,
        equityUsd: null,
        positions: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
