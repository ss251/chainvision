import { COINBASE_PUBLIC_URL, EXCHANGE_COINS, type CoinbaseSnapshot } from '@chainvision/shared';
import { assertExchangeHost } from './signing.js';

export function parseCoinbaseTicker(json: { price?: string }): number {
  const n = Number(json.price);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Coinbase Exchange public market data. Read-only: no key, no account, no orders. */
export class CoinbasePublicClient {
  constructor(private readonly baseUrl: string = COINBASE_PUBLIC_URL) {
    assertExchangeHost(baseUrl, false);
  }

  async readSnapshot(): Promise<CoinbaseSnapshot> {
    const results = await Promise.allSettled(
      EXCHANGE_COINS.map(async (coin) => {
        const url = this.baseUrl + '/products/' + coin + '-USD/ticker';
        assertExchangeHost(url, false);
        const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error('Coinbase ' + coin + '-USD: HTTP ' + res.status);
        return [coin, parseCoinbaseTicker((await res.json()) as { price?: string })] as const;
      }),
    );
    const prices: Record<string, number> = {};
    const errors: string[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value[1] > 0) prices[r.value[0]] = r.value[1];
      else if (r.status === 'rejected') errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
    }
    return errors.length ? { prices, error: errors.join('; ') } : { prices };
  }
}
