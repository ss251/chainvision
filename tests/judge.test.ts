import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BRIEF_EMPTY_TEXT, SIGNAL_LENS_LINE_MAX, renderLensPage, signalLensLine } from '@chainvision/shared';
import {
  HL_ACCOUNT_ADDRESS,
  HL_FILL_EXPLORER_URL,
  JUDGE_STEPS,
  JudgeWalkthrough,
  PROVENANCE_DEFINITIONS,
  RECORDED_FALLBACK_PRICES,
  SEPOLIA_PAYOUT_20_HASH,
  VERIFIED_PROOFS,
  validateAllJudgeSteps,
  validateJudgeLensLayout,
} from '../packages/judge/src/scenarios.js';
import { createServer } from '../packages/server/src/index.js';

describe('zero-key /judge walkthrough', () => {
  it('validates every step, tap result, voice card, and position page against Even G2 limits and <= 60 chars/line', () => {
    const res = validateAllJudgeSteps(RECORDED_FALLBACK_PRICES);
    expect(res.errors).toEqual([]);
    expect(res.valid).toBe(true);
    expect(res.checkedStates).toBeGreaterThanOrEqual(15);

    const liveRes = validateAllJudgeSteps({
      ...RECORDED_FALLBACK_PRICES,
      feedState: 'live',
      liveSources: ['Hyperliquid Testnet', 'Coinbase Public', 'Binance Testnet', 'Bybit Testnet'],
      updatedAt: 1_764_052_000_000,
    });
    expect(liveRes.errors).toEqual([]);
    expect(liveRes.valid).toBe(true);
  });

  it('fails loudly if any rendered lens container has a line over 60 characters', () => {
    const layout = renderLensPage({
      mode: 'result',
      paired: true,
      lastReceipt: {
        id: 'rcpt_over',
        actionId: 'act_1',
        protocol: 'bybit',
        actionType: 'bybit_transfer',
        network: 'bybit-testnet',
        summary: 'BYBIT MOVE 500 USDT FUNDING TO TRADING',
        beforeFact: 'TRADING FREE $182.40 · FUNDING 1200',
        afterFact: 'TRADING FREE $682.40 · FUNDING 700',
        txHashOrOrderId: 'example',
        explorerUrl: 'https://testnet.bybit.com',
        telegramPosted: false,
        timestamp: 1_764_052_000_000,
      },
    });
    const check = validateJudgeLensLayout(layout);
    expect(check.valid).toBe(false);
    expect(check.errors.some((e) => e.includes('exceeds 60 chars'))).toBe(true);
  });

  it('starts on a truly blank idle lens with 0 lit characters', () => {
    const walk = new JudgeWalkthrough(() => 1_764_052_000_000);
    const snap = walk.snapshot();
    expect(snap.step.id).toBe('blank');
    expect(snap.lensState.mode).toBe('idle');
    expect(snap.litChars).toBe(0);
    expect(snap.validation.valid).toBe(true);
  });

  it('walks exchange margin, Hyperliquid trim, Telegram /ask, and voice brief with truthful labels and <= 60 chars', () => {
    const walk = new JudgeWalkthrough(() => 1_764_052_000_000);

    // Exchange margin -> example action, no TG message sent, <= 60 chars after tap
    const ex = walk.selectStep('exchange_margin');
    expect(ex.lensState.mode).toBe('signal');
    expect(ex.provenance.kind).toBe('example');
    const exLine = signalLensLine(ex.lensState.signal!);
    expect(exLine).toContain('BYBIT MARGIN LOW');
    expect(exLine).toContain('MOVE 500 USDT FUNDING TO TRADING');
    expect(exLine.length).toBeLessThanOrEqual(SIGNAL_LENS_LINE_MAX);
    const exDone = walk.tap();
    expect(exDone.lensState.mode).toBe('result');
    expect(exDone.provenance.kind).toBe('example');
    expect(exDone.lensState.lastReceipt?.telegramPosted).toBe(false);
    expect(exDone.layout.textObject[1]?.content).toContain('LOCAL RECEIPT');
    expect(exDone.layout.textObject[1]?.content).not.toContain('TG RECEIPT SENT');
    expect(exDone.lensLineLength).toBeLessThanOrEqual(SIGNAL_LENS_LINE_MAX);
    expect(exDone.validation.valid).toBe(true);
    expect(exDone.telegramMessages).toHaveLength(0);

    // Hyperliquid liquidation -> scripted example line, recorded fill receipt on tap
    const hl = walk.selectStep('hl_liq');
    expect(hl.provenance.kind).toBe('example');
    const hlLine = signalLensLine(hl.lensState.signal!);
    expect(hlLine).toContain('HL ETH LONG');
    expect(hlLine).toContain('LIQ ~4m');
    expect(hlLine).toContain('TRIM 50% ETH');
    expect(hlLine.length).toBeLessThanOrEqual(SIGNAL_LENS_LINE_MAX);
    const hlDone = walk.tap();
    expect(hlDone.lensState.mode).toBe('result');
    expect(hlDone.provenance.kind).toBe('recorded');
    expect(hlDone.provenance.proofUrl).toBe(HL_FILL_EXPLORER_URL);
    expect(hlDone.lensState.lastReceipt?.txHashOrOrderId).toBe('65942782652');
    expect(hlDone.lensLineLength).toBeLessThanOrEqual(SIGNAL_LENS_LINE_MAX);

    // Telegram /ask -> switching steps clears prior HL Telegram receipt before tapping
    const tg = walk.selectStep('telegram_request');
    expect(tg.telegramMessages).toHaveLength(0);
    expect(tg.provenance.kind).toBe('recorded');
    expect(tg.provenance.proofUrl).toContain(SEPOLIA_PAYOUT_20_HASH);
    const tgLine = signalLensLine(tg.lensState.signal!);
    expect(tgLine).toBe('KIT ASKS 20 USDC - TAP: PAY');
    const tgDone = walk.tap();
    expect(tgDone.lensState.mode).toBe('result');
    expect(tgDone.provenance.kind).toBe('recorded');
    expect(tgDone.lensState.lastReceipt?.txHashOrOrderId).toBe(SEPOLIA_PAYOUT_20_HASH);
    expect(tgDone.telegramMessages).toHaveLength(1);

    // Voice brief after all three signals resolved -> clears prior Sepolia receipt and shows NOTHING NEEDS YOU
    const emptyBrief = walk.selectStep('voice_brief');
    expect(emptyBrief.telegramMessages).toHaveLength(0);
    expect(emptyBrief.lensState.mode).toBe('brief');
    expect(emptyBrief.layout.textObject[1]?.content).toBe(BRIEF_EMPTY_TEXT);

    // Reset queue -> voice brief shows ranked signals
    walk.resetQueue();
    const rankedBrief = walk.selectStep('voice_brief');
    expect(rankedBrief.lensState.briefLines?.length).toBe(3);
  });

  it('enforces the three-label provenance contract: every recorded state carries a direct proof link and stale feeds never claim LIVE', () => {
    expect(Object.keys(PROVENANCE_DEFINITIONS).sort()).toEqual(['example', 'live', 'recorded']);

    // Unavailable feeds: nothing may claim LIVE or "live mark"
    const offline = new JudgeWalkthrough(() => 1_764_052_000_000);
    offline.updatePrices({ feedState: 'unavailable', liveSources: [], updatedAt: null });

    const offlineSnapshots = [
      ...JUDGE_STEPS.map((s) => offline.selectStep(s.id)),
      offline.triggerVoiceBinanceCard(),
      offline.tap(),
      offline.swipeUp(),
    ];

    for (const snap of offlineSnapshots) {
      expect(['recorded', 'live', 'example']).toContain(snap.provenance.kind);
      expect(snap.provenance.kind).not.toBe('live');
      expect(snap.provenance.badgeText).not.toContain('LIVE');
      expect(snap.lastActionNote.toLowerCase()).not.toContain('live mark');
      if (snap.provenance.kind === 'recorded') {
        expect(snap.provenance.proofUrl).toBeTruthy();
        expect(snap.provenance.proofUrl).toMatch(/^https:\/\//);
        expect(snap.provenance.proofUrl).not.toMatch(/\/explorer\/?$/);
      }
    }

    // Live feeds: two-venue Binance/Coinbase confirm card uses LIVE PUBLIC DATA with timestamp
    const online = new JudgeWalkthrough(() => 1_764_052_000_000);
    online.updatePrices({
      binanceBtc: 61000,
      coinbaseBtc: 60950,
      feedState: 'live',
      liveSources: ['Binance Testnet', 'Coinbase Public'],
      updatedAt: 1_764_052_000_000,
    });
    const card = online.triggerVoiceBinanceCard();
    expect(card.provenance.kind).toBe('live');
    expect(card.provenance.badgeText).toContain('LIVE PUBLIC DATA');
    expect(card.provenance.badgeText).toContain('UTC');
    expect(card.lensState.pendingAction?.comparisonLine).toBe('BINANCE TESTNET $61000 | COINBASE $60950');
    expect(card.validation.valid).toBe(true);

    // Tapping the example Binance voice order never claims TG RECEIPT SENT
    const tappedOrder = online.tap();
    expect(tappedOrder.provenance.kind).toBe('example');
    expect(tappedOrder.lensState.lastReceipt?.telegramPosted).toBe(false);
    expect(tappedOrder.layout.textObject[1]?.content).toContain('LOCAL RECEIPT');

    // Every recorded proof in the table points to a specific tx or account page (never an explorer homepage)
    expect(VERIFIED_PROOFS.length).toBeGreaterThanOrEqual(5);
    for (const proof of VERIFIED_PROOFS) {
      expect(proof.explorerUrl).toMatch(/^https:\/\//);
      expect(proof.explorerUrl).not.toMatch(/\/explorer\/?$/);
    }
    expect(VERIFIED_PROOFS.find((p) => p.id === 'hl_trim')?.explorerUrl).toContain(HL_ACCOUNT_ADDRESS);
  });

  it('declines a Telegram money request on swipe down as an example without moving funds', () => {
    const walk = new JudgeWalkthrough(() => 1_764_052_000_000);
    walk.selectStep('telegram_request');
    const declined = walk.swipeDown();
    expect(declined.lensState.mode).toBe('idle');
    expect(declined.provenance.kind).toBe('example');
    expect(declined.litChars).toBe(0);
    expect(declined.lastActionNote).toContain('no funds moved');
  });
});

describe('server /judge and /judge/ routes', () => {
  let baseUrl = '';
  let closeServer: () => Promise<void>;

  beforeAll(async () => {
    const { server, wss, engine } = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
    closeServer = async () => {
      engine.stop();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
  });

  afterAll(async () => {
    if (closeServer) await closeServer();
  });

  it('redirects /judge to /judge/ so relative assets resolve cleanly on both routes', async () => {
    const noFollow = await fetch(`${baseUrl}/judge`, { redirect: 'manual' });
    expect(noFollow.status).toBe(302);
    expect(noFollow.headers.get('location')).toBe('/judge/');

    const followed = await fetch(`${baseUrl}/judge`);
    expect(followed.status).toBe(200);
    expect(followed.url).toBe(`${baseUrl}/judge/`);
    const html = await followed.text();
    expect(html).toContain('id="app"');

    const slashRes = await fetch(`${baseUrl}/judge/`);
    expect(slashRes.status).toBe(200);
    const slashHtml = await slashRes.text();
    const assetMatches = [...slashHtml.matchAll(/(?:src|href)="(\.\/assets\/[^"]+)"/g)].map((m) => m[1]!);
    expect(assetMatches.length).toBeGreaterThanOrEqual(2);

    for (const rel of assetMatches) {
      const assetUrl = new URL(rel, `${baseUrl}/judge/`).toString();
      const assetRes = await fetch(assetUrl);
      expect(assetRes.status).toBe(200);
    }
  });

  it('rejects non-GET requests and sibling paths on /judge', async () => {
    const postRes = await fetch(`${baseUrl}/judge`, { method: 'POST' });
    expect(postRes.status).toBe(404);
    const sibling = await fetch(`${baseUrl}/judgex`);
    expect(sibling.status).toBe(404);
  });
});
