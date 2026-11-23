import { encode as msgpackEncode } from '@msgpack/msgpack';
import { concat, hexToBytes, keccak256, numberToBytes, parseSignature } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { HyperliquidPosition, HyperliquidSnapshot, UserThresholds } from '@chainvision/shared';
import type { AppConfig } from '../config.js';
import { assertHyperliquidOrderAllowed } from '../safety/policy.js';

interface HlUniverseItem {
  name: string;
  szDecimals: number;
  maxLeverage: number;
}

interface HlAssetCtx {
  markPx: string;
  funding: string;
  midPx?: string;
}

interface HlClearinghousePosition {
  position: {
    coin: string;
    szi: string;
    entryPx: string | null;
    liquidationPx: string | null;
    unrealizedPnl: string;
    positionValue: string;
    leverage?: { type: string; value: number };
  };
}

interface HlClearinghouseResponse {
  marginSummary?: {
    accountValue: string;
    totalMarginUsed: string;
  };
  assetPositions?: HlClearinghousePosition[];
}

interface HlSpotClearinghouseResponse {
  balances?: Array<{
    coin: string;
    total: string;
    hold: string;
  }>;
}

function formatHlPrice(px: number): string {
  // Hyperliquid tick formatting: <= 5 significant figures, max 6 decimals for perps
  const sig = Number(px.toPrecision(5));
  return sig.toFixed(Math.min(6, Math.max(0, 5 - Math.floor(Math.log10(Math.max(sig, 1))) - 1)))
    .replace(/\.?0+$/, '');
}

function formatHlSize(sz: number, szDecimals: number): string {
  return sz.toFixed(szDecimals).replace(/\.?0+$/, '');
}

/**
 * Computes Hyperliquid L1 action hash per official SDK specification:
 * keccak256(msgpack(action) || uint64BE(nonce) || (vault ? 0x01 || vaultBytes : 0x00))
 */
export function computeHyperliquidActionHash(
  action: Record<string, unknown>,
  nonce: number,
  vaultAddress?: `0x${string}` | null,
): `0x${string}` {
  const actionBytes = msgpackEncode(action);
  const nonceBytes = numberToBytes(BigInt(nonce), { size: 8 });
  const vaultMarker = vaultAddress
    ? concat([new Uint8Array([1]), hexToBytes(vaultAddress)])
    : new Uint8Array([0]);
  return keccak256(concat([actionBytes, nonceBytes, vaultMarker]));
}

export class HyperliquidTestnetClient {
  private readonly config: AppConfig;
  private universeCache: { items: HlUniverseItem[]; ctxs: HlAssetCtx[]; fetchedAt: number } | null =
    null;

  constructor(config: AppConfig) {
    if (!config.hyperliquidApiUrl.includes('testnet')) {
      throw new Error(`Refusing non-testnet Hyperliquid URL: ${config.hyperliquidApiUrl}`);
    }
    this.config = config;
  }

  private async postInfo<T>(body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.config.hyperliquidApiUrl}/info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      throw new Error(`Hyperliquid /info HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  async getMetaAndCtxs(): Promise<{ items: HlUniverseItem[]; ctxs: HlAssetCtx[] }> {
    if (this.universeCache && Date.now() - this.universeCache.fetchedAt < 5000) {
      return { items: this.universeCache.items, ctxs: this.universeCache.ctxs };
    }
    const data = await this.postInfo<[{ universe: HlUniverseItem[] }, HlAssetCtx[]]>({
      type: 'metaAndAssetCtxs',
    });
    const items = data[0].universe;
    const ctxs = data[1];
    this.universeCache = { items, ctxs, fetchedAt: Date.now() };
    return { items, ctxs };
  }

  async readSnapshot(overrideAccount?: `0x${string}`): Promise<HyperliquidSnapshot> {
    const accountAddress =
      overrideAccount ??
      this.config.hyperliquidAccountAddress ??
      this.config.hyperliquidAgentAddress ??
      '0x0000000000000000000000000000000000000000';
    const agentAddress =
      this.config.hyperliquidAgentAddress ?? '0x0000000000000000000000000000000000000000';

    try {
      const { items, ctxs } = await this.getMetaAndCtxs();
      const ethIdx = items.findIndex((i) => i.name === 'ETH');
      const btcIdx = items.findIndex((i) => i.name === 'BTC');
      const ethMarkPx = ethIdx >= 0 ? Number(ctxs[ethIdx]?.markPx ?? 0) : 0;
      const btcMarkPx = btcIdx >= 0 ? Number(ctxs[btcIdx]?.markPx ?? 0) : 0;
      const ethFundingPctHr = ethIdx >= 0 ? Number(ctxs[ethIdx]?.funding ?? 0) * 100 : 0;

      let accountValueUsd = 0;
      let marginUsedUsd = 0;
      const positions: HyperliquidPosition[] = [];

      if (accountAddress !== '0x0000000000000000000000000000000000000000') {
        const [ch, spot] = await Promise.all([
          this.postInfo<HlClearinghouseResponse>({
            type: 'clearinghouseState',
            user: accountAddress,
          }),
          this.postInfo<HlSpotClearinghouseResponse>({
            type: 'spotClearinghouseState',
            user: accountAddress,
          }).catch(() => ({ balances: [] })),
        ]);
        const perpValueUsd = Number(ch.marginSummary?.accountValue ?? 0);
        const spotUsdc = Number(
          spot.balances?.find((b) => b.coin === 'USDC')?.total ?? 0,
        );
        // In Hyperliquid Unified Account mode, USDC collateral lives in spotClearinghouseState
        accountValueUsd = perpValueUsd > 0 ? perpValueUsd : spotUsdc;
        marginUsedUsd = Number(ch.marginSummary?.totalMarginUsed ?? 0);

        for (const ap of ch.assetPositions ?? []) {
          const p = ap.position;
          const szi = Number(p.szi);
          if (!Number.isFinite(szi) || Math.abs(szi) === 0) continue;
          const cIdx = items.findIndex((i) => i.name === p.coin);
          const markPx = cIdx >= 0 ? Number(ctxs[cIdx]?.markPx ?? 0) : Number(p.entryPx ?? 0);
          const entryPx = Number(p.entryPx ?? markPx);
          const liqPx = p.liquidationPx ? Number(p.liquidationPx) : null;
          const liqDistancePct =
            liqPx && markPx > 0 ? (Math.abs(markPx - liqPx) / markPx) * 100 : null;
          positions.push({
            coin: p.coin,
            side: szi > 0 ? 'LONG' : 'SHORT',
            size: Math.abs(szi),
            entryPx,
            markPx,
            liquidationPx: liqPx,
            liqDistancePct,
            unrealizedPnlUsd: Number(p.unrealizedPnl ?? 0),
            leverage: Number(p.leverage?.value ?? 1),
            notionalUsd: Math.abs(Number(p.positionValue ?? szi * markPx)),
          });
        }
      }

      return {
        network: 'hyperliquid-testnet',
        accountAddress,
        agentAddress,
        accountValueUsd,
        marginUsedUsd,
        ethMarkPx,
        btcMarkPx,
        ethFundingPctHr,
        positions,
      };
    } catch (err) {
      return {
        network: 'hyperliquid-testnet',
        accountAddress,
        agentAddress,
        accountValueUsd: 0,
        marginUsedUsd: 0,
        ethMarkPx: 0,
        btcMarkPx: 0,
        ethFundingPctHr: 0,
        positions: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Signs an L1 action strictly for Hyperliquid Testnet (`source: 'b'`) using the
   * non-withdrawable API Agent private key. Cryptographically impossible to replay on mainnet.
   */
  private async signTestnetL1Action(action: Record<string, unknown>, nonce: number) {
    if (!this.config.hyperliquidAgentPrivateKey) {
      throw new Error('HYPERLIQUID_AGENT_PRIVATE_KEY is not configured');
    }
    const account = privateKeyToAccount(this.config.hyperliquidAgentPrivateKey);
    const connectionId = computeHyperliquidActionHash(action, nonce, null);
    const sigHex = await account.signTypedData({
      domain: {
        name: 'Exchange',
        version: '1',
        chainId: 1337,
        verifyingContract: '0x0000000000000000000000000000000000000000',
      },
      types: {
        Agent: [
          { name: 'source', type: 'string' },
          { name: 'connectionId', type: 'bytes32' },
        ],
      },
      primaryType: 'Agent',
      message: {
        source: 'b', // 'b' = Hyperliquid Testnet ONLY
        connectionId,
      },
    });
    const parsed = parseSignature(sigHex);
    return {
      r: parsed.r,
      s: parsed.s,
      v: Number(parsed.v ?? (parsed.yParity === 0 ? 27 : 28)),
    };
  }

  async placeOrder(params: {
    coin: string;
    isBuy: boolean;
    size: number;
    limitPx: number;
    reduceOnly: boolean;
    tif?: 'Ioc' | 'Gtc';
    thresholds: UserThresholds;
  }): Promise<{ orderId: string; status: string; raw: unknown }> {
    const { items } = await this.getMetaAndCtxs();
    const assetIdx = items.findIndex((i) => i.name === params.coin);
    if (assetIdx < 0) {
      throw new Error(`Unknown Hyperliquid testnet coin: ${params.coin}`);
    }
    const szDecimals = items[assetIdx]!.szDecimals;
    const notionalUsd = params.size * params.limitPx;

    assertHyperliquidOrderAllowed({
      apiUrl: this.config.hyperliquidApiUrl,
      reduceOnly: params.reduceOnly,
      isWithdraw: false,
      notionalUsd,
      thresholds: params.thresholds,
    });

    const action = {
      type: 'order',
      orders: [
        {
          a: assetIdx,
          b: params.isBuy,
          p: formatHlPrice(params.limitPx),
          s: formatHlSize(params.size, szDecimals),
          r: params.reduceOnly,
          t: { limit: { tif: params.tif ?? 'Ioc' } },
        },
      ],
      grouping: 'na',
    };

    const nonce = Date.now();
    const signature = await this.signTestnetL1Action(action, nonce);

    const res = await fetch(`${this.config.hyperliquidApiUrl}/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action,
        nonce,
        signature,
        vaultAddress: null,
      }),
      signal: AbortSignal.timeout(12000),
    });

    const raw = (await res.json()) as {
      status?: string;
      response?: {
        type?: string;
        data?: {
          statuses?: Array<{
            filled?: { oid: number; totalSz: string; avgPx: string };
            resting?: { oid: number };
            error?: string;
          }>;
        };
      };
    };

    if (!res.ok || raw.status !== 'ok') {
      throw new Error(`Hyperliquid testnet exchange error: ${JSON.stringify(raw)}`);
    }

    const st = raw.response?.data?.statuses?.[0];
    if (st?.error) {
      throw new Error(`Hyperliquid order rejected: ${st.error}`);
    }

    const oid = st?.filled?.oid ?? st?.resting?.oid ?? nonce;
    const status = st?.filled
      ? `FILLED ${st.filled.totalSz} @ $${st.filled.avgPx}`
      : st?.resting
        ? `RESTING #${st.resting.oid}`
        : 'ACCEPTED';

    return {
      orderId: String(oid),
      status,
      raw,
    };
  }

  /**
   * Testnet-only demo helper (used only by scripts/setup-hyperliquid-position.ts) to open a
   * tiny capped perp position so the watcher & reduce-only trim have a live position to manage.
   */
  async openTestnetDemoPosition(params: {
    coin: string;
    notionalUsd: number;
  }): Promise<{ orderId: string; status: string }> {
    if (!this.config.hyperliquidApiUrl.includes('testnet')) {
      throw new Error('Refusing non-testnet Hyperliquid URL');
    }
    if (params.notionalUsd > 100) {
      throw new Error('Demo seed notional capped at $100');
    }
    const { items, ctxs } = await this.getMetaAndCtxs();
    const assetIdx = items.findIndex((i) => i.name === params.coin);
    if (assetIdx < 0) throw new Error(`Unknown coin ${params.coin}`);
    const markPx = Number(ctxs[assetIdx]!.markPx);
    const szDecimals = items[assetIdx]!.szDecimals;
    const size = Number((params.notionalUsd / markPx).toFixed(szDecimals));
    const limitPx = markPx * 1.03;

    const action = {
      type: 'order',
      orders: [
        {
          a: assetIdx,
          b: true,
          p: formatHlPrice(limitPx),
          s: formatHlSize(size, szDecimals),
          r: false,
          t: { limit: { tif: 'Ioc' } },
        },
      ],
      grouping: 'na',
    };
    const nonce = Date.now();
    const signature = await this.signTestnetL1Action(action, nonce);
    const res = await fetch(`${this.config.hyperliquidApiUrl}/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, nonce, signature, vaultAddress: null }),
      signal: AbortSignal.timeout(12000),
    });
    const raw = (await res.json()) as {
      status?: string;
      response?: {
        data?: { statuses?: Array<{ filled?: { oid: number; totalSz: string; avgPx: string }; error?: string }> };
      };
    };
    if (!res.ok || raw.status !== 'ok') {
      throw new Error(`Hyperliquid seed order error: ${JSON.stringify(raw)}`);
    }
    const st = raw.response?.data?.statuses?.[0];
    if (st?.error) throw new Error(`Hyperliquid seed order rejected: ${st.error}`);
    return {
      orderId: String(st?.filled?.oid ?? nonce),
      status: st?.filled ? `FILLED ${st.filled.totalSz} @ $${st.filled.avgPx}` : 'ACCEPTED',
    };
  }

  async trimPosition(params: {
    coin: string;
    amountPct: number;
    thresholds: UserThresholds;
  }): Promise<{
    orderId: string;
    status: string;
    explorerUrl: string;
    before: HyperliquidSnapshot;
    after: HyperliquidSnapshot;
  }> {
    const before = await this.readSnapshot();
    const pos = before.positions.find((p) => p.coin.toUpperCase() === params.coin.toUpperCase());
    if (!pos) {
      throw new Error(`No open Hyperliquid testnet ${params.coin} position to trim`);
    }

    const { items } = await this.getMetaAndCtxs();
    const meta = items.find((i) => i.name === pos.coin);
    const szDecimals = meta?.szDecimals ?? 4;
    const rawTrimSz = pos.size * (Math.min(100, Math.max(1, params.amountPct)) / 100);
    const trimSz = Number(rawTrimSz.toFixed(szDecimals));
    if (trimSz <= 0) {
      throw new Error(`Computed trim size for ${pos.coin} is 0`);
    }

    const isBuy = pos.side === 'SHORT';
    // 3% slippage limit for reliable IOC fill on testnet
    const limitPx = isBuy ? pos.markPx * 1.03 : pos.markPx * 0.97;

    const result = await this.placeOrder({
      coin: pos.coin,
      isBuy,
      size: trimSz,
      limitPx,
      reduceOnly: true,
      tif: 'Ioc',
      thresholds: params.thresholds,
    });

    const after = await this.readSnapshot();
    return {
      orderId: result.orderId,
      status: result.status,
      explorerUrl: `https://app.hyperliquid-testnet.xyz/explorer/address/${before.accountAddress}`,
      before,
      after,
    };
  }
}
