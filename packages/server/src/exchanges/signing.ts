import crypto from 'node:crypto';
import { BINANCE_SPOT_TESTNET_URL, BYBIT_TESTNET_URL, COINBASE_PUBLIC_URL } from '@chainvision/shared';

/** Bybit V5: sign timestamp + apiKey + recvWindow + (queryString for GET | jsonBody for POST), HMAC-SHA256, lowercase hex. */
export function bybitPreSign(timestamp: string, apiKey: string, recvWindow: string, payload: string): string {
  return timestamp + apiKey + recvWindow + payload;
}

export function bybitSign(secret: string, timestamp: string, apiKey: string, recvWindow: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(bybitPreSign(timestamp, apiKey, recvWindow, payload)).digest('hex');
}

/** Binance: percent-encoded parameter=value pairs joined by &, in the order given. */
export function binanceQuery(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
    .join('&');
}

/** Binance HMAC-SHA256 signature of the query string, hex. */
export function binanceSign(secret: string, query: string): string {
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

const ALLOWED_HOSTS = new Set([BYBIT_TESTNET_URL, BINANCE_SPOT_TESTNET_URL, COINBASE_PUBLIC_URL].map((u) => new URL(u).host));
const SIGNED_HOSTS = new Set([BYBIT_TESTNET_URL, BINANCE_SPOT_TESTNET_URL].map((u) => new URL(u).host));

/** Refuses any exchange host outside the allowlist, and any signed call to a host that is not a testnet. */
export function assertExchangeHost(url: string, signed: boolean): void {
  const host = new URL(url).host;
  if (!ALLOWED_HOSTS.has(host)) throw new Error('Blocked exchange host ' + host + ': not in the testnet allowlist');
  if (signed && !SIGNED_HOSTS.has(host)) throw new Error('Blocked signed call to ' + host + ': only testnet hosts take keys');
}

/** Rounds down to an exchange step (lot or tick size) without floating-point drift. */
export function floorToStep(value: number, step: number): number {
  if (!(step > 0)) return value;
  const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  const floored = Math.floor(value / step + 1e-9) * step;
  return Number(floored.toFixed(decimals));
}

export function stepDecimals(step: number): number {
  return step > 0 ? Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)) : 8;
}
