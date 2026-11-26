import type { ExchangeSnapshot } from '@chainvision/shared';
import type { AppConfig } from '../config.js';

type PublicFeed = Pick<ExchangeSnapshot, 'venue' | 'ethMarkPx' | 'ethFundingPct'>;

/**
 * Public ETH perp mark price and funding rate from Bybit testnet (Binance Futures testnet as fallback),
 * used by voice comparison cards and as a price-alert fallback. Keyed account reads and every exchange
 * write live in ../exchanges/.
 */
export class ExchangeTestnetWatcher {
  constructor(_config?: AppConfig) {}

  async readSnapshot(): Promise<ExchangeSnapshot> {
    const bybit = await this.read('bybit-testnet', async () => {
      const res = await fetch('https://api-testnet.bybit.com/v5/market/tickers?category=linear&symbol=ETHUSDT', {
        signal: AbortSignal.timeout(8000),
      });
      const json = (await res.json()) as { result?: { list?: Array<{ markPrice?: string; fundingRate?: string }> } };
      const item = json.result?.list?.[0];
      return { ethMarkPx: Number(item?.markPrice ?? 0), ethFundingPct: Number(item?.fundingRate ?? 0) * 100 };
    });
    if (!bybit.error) return bybit;
    return this.read('binance-testnet', async () => {
      const res = await fetch('https://testnet.binancefuture.com/fapi/v1/premiumIndex?symbol=ETHUSDT', {
        signal: AbortSignal.timeout(8000),
      });
      const prem = (await res.json()) as { markPrice?: string; lastFundingRate?: string };
      return { ethMarkPx: Number(prem.markPrice ?? 0), ethFundingPct: Number(prem.lastFundingRate ?? 0) * 100 };
    });
  }

  private async read(
    venue: PublicFeed['venue'],
    fetchFeed: () => Promise<Omit<PublicFeed, 'venue'>>,
  ): Promise<ExchangeSnapshot> {
    try {
      return { venue, mode: 'public', ...(await fetchFeed()), equityUsd: null, positions: [] };
    } catch (err) {
      return {
        venue,
        mode: 'public',
        ethMarkPx: 0,
        ethFundingPct: 0,
        equityUsd: null,
        positions: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
