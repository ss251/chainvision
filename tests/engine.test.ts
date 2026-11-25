import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, type ProtocolSnapshots } from '@chainvision/shared';
import { loadConfig } from '../packages/server/src/config.js';
import { formatReceiptText, formatShareSnippet } from '../packages/server/src/telegram/bot.js';
import { pcm16ToWav } from '../packages/server/src/voice/stt.js';
import { ChainVisionEngine } from '../packages/server/src/watcher/engine.js';

function makeSnapshots(overrides?: Partial<ProtocolSnapshots>): ProtocolSnapshots {
  return {
    updatedAt: Date.now(),
    aave: {
      network: 'sepolia',
      address: '0x537B1ED6f937C1A27e7C6249026732565B381fB0',
      healthFactor: 2.1,
      totalCollateralUsd: 1000,
      totalDebtUsd: 400,
      availableBorrowsUsd: 300,
      currentLiquidationThresholdPct: 82,
      ltvPct: 75,
      usdcBalance: 500,
      daiBalance: 200,
      ethBalance: 0.1,
      rates: [{ symbol: 'USDC', address: '0x94a9', supplyApyPct: 4.5, borrowApyPct: 6.0 }],
    },
    uniswap: {
      network: 'sepolia',
      address: '0x537B1ED6f937C1A27e7C6249026732565B381fB0',
      poolAddress: '0x3289680dd4d6c10bb19b899729cda5eef58aeff1',
      pair: 'WETH/USDC',
      feeTier: 500,
      currentTick: 172652,
      ethQuoteUsdc: 31760,
      usdcToDaiRate: 3.43,
      lpPositions: [],
    },
    hyperliquid: {
      network: 'hyperliquid-testnet',
      accountAddress: '0x1111111111111111111111111111111111111111',
      agentAddress: '0x9C11bc8695Ac49E17b755981f621c89b27f8882d',
      accountValueUsd: 1000,
      marginUsedUsd: 100,
      ethMarkPx: 1800,
      btcMarkPx: 62000,
      ethFundingPctHr: 0.001,
      positions: [],
    },
    exchange: {
      venue: 'bybit-testnet',
      mode: 'public',
      ethMarkPx: 1800,
      ethFundingPct: 0.01,
      equityUsd: null,
      positions: [],
    },
    ...overrides,
  };
}

describe('ChainVisionEngine watcher, pairing & receipts', () => {
  it('stays blank (no alert) when all positions are within user thresholds', () => {
    const engine = new ChainVisionEngine(loadConfig());
    const alert = engine.evaluateThresholds(makeSnapshots());
    expect(alert).toBeNull();
    expect(engine.getLensState().mode).toBe('idle');
  });

  it('triggers Aave repay card when health factor drops below threshold', () => {
    const engine = new ChainVisionEngine(loadConfig());
    const snap = makeSnapshots();
    snap.aave.healthFactor = 1.12;
    snap.aave.totalDebtUsd = 600;
    const alert = engine.evaluateThresholds(snap);
    expect(alert).not.toBeNull();
    expect(alert?.actionType).toBe('aave_repay');
    expect(alert?.requiresTap).toBe(true);
    expect(alert?.headline).toContain('1.12');
    expect(alert?.actionPrompt).toContain('REPAY');
  });

  it('triggers Hyperliquid trim card when liquidation distance drops below threshold', () => {
    const engine = new ChainVisionEngine(loadConfig());
    const snap = makeSnapshots();
    snap.hyperliquid.positions = [
      {
        coin: 'ETH',
        side: 'LONG',
        size: 0.5,
        entryPx: 1900,
        markPx: 1800,
        liquidationPx: 1700,
        liqDistancePct: 5.5,
        unrealizedPnlUsd: -50,
        leverage: 5,
        notionalUsd: 900,
      },
    ];
    const alert = engine.evaluateThresholds(snap);
    expect(alert?.actionType).toBe('hl_trim');
    expect(alert?.actionPrompt).toBe(`TRIM ${DEFAULT_THRESHOLDS.hlDefaultTrimPct}% ETH`);
  });

  it('triggers Uniswap out-of-range alert when LP tick is outside range', () => {
    const engine = new ChainVisionEngine(loadConfig());
    const snap = makeSnapshots();
    snap.uniswap.lpPositions = [
      {
        tokenId: '99',
        pair: 'WETH/USDC',
        feeTier: 500,
        tickLower: 170000,
        tickUpper: 171000,
        currentTick: 172652,
        inRange: false,
        liquidity: '10000',
      },
    ];
    const alert = engine.evaluateThresholds(snap);
    expect(alert?.protocol).toBe('uniswap');
    expect(alert?.headline).toContain('OUT OF RANGE');
  });

  it('enforces exact 6-digit pairing code and updates thresholds safely', () => {
    const engine = new ChainVisionEngine(loadConfig());
    const code = engine.getSession().code;
    expect(code).toMatch(/^\d{6}$/);

    const bad = engine.pairFromMiniApp({ code: '000000' });
    expect(bad.ok).toBe(false);

    const good = engine.pairFromMiniApp({
      code,
      walletAddress: '0x537B1ED6f937C1A27e7C6249026732565B381fB0',
      telegramChatId: '123456',
      thresholds: { aaveMinHealthFactor: 1.5, maxUsdcAction: 400 },
    });
    expect(good.ok).toBe(true);
    expect(good.session.thresholds.aaveMinHealthFactor).toBe(1.5);
    expect(good.session.thresholds.maxUsdcAction).toBe(400);
    expect(good.session.pairedAt).not.toBeNull();
  });

  it('encodes valid RIFF/WAV header for 16kHz mono s16le PCM', () => {
    const pcm = Buffer.alloc(3200);
    const wav = pcm16ToWav(pcm);
    expect(wav.length).toBe(3244);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(34)).toBe(16);
  });

  it('formats voice aave_supply confirm card with apples-to-apples annualized testnet yields', async () => {
    const engine = new ChainVisionEngine(loadConfig());
    const snap = makeSnapshots();
    snap.aave.rates = [{ symbol: 'USDC', address: '0x94a9', supplyApyPct: 57.59, borrowApyPct: 60 }];
    snap.hyperliquid.ethFundingPctHr = 0.00125; // ~10.95% APR
    snap.exchange.ethFundingPct = 0.0025; // ~2.74% APR

    const action = await engine.buildActionFromIntent(
      { action: 'aave_supply', token: 'USDC', amount: 200, compareVenues: true, confidence: 0.95 },
      snap,
    );
    expect(action).not.toBeNull();
    expect(action?.factLine).toContain('APY');
    expect(action?.factLine).toContain('APR');
    expect(action?.factLine).not.toContain('FEE');
    expect(action?.comparisonLine).toContain('TESTNET');
  });

  it('routes voice USDC supply transparently to EURS when Sepolia USDC supply cap is reached', async () => {
    const engine = new ChainVisionEngine(loadConfig());
    const snap = makeSnapshots();
    snap.aave.rates = [
      { symbol: 'USDC', address: '0x94a9', supplyApyPct: 57.59, borrowApyPct: 60, supplyCapReached: true },
      { symbol: 'EURS', address: '0x6d90', supplyApyPct: 2.26, borrowApyPct: 3.28, supplyCapReached: false },
    ];
    const action = await engine.buildActionFromIntent(
      { action: 'aave_supply', token: 'USDC', amount: 200, compareVenues: true, confidence: 0.95 },
      snap,
    );
    expect(action).not.toBeNull();
    expect(action?.params.tokenIn).toBe('EURS');
    expect(action?.headline).toContain('USDC CAP FULL');
    expect(action?.factLine).toContain('AAVE 2.3% APY');
  });

  it('formats Telegram receipts with testnet & non-advice notice', () => {
    const receipt = {
      id: 'r1',
      actionId: 'a1',
      protocol: 'aave' as const,
      actionType: 'aave_repay' as const,
      network: 'sepolia' as const,
      summary: 'AAVE REPAY 300 USDC',
      beforeFact: 'HF 1.12',
      afterFact: 'HF 1.84',
      txHashOrOrderId: '0xabc',
      explorerUrl: 'https://sepolia.etherscan.io/tx/0xabc',
      telegramPosted: true,
      timestamp: Date.now(),
    };
    const text = formatReceiptText(receipt);
    const share = formatShareSnippet(receipt);
    expect(text).toContain('Testnet only');
    expect(text).toContain('Not financial advice');
    expect(text).toContain(receipt.explorerUrl);
    expect(share).toContain('HF 1.12 -> HF 1.84');
  });
});
