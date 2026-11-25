/** toncenter v2 HTTP API, one instance per network. Calls are spaced out to stay inside its keyless rate limit. */
export const TONCENTER_TESTNET_URL = 'https://testnet.toncenter.com/api/v2';
export const TONCENTER_MAINNET_URL = 'https://toncenter.com/api/v2';
export const TON_TESTNET_EXPLORER = 'https://testnet.tonviewer.com';

export type TonNetwork = 'testnet' | 'mainnet';

export interface ToncenterTransaction {
  utime: number;
  transaction_id: { lt: string; hash: string };
  in_msg?: { source?: string; destination?: string; value?: string; message?: string; hash?: string };
  out_msgs?: Array<{ source?: string; destination?: string; value?: string; message?: string }>;
}

export interface ToncenterWalletInfo {
  wallet: boolean;
  balance: string;
  account_state: string;
  seqno?: number | null;
}

export class ToncenterError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ToncenterError';
  }
}

export class Toncenter {
  readonly baseUrl: string;
  private readonly gapMs: number;
  private chain: Promise<unknown> = Promise.resolve();
  private lastCallAt = 0;

  constructor(
    readonly network: TonNetwork,
    private readonly apiKey: string | null = null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = network === 'testnet' ? TONCENTER_TESTNET_URL : TONCENTER_MAINNET_URL;
    this.gapMs = apiKey ? 150 : 1100;
  }

  private call<T>(method: string, init: { query?: Record<string, string | number>; body?: unknown } = {}): Promise<T> {
    const run = async (): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        const wait = this.lastCallAt + this.gapMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.lastCallAt = Date.now();
        const url = new URL(`${this.baseUrl}/${method}`);
        for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, String(v));
        const headers: Record<string, string> = { accept: 'application/json' };
        if (this.apiKey) headers['X-API-Key'] = this.apiKey;
        if (init.body !== undefined) headers['content-type'] = 'application/json';
        const res = await this.fetchImpl(url, {
          method: init.body === undefined ? 'GET' : 'POST',
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 429 && attempt < 3) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; error?: string } | null;
        if (!res.ok || !json?.ok) {
          throw new ToncenterError(`toncenter ${this.network} ${method}: ${json?.error ?? res.statusText} (HTTP ${res.status})`, res.status);
        }
        return json.result as T;
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  getAddressBalance(address: string): Promise<string> {
    return this.call<string>('getAddressBalance', { query: { address } });
  }

  getWalletInformation(address: string): Promise<ToncenterWalletInfo> {
    return this.call<ToncenterWalletInfo>('getWalletInformation', { query: { address } });
  }

  getTransactions(address: string, limit = 10): Promise<ToncenterTransaction[]> {
    return this.call<ToncenterTransaction[]>('getTransactions', { query: { address, limit } });
  }

  sendBocReturnHash(bocBase64: string): Promise<{ hash: string }> {
    return this.call<{ hash: string }>('sendBocReturnHash', { body: { boc: bocBase64 } });
  }
}

/** toncenter returns hashes in base64; explorers link them in hex. */
export function tonHashToHex(hash: string): string {
  return /^[0-9a-f]{64}$/i.test(hash) ? hash.toLowerCase() : Buffer.from(hash, 'base64').toString('hex');
}

export function tonTestnetTxUrl(hash: string): string {
  return `${TON_TESTNET_EXPLORER}/transaction/${tonHashToHex(hash)}`;
}
