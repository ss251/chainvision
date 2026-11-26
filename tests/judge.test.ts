import { describe, expect, it } from 'vitest';
import { BRIEF_EMPTY_TEXT, SIGNAL_LENS_LINE_MAX, signalLensLine } from '@chainvision/shared';
import {
  JUDGE_STEPS,
  JudgeWalkthrough,
  RECORDED_FALLBACK_PRICES,
  VERIFIED_PROOFS,
  validateAllJudgeSteps,
} from '../packages/judge/src/scenarios.js';

describe('zero-key /judge walkthrough', () => {
  it('validates every step, tap result, voice card, and position page against Even G2 limits', () => {
    const res = validateAllJudgeSteps(RECORDED_FALLBACK_PRICES);
    expect(res.errors).toEqual([]);
    expect(res.valid).toBe(true);
    expect(res.checkedStates).toBeGreaterThanOrEqual(15);
  });

  it('starts on a truly blank idle lens with 0 lit characters', () => {
    const walk = new JudgeWalkthrough(() => 1_764_052_000_000);
    const snap = walk.snapshot();
    expect(snap.step.id).toBe('blank');
    expect(snap.lensState.mode).toBe('idle');
    expect(snap.litChars).toBe(0);
    expect(snap.validation.valid).toBe(true);
  });

  it('walks exchange margin, Hyperliquid trim, Telegram /ask, and voice brief cleanly', () => {
    const walk = new JudgeWalkthrough(() => 1_764_052_000_000);

    // Exchange margin -> one-tap move
    const ex = walk.selectStep('exchange_margin');
    expect(ex.lensState.mode).toBe('signal');
    const exLine = signalLensLine(ex.lensState.signal!);
    expect(exLine).toContain('BYBIT MARGIN LOW');
    expect(exLine).toContain('MOVE 500 USDT FUNDING TO TRADING');
    expect(exLine.length).toBeLessThanOrEqual(SIGNAL_LENS_LINE_MAX);
    const exDone = walk.tap();
    expect(exDone.lensState.mode).toBe('result');
    expect(exDone.lensState.lastReceipt?.network).toBe('bybit-testnet');
    expect(exDone.telegramMessages).toHaveLength(1);

    // Hyperliquid liquidation -> one-tap trim (recorded order 65942782652)
    const hl = walk.selectStep('hl_liq');
    const hlLine = signalLensLine(hl.lensState.signal!);
    expect(hlLine).toContain('HL ETH LONG');
    expect(hlLine).toContain('LIQ ~4m');
    expect(hlLine).toContain('TRIM 50% ETH');
    expect(hlLine.length).toBeLessThanOrEqual(SIGNAL_LENS_LINE_MAX);
    const hlDone = walk.tap();
    expect(hlDone.lensState.mode).toBe('result');
    expect(hlDone.lensState.lastReceipt?.txHashOrOrderId).toBe('65942782652');
    expect(hlDone.step.provenance).toBe('recorded_testnet');

    // Telegram /ask -> tap to pay (recorded Sepolia tx 0xc453a91d...d8178d)
    const tg = walk.selectStep('telegram_request');
    const tgLine = signalLensLine(tg.lensState.signal!);
    expect(tgLine).toBe('KIT ASKS 20 USDC - TAP: PAY');
    const tgDone = walk.tap();
    expect(tgDone.lensState.mode).toBe('result');
    expect(tgDone.lensState.lastReceipt?.txHashOrOrderId).toBe(
      '0xc453a91d030307a604667169047689f8703f8cc98de4281c4a33fa5252d8178d',
    );
    expect(tgDone.telegramMessages).toHaveLength(2);

    // Voice brief after all three signals resolved -> NOTHING NEEDS YOU
    const emptyBrief = walk.selectStep('voice_brief');
    expect(emptyBrief.lensState.mode).toBe('brief');
    expect(emptyBrief.layout.textObject[1]?.content).toBe(BRIEF_EMPTY_TEXT);

    // Reset queue -> voice brief shows ranked signals
    walk.resetQueue();
    const rankedBrief = walk.selectStep('voice_brief');
    expect(rankedBrief.lensState.briefLines?.length).toBe(3);
  });

  it('declines a Telegram money request politely on swipe down without moving funds', () => {
    const walk = new JudgeWalkthrough(() => 1_764_052_000_000);
    walk.selectStep('telegram_request');
    const declined = walk.swipeDown();
    expect(declined.lensState.mode).toBe('idle');
    expect(declined.litChars).toBe(0);
    expect(declined.telegramMessages[0]?.lines.join(' ')).toContain('No funds moved');
  });

  it('includes live two-venue prices on the voice Binance confirm card and valid HTTPS proofs', () => {
    const walk = new JudgeWalkthrough(() => 1_764_052_000_000);
    walk.updatePrices({ binanceBtc: 61000, coinbaseBtc: 60950, liveSources: ['Binance Testnet', 'Coinbase Public'] });
    const card = walk.triggerVoiceBinanceCard();
    expect(card.lensState.mode).toBe('confirm');
    expect(card.lensState.pendingAction?.comparisonLine).toBe('BINANCE TESTNET $61000 | COINBASE $60950');
    expect(card.validation.valid).toBe(true);

    expect(JUDGE_STEPS).toHaveLength(5);
    expect(VERIFIED_PROOFS.length).toBeGreaterThanOrEqual(5);
    for (const proof of VERIFIED_PROOFS) {
      expect(proof.explorerUrl.startsWith('https://')).toBe(true);
    }
  });
});
