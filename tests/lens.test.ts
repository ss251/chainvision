import { describe, expect, it } from 'vitest';
import {
  G2_MAX_CONTAINERS,
  G2_MAX_CREATE_CHARS,
  hasAdviceLanguage,
  hasEmoji,
  renderLensPage,
  sanitizeForG2,
  validateLensLayout,
  type LensViewState,
  type ProtocolSnapshots,
} from '@chainvision/shared';

const SAMPLE_SNAPSHOTS: ProtocolSnapshots = {
  updatedAt: Date.now(),
  aave: {
    network: 'sepolia',
    address: '0x537B1ED6f937C1A27e7C6249026732565B381fB0',
    healthFactor: 1.12,
    totalCollateralUsd: 1200,
    totalDebtUsd: 850,
    availableBorrowsUsd: 120,
    currentLiquidationThresholdPct: 82.5,
    ltvPct: 75,
    usdcBalance: 450,
    daiBalance: 200,
    ethBalance: 0.15,
    rates: [
      { symbol: 'USDC', address: '0x94a9', supplyApyPct: 4.18, borrowApyPct: 5.62 },
      { symbol: 'DAI', address: '0xFF34', supplyApyPct: 3.9, borrowApyPct: 5.1 },
    ],
  },
  uniswap: {
    network: 'sepolia',
    address: '0x537B1ED6f937C1A27e7C6249026732565B381fB0',
    poolAddress: '0x3289680dd4d6c10bb19b899729cda5eef58aeff1',
    pair: 'WETH/USDC',
    feeTier: 500,
    currentTick: -195000,
    ethQuoteUsdc: 31385,
    usdcToDaiRate: 3.43,
    lpPositions: [
      {
        tokenId: '42',
        pair: 'WETH/USDC',
        feeTier: 500,
        tickLower: -196000,
        tickUpper: -194000,
        currentTick: -195000,
        inRange: true,
        liquidity: '100000',
      },
    ],
  },
  hyperliquid: {
    network: 'hyperliquid-testnet',
    accountAddress: '0x1111111111111111111111111111111111111111',
    agentAddress: '0x9C11bc8695Ac49E17b755981f621c89b27f8882d',
    accountValueUsd: 980,
    marginUsedUsd: 210,
    ethMarkPx: 1726.3,
    btcMarkPx: 68500,
    ethFundingPctHr: 0.00125,
    positions: [
      {
        coin: 'ETH',
        side: 'LONG',
        size: 0.5,
        entryPx: 1800,
        markPx: 1726.3,
        liquidationPx: 1620,
        liqDistancePct: 6.16,
        unrealizedPnlUsd: -36.85,
        leverage: 5,
        notionalUsd: 863.15,
      },
    ],
  },
  exchange: {
    venue: 'bybit-testnet',
    mode: 'public',
    ethMarkPx: 1725.8,
    ethFundingPct: 0.01,
    equityUsd: null,
    positions: [],
  },
};

describe('Even G2 lens rendering limits & invariants', () => {
  it('renders a completely blank idle screen with exactly one event capture container', () => {
    const layout = renderLensPage({ mode: 'idle', paired: true });
    expect(layout.totalChars).toBe(0);
    expect(layout.containerTotalNum).toBe(1);
    expect(layout.textObject[0]?.isEventCapture).toBe(1);
    expect(validateLensLayout(layout)).toEqual({ valid: true, errors: [] });
  });

  it('renders alert, confirm, voice, executing, result, error, and all 4 position cards within G2 limits', () => {
    const states: LensViewState[] = [
      {
        mode: 'alert',
        paired: true,
        pendingAction: {
          id: 'act_1',
          source: 'watcher',
          protocol: 'aave',
          actionType: 'aave_repay',
          headline: 'AAVE LOAN THRESHOLD · HEALTH 1.12',
          factLine: 'LIMIT 1.35 · DEBT $850 · COLLAT $1200',
          actionPrompt: 'REPAY 300 USDC',
          params: { tokenIn: 'USDC', amount: 300 },
          createdAt: Date.now(),
          expiresAt: Date.now() + 60000,
          requiresTap: true,
        },
      },
      {
        mode: 'confirm',
        paired: true,
        pendingAction: {
          id: 'act_2',
          source: 'voice',
          protocol: 'aave',
          actionType: 'aave_supply',
          headline: 'AAVE SUPPLY 200 USDC (SEPOLIA)',
          factLine: 'AAVE APY 4.18% · UNI FEE 0.05% · EX FUND 0.010%',
          comparisonLine: 'CAP 500 USDC · NON-CUSTODIAL',
          actionPrompt: 'SUPPLY 200 USDC',
          params: { tokenIn: 'USDC', amount: 200 },
          createdAt: Date.now(),
          expiresAt: Date.now() + 60000,
          requiresTap: true,
        },
      },
      { mode: 'voice_listening', paired: true, voiceTranscript: 'put 200 USDC to work' },
      { mode: 'executing', paired: true },
      {
        mode: 'result',
        paired: true,
        lastReceipt: {
          id: 'r1',
          actionId: 'act_1',
          protocol: 'aave',
          actionType: 'aave_repay',
          network: 'sepolia',
          summary: 'AAVE REPAY 300 USDC',
          beforeFact: 'HF 1.12',
          afterFact: 'HF 1.84',
          txHashOrOrderId: '0x1234567890abcdef1234567890abcdef',
          explorerUrl: 'https://sepolia.etherscan.io/tx/0x1234',
          telegramPosted: true,
          timestamp: Date.now(),
        },
      },
      { mode: 'error', paired: true, errorMessage: 'CAP EXCEEDED' },
      { mode: 'positions', paired: true, snapshots: SAMPLE_SNAPSHOTS, positionPageIndex: 0 },
      { mode: 'positions', paired: true, snapshots: SAMPLE_SNAPSHOTS, positionPageIndex: 1 },
      { mode: 'positions', paired: true, snapshots: SAMPLE_SNAPSHOTS, positionPageIndex: 2 },
      { mode: 'positions', paired: true, snapshots: SAMPLE_SNAPSHOTS, positionPageIndex: 3 },
    ];

    for (const s of states) {
      const layout = renderLensPage(s);
      const check = validateLensLayout(layout);
      expect(check.errors, `failed for mode=${s.mode}`).toEqual([]);
      expect(check.valid).toBe(true);
      expect(layout.containerTotalNum).toBeLessThanOrEqual(G2_MAX_CONTAINERS);
      expect(layout.totalChars).toBeLessThanOrEqual(G2_MAX_CREATE_CHARS);
      expect(layout.textObject.filter((c) => c.isEventCapture === 1)).toHaveLength(1);
    }
  });

  it('strips emoji and preserves G2-safe symbols', () => {
    const cleaned = sanitizeForG2('🚨 AAVE HEALTH 1.12 🔥 ████░░ · TAP ▶');
    expect(hasEmoji(cleaned)).toBe(false);
    expect(cleaned).toContain('AAVE HEALTH 1.12');
    expect(cleaned).toContain('████░░');
  });

  it('flags financial-advice phrasing in layout validator', () => {
    expect(hasAdviceLanguage('We recommend you should buy ETH now')).toBe(true);
    expect(hasAdviceLanguage('AAVE HF 1.12 < 1.35 LIMIT · TAP: REPAY 300 USDC')).toBe(false);
  });

  it('rejects layouts exceeding 1000 chars or having != 1 event capture container', () => {
    const bad = renderLensPage({ mode: 'error', paired: true, errorMessage: 'ok' });
    bad.textObject[0]!.content = 'X'.repeat(1005);
    expect(validateLensLayout(bad).valid).toBe(false);

    const twoCapture = renderLensPage({ mode: 'voice_listening', paired: true });
    twoCapture.textObject[0]!.isEventCapture = 1;
    expect(validateLensLayout(twoCapture).valid).toBe(false);
  });
});
