import { RECORDED_FALLBACK_PRICES, type LiveMarketPrices } from './scenarios.js';

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 6000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function posNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Reads public, read-only market prices directly in the browser with zero API keys:
 * - Hyperliquid Testnet /info (allMids)
 * - Coinbase Exchange public tickers (BTC-USD, ETH-USD)
 * - Binance Spot Testnet public ticker/price
 * - Bybit Testnet public linear tickers
 *
 * When endpoints are blocked or rate-limited, falls back to the last recorded prices
 * and sets feedState='unavailable' so the UI never claims stale prices are live.
 */
export async function fetchLivePublicPrices(
  previous: LiveMarketPrices = RECORDED_FALLBACK_PRICES,
): Promise<LiveMarketPrices> {
  const next: LiveMarketPrices = { ...previous, liveSources: [] };

  const [hl, cbBtc, cbEth, bn, byBtc, byEth] = await Promise.allSettled([
    fetchJson<Record<string, string>>('https://api.hyperliquid-testnet.xyz/info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' }),
    }),
    fetchJson<{ price?: string }>('https://api.exchange.coinbase.com/products/BTC-USD/ticker'),
    fetchJson<{ price?: string }>('https://api.exchange.coinbase.com/products/ETH-USD/ticker'),
    fetchJson<Array<{ symbol: string; price: string }>>(
      'https://testnet.binance.vision/api/v3/ticker/price?symbols=%5B%22BTCUSDT%22,%22ETHUSDT%22%5D',
    ),
    fetchJson<{ result?: { list?: Array<{ markPrice?: string; lastPrice?: string }> } }>(
      'https://api-testnet.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT',
    ),
    fetchJson<{ result?: { list?: Array<{ markPrice?: string; lastPrice?: string }> } }>(
      'https://api-testnet.bybit.com/v5/market/tickers?category=linear&symbol=ETHUSDT',
    ),
  ]);

  if (hl.status === 'fulfilled') {
    const eth = posNum(hl.value.ETH);
    const btc = posNum(hl.value.BTC);
    if (eth) next.hlEth = eth;
    if (btc) next.hlBtc = btc;
    if (eth || btc) next.liveSources.push('Hyperliquid Testnet');
  }

  let cbOk = false;
  if (cbBtc.status === 'fulfilled') {
    const p = posNum(cbBtc.value.price);
    if (p) {
      next.coinbaseBtc = p;
      cbOk = true;
    }
  }
  if (cbEth.status === 'fulfilled') {
    const p = posNum(cbEth.value.price);
    if (p) {
      next.coinbaseEth = p;
      cbOk = true;
    }
  }
  if (cbOk) next.liveSources.push('Coinbase Public');

  if (bn.status === 'fulfilled' && Array.isArray(bn.value)) {
    let bnOk = false;
    for (const row of bn.value) {
      const p = posNum(row.price);
      if (!p) continue;
      if (row.symbol === 'BTCUSDT') {
        next.binanceBtc = p;
        bnOk = true;
      } else if (row.symbol === 'ETHUSDT') {
        next.binanceEth = p;
        bnOk = true;
      }
    }
    if (bnOk) next.liveSources.push('Binance Testnet');
  }

  let byOk = false;
  if (byBtc.status === 'fulfilled') {
    const row = byBtc.value.result?.list?.[0];
    const p = posNum(row?.markPrice ?? row?.lastPrice);
    if (p) {
      next.bybitBtc = p;
      byOk = true;
    }
  }
  if (byEth.status === 'fulfilled') {
    const row = byEth.value.result?.list?.[0];
    const p = posNum(row?.markPrice ?? row?.lastPrice);
    if (p) {
      next.bybitEth = p;
      byOk = true;
    }
  }
  if (byOk) next.liveSources.push('Bybit Testnet');

  if (next.liveSources.length > 0) {
    next.feedState = 'live';
    next.updatedAt = Date.now();
  } else {
    next.feedState = 'unavailable';
    next.updatedAt = null;
  }
  return next;
}
