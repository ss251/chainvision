import { describe, expect, it } from 'vitest';
import {
  SIGNAL_RESHOW_MS,
  SIGNAL_SHOW_MS,
  renderLensPage,
  validateLensLayout,
  type ExecutionReceipt,
  type ProtocolSnapshots,
} from '@chainvision/shared';
import { loadConfig } from '../packages/server/src/config.js';
import { ChainVisionEngine } from '../packages/server/src/watcher/engine.js';

const NOW = Date.now();

function calm(): ProtocolSnapshots {
  return {
    updatedAt: NOW,
    aave: {
      network: 'sepolia',
      address: '0x537B1ED6f937C1A27e7C6249026732565B381fB0',
      healthFactor: 2.1,
      totalCollateralUsd: 900,
      totalDebtUsd: 400,
      availableBorrowsUsd: 300,
      currentLiquidationThresholdPct: 82,
      ltvPct: 75,
      usdcBalance: 500,
      daiBalance: 200,
      ethBalance: 0.1,
      rates: [],
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
      ethMarkPx: 1784,
      btcMarkPx: 62000,
      ethFundingPctHr: 0.001,
      markPrices: { ETH: 1784, BTC: 62000, SOL: 140 },
      positions: [],
    },
    exchange: {
      venue: 'bybit-testnet',
      mode: 'public',
      ethMarkPx: 1785,
      ethFundingPct: 0.01,
      equityUsd: null,
      positions: [],
    },
  };
}

function risky(): ProtocolSnapshots {
  const s = calm();
  s.aave.healthFactor = 1.3;
  s.hyperliquid.positions = [
    {
      coin: 'ETH',
      side: 'LONG',
      size: 0.5,
      entryPx: 1900,
      markPx: 1784,
      liquidationPx: 1700,
      liqDistancePct: 4.7,
      unrealizedPnlUsd: -58,
      leverage: 5,
      notionalUsd: 892,
    },
  ];
  s.uniswap.lpPositions = [
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
  return s;
}

function lensChars(engine: ChainVisionEngine, now: number): number {
  const layout = renderLensPage(engine.getLensState(now));
  expect(validateLensLayout(layout).errors).toEqual([]);
  return layout.totalChars;
}

describe('one queue, one line', () => {
  it('keeps the lens blank (0 lit characters) when the queue is empty', () => {
    const engine = new ChainVisionEngine(loadConfig());
    engine.applySnapshots(calm(), NOW);
    engine.tick(NOW);
    expect(engine.queue.size).toBe(0);
    expect(engine.getLensState(NOW).mode).toBe('idle');
    expect(lensChars(engine, NOW)).toBe(0);
  });

  it('feeds every watcher into one ranked queue and shows only the top signal', () => {
    const engine = new ChainVisionEngine(loadConfig());
    const ranked = engine.applySnapshots(risky(), NOW);
    expect(ranked.map((s) => s.id)).toEqual(['hyperliquid:liq:ETH', 'aave:health', 'uniswap:range:99']);
    const state = engine.getLensState(NOW);
    expect(state.mode).toBe('signal');
    expect(state.signal?.id).toBe('hyperliquid:liq:ETH');
    expect(renderLensPage(state).textObject[0]?.content).toBe('HL ETH LONG LIQ 4.7% AWAY - TAP: TRIM 50% ETH');
    expect(state.queueSize).toBe(3);
  });

  it('swipe down dismisses the shown signal and shows the next, then blank', () => {
    const engine = new ChainVisionEngine(loadConfig());
    engine.applySnapshots(risky(), NOW);
    engine.dismissToBlank(NOW);
    expect(engine.getLensState(NOW).signal?.id).toBe('aave:health');
    engine.dismissToBlank(NOW);
    expect(engine.getLensState(NOW).signal?.id).toBe('uniswap:range:99');
    engine.dismissToBlank(NOW);
    expect(engine.getLensState(NOW).mode).toBe('idle');
    expect(lensChars(engine, NOW)).toBe(0);
  });

  it('blanks a shown line after about 10 s untouched, and brings it back only if it still matters', () => {
    const engine = new ChainVisionEngine(loadConfig());
    engine.applySnapshots(risky(), NOW);
    engine.tick(NOW);
    engine.tick(NOW + SIGNAL_SHOW_MS - 1000);
    expect(engine.getLensState(NOW + SIGNAL_SHOW_MS - 1000).mode).toBe('signal');
    engine.tick(NOW + SIGNAL_SHOW_MS);
    expect(engine.getLensState(NOW + SIGNAL_SHOW_MS).mode).toBe('idle');

    const later = NOW + SIGNAL_SHOW_MS + SIGNAL_RESHOW_MS;
    const stillRisky = risky();
    stillRisky.uniswap.lpPositions = [];
    stillRisky.hyperliquid.positions = [];
    engine.applySnapshots(stillRisky, later - 1);
    engine.tick(later);
    expect(engine.getLensState(later).signal?.id).toBe('aave:health');

    const calmLater = later + SIGNAL_SHOW_MS + SIGNAL_RESHOW_MS;
    engine.applySnapshots(calm(), calmLater - 1);
    engine.tick(calmLater);
    expect(engine.getLensState(calmLater).mode).toBe('idle');
    expect(lensChars(engine, calmLater)).toBe(0);
  });

  it('a tap approves the shown signal\'s action through the confirm path, then the line leaves the queue', async () => {
    const engine = new ChainVisionEngine(loadConfig());
    const snap = risky();
    snap.hyperliquid.positions = [];
    snap.uniswap.lpPositions = [];
    engine.applySnapshots(snap, Date.now());
    const shown = engine.getLensState().signal;
    expect(shown?.action?.actionType).toBe('aave_repay');

    const executed: string[] = [];
    engine.executeAction = async (action) => {
      executed.push(action.id);
      return {
        id: 'rcpt_test',
        actionId: action.id,
        protocol: 'aave',
        actionType: 'aave_repay',
        network: 'sepolia',
        summary: action.actionPrompt,
        beforeFact: 'HF 1.30',
        afterFact: 'HF 1.60',
        txHashOrOrderId: '0xabc',
        explorerUrl: 'https://sepolia.etherscan.io/tx/0xabc',
        telegramPosted: false,
        timestamp: Date.now(),
      } satisfies ExecutionReceipt;
    };
    engine.pollNow = async () => {
      engine.applySnapshots(calm());
      return calm();
    };

    await expect(engine.confirmPendingAction('act_not_shown')).rejects.toThrow(/No matching pending action/);
    const receipt = await engine.confirmPendingAction(shown!.action!.id);
    expect(executed).toEqual([shown!.action!.id]);
    expect(receipt.summary).toBe('REPAY 200 USDC');
    expect(engine.getLensState().mode).toBe('result');
    expect(engine.queue.get('aave:health')).toBeNull();
  });

  it('refuses to execute a signal action that is queued but not on the lens', async () => {
    const engine = new ChainVisionEngine(loadConfig());
    engine.applySnapshots(risky(), Date.now());
    const second = engine.queue.ranked(Date.now())[1];
    engine.executeAction = async () => {
      throw new Error('must not execute');
    };
    await expect(engine.confirmPendingAction(second!.action!.id)).rejects.toThrow(/No matching pending action/);
  });
});

describe('"What matters?" brief', () => {
  it('shows at most three ranked lines read-only, then blanks itself', () => {
    const engine = new ChainVisionEngine(loadConfig());
    const snap = risky();
    snap.exchange.positions = [
      { symbol: 'ETHUSDT', side: 'LONG', size: 1, entryPx: 1900, markPx: 1784, unrealizedPnlUsd: -116, liqDistancePct: 8 },
    ];
    engine.applySnapshots(snap, NOW);
    expect(engine.queue.size).toBe(4);
    const lines = engine.showBrief(NOW);
    expect(lines).toEqual(['HL ETH LONG LIQ 4.7% AWAY', 'BYBIT ETHUSDT LONG LIQ 8.0% AWAY', 'AAVE HEALTH 1.30 (LIMIT 1.35)']);
    const layout = renderLensPage(engine.getLensState(NOW));
    expect(layout.textObject.map((c) => c.content).join('\n')).not.toContain('TAP');
    expect(validateLensLayout(layout).valid).toBe(true);
    engine.tick(NOW + 10_000);
    expect(engine.getLensState(NOW + 10_000).mode).toBe('signal');
  });

  it('says so in three words when nothing matters', async () => {
    const engine = new ChainVisionEngine(loadConfig());
    engine.applySnapshots(calm(), NOW);
    const out = await engine.handleVoiceTranscript('what matters?');
    expect(out.parse.intent.action).toBe('brief');
    const layout = renderLensPage(engine.getLensState());
    expect(layout.textObject[1]?.content).toBe('NOTHING NEEDS YOU');
  });
});

describe('alerts set by voice', () => {
  it('stores a rule, raises a signal when the live price crosses it, and fires only once', async () => {
    const engine = new ChainVisionEngine(loadConfig());
    engine.applySnapshots(calm(), NOW);
    const out = await engine.handleVoiceTranscript('tell me if ETH drops below 1700');
    expect(out.parse.intent).toMatchObject({ action: 'price_alert', asset: 'ETH', direction: 'below', price: 1700 });
    expect(out.alert?.ok).toBe(true);
    expect(engine.getLensState().noticeText).toBe('ALERT SET: ETH BELOW 1700');
    expect(engine.listAlerts()).toHaveLength(1);

    expect(engine.evaluateAlerts({ ETH: 1712 }, NOW + 1000)).toEqual([]);
    const fired = engine.evaluateAlerts({ ETH: 1699.5 }, NOW + 2000);
    expect(fired).toHaveLength(1);
    expect(engine.listAlerts()).toHaveLength(0);
    expect(engine.queue.ranked(NOW + 2000)[0]?.line).toBe('ETH TESTNET 1699.5 BELOW 1700');
    expect(engine.evaluateAlerts({ ETH: 1650 }, NOW + 3000)).toEqual([]);
  });

  it('refuses a rule the price has already crossed and lets a rule be removed', async () => {
    const engine = new ChainVisionEngine(loadConfig());
    engine.applySnapshots(calm(), NOW);
    const refused = await engine.addAlert({ asset: 'ETH', direction: 'below', price: 1800 }, 'api');
    expect(refused).toEqual({ ok: false, reason: 'ETH ALREADY AT OR BELOW 1800' });
    const added = await engine.addAlert({ asset: 'BTC', direction: 'above', price: 70000 }, 'miniapp');
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(engine.removeAlert(added.rule.id)).toBe(true);
    expect(engine.removeAlert(added.rule.id)).toBe(false);
    expect(engine.listAlerts()).toEqual([]);
  });
});
