import { describe, expect, it } from 'vitest';
import {
  BRIEF_EMPTY_TEXT,
  SIGNAL_DISMISS_MS,
  SIGNAL_LENS_LINE_MAX,
  SignalQueue,
  checkNewRule,
  compareSignals,
  priceAlertSignal,
  rankSignals,
  renderLensPage,
  ruleCrossed,
  signalLensLine,
  validateLensLayout,
  type PendingAction,
  type PriceAlertRule,
  type Signal,
} from '@chainvision/shared';

const NOW = 1_800_000_000_000;

function sig(over: Partial<Signal> & Pick<Signal, 'id'>): Signal {
  return {
    source: 'aave',
    kind: 'loan_health',
    severity: 'warning',
    line: over.id.toUpperCase(),
    action: null,
    lossDistancePct: null,
    usdAtRisk: 0,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + 60_000,
    ...over,
  };
}

function action(prompt: string, id = 'act_x'): PendingAction {
  return {
    id,
    source: 'watcher',
    protocol: 'aave',
    actionType: 'aave_repay',
    headline: 'H',
    factLine: 'F',
    actionPrompt: prompt,
    params: { tokenIn: 'USDC', amount: 300 },
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    requiresTap: true,
  };
}

describe('signal ranking: money at risk soonest first', () => {
  it('puts critical before warning before notice regardless of other fields', () => {
    const ranked = rankSignals([
      sig({ id: 'notice', severity: 'notice', lossDistancePct: 0.1, usdAtRisk: 1e6 }),
      sig({ id: 'warn', severity: 'warning', lossDistancePct: 1, usdAtRisk: 10 }),
      sig({ id: 'crit', severity: 'critical', lossDistancePct: 40, usdAtRisk: 1 }),
    ]);
    expect(ranked.map((s) => s.id)).toEqual(['crit', 'warn', 'notice']);
  });

  it('within a severity, ranks money at risk first and the smallest loss distance first', () => {
    const ranked = rankSignals([
      sig({ id: 'no-risk', lossDistancePct: null, usdAtRisk: 5000 }),
      sig({ id: 'far', lossDistancePct: 9, usdAtRisk: 100 }),
      sig({ id: 'near', lossDistancePct: 4.5, usdAtRisk: 100 }),
    ]);
    expect(ranked.map((s) => s.id)).toEqual(['near', 'far', 'no-risk']);
  });

  it('breaks ties by dollars at risk, then sooner expiry, then age, then id', () => {
    const ranked = rankSignals([
      sig({ id: 'd', lossDistancePct: 5, usdAtRisk: 100, expiresAt: NOW + 9000, createdAt: NOW }),
      sig({ id: 'c', lossDistancePct: 5, usdAtRisk: 100, expiresAt: NOW + 9000, createdAt: NOW }),
      sig({ id: 'b', lossDistancePct: 5, usdAtRisk: 100, expiresAt: NOW + 9000, createdAt: NOW - 5 }),
      sig({ id: 'a2', lossDistancePct: 5, usdAtRisk: 100, expiresAt: NOW + 1000 }),
      sig({ id: 'a1', lossDistancePct: 5, usdAtRisk: 900 }),
    ]);
    expect(ranked.map((s) => s.id)).toEqual(['a1', 'a2', 'b', 'c', 'd']);
  });

  it('is a total order (antisymmetric)', () => {
    const a = sig({ id: 'a', lossDistancePct: 3 });
    const b = sig({ id: 'b', lossDistancePct: 3 });
    expect(compareSignals(a, b)).toBeLessThan(0);
    expect(compareSignals(b, a)).toBeGreaterThan(0);
    expect(compareSignals(a, a)).toBe(0);
  });
});

describe('SignalQueue', () => {
  it('drops signals once they expire', () => {
    const q = new SignalQueue();
    q.upsert(sig({ id: 'short', expiresAt: NOW + 1000 }));
    q.upsert(sig({ id: 'long', expiresAt: NOW + 60_000 }));
    expect(q.ranked(NOW).map((s) => s.id)).toEqual(['short', 'long']);
    expect(q.ranked(NOW + 1000).map((s) => s.id)).toEqual(['long']);
    q.prune(NOW + 1000);
    expect(q.size).toBe(1);
  });

  it('removes what a source stops emitting and leaves other sources alone', () => {
    const q = new SignalQueue();
    q.replaceSource('aave', [sig({ id: 'aave:health' })]);
    q.replaceSource('hyperliquid', [sig({ id: 'hl:ETH', source: 'hyperliquid' })]);
    q.replaceSource('aave', []);
    expect(q.ranked(NOW).map((s) => s.id)).toEqual(['hl:ETH']);
  });

  it('keeps the action id and age stable across re-emits so a tap on a shown line still matches', () => {
    const q = new SignalQueue();
    q.upsert(sig({ id: 's', action: action('REPAY 300 USDC', 'act_first'), createdAt: NOW }));
    q.upsert(sig({ id: 's', action: action('REPAY 250 USDC', 'act_second'), createdAt: NOW + 15_000 }));
    const s = q.get('s');
    expect(s?.action?.id).toBe('act_first');
    expect(s?.action?.actionPrompt).toBe('REPAY 250 USDC');
    expect(s?.createdAt).toBe(NOW);
  });

  it('hides a dismissed signal, shows the next, and brings it back after the snooze', () => {
    const q = new SignalQueue();
    q.upsert(sig({ id: 'first', lossDistancePct: 1, expiresAt: NOW + 2 * SIGNAL_DISMISS_MS }));
    q.upsert(sig({ id: 'second', lossDistancePct: 2, expiresAt: NOW + 2 * SIGNAL_DISMISS_MS }));
    expect(q.top(NOW)?.id).toBe('first');
    q.dismiss('first', NOW);
    expect(q.top(NOW)?.id).toBe('second');
    q.dismiss('second', NOW);
    expect(q.top(NOW)).toBeNull();
    expect(q.ranked(NOW)).toHaveLength(2);
    expect(q.top(NOW + SIGNAL_DISMISS_MS)?.id).toBe('first');
  });

  it('un-hides a dismissed signal when it escalates', () => {
    const q = new SignalQueue();
    q.upsert(sig({ id: 'aave:health', severity: 'warning', lossDistancePct: 20 }));
    q.dismiss('aave:health', NOW);
    q.upsert(sig({ id: 'aave:health', severity: 'warning', lossDistancePct: 15 }));
    expect(q.top(NOW + 1)).toBeNull();
    q.upsert(sig({ id: 'aave:health', severity: 'critical', lossDistancePct: 5 }));
    expect(q.top(NOW + 1)?.id).toBe('aave:health');
  });
});

describe('signal lens line and limits', () => {
  it('keeps the tap prompt and stays within the lens line limit even for long facts', () => {
    const line = signalLensLine({
      line: 'A VERY LONG FACT THAT WOULD NOT FIT ON ONE LENS LINE AT ALL',
      action: action('SWAP 10 USDC->DAI'),
    });
    expect(line.length).toBeLessThanOrEqual(SIGNAL_LENS_LINE_MAX);
    expect(line).toContain(' - TAP: SWAP 10 USDC->DAI');
  });

  it('renders a signal as one event-capture container with one line', () => {
    const signal = sig({ id: 'aave:health', line: 'AAVE HEALTH 1.12 (LIMIT 1.35)', action: action('REPAY 300 USDC') });
    const layout = renderLensPage({ mode: 'signal', paired: true, signal });
    expect(layout.containerTotalNum).toBe(1);
    expect(layout.textObject[0]?.isEventCapture).toBe(1);
    expect(layout.textObject[0]?.content).toBe('AAVE HEALTH 1.12 (LIMIT 1.35) - TAP: REPAY 300 USDC');
    expect(layout.textObject[0]?.content).not.toContain('\n');
    expect(validateLensLayout(layout)).toEqual({ valid: true, errors: [] });
  });

  it('renders the brief with at most three numbered lines, or three words when nothing matters', () => {
    const layout = renderLensPage({ mode: 'brief', paired: true, briefLines: ['ONE', 'TWO', 'THREE', 'FOUR'] });
    expect(layout.textObject[1]?.content.split('\n')).toEqual(['1 ONE', '2 TWO', '3 THREE']);
    expect(validateLensLayout(layout).valid).toBe(true);

    const empty = renderLensPage({ mode: 'brief', paired: true, briefLines: [] });
    expect(empty.textObject[1]?.content).toBe(BRIEF_EMPTY_TEXT);
    expect(BRIEF_EMPTY_TEXT.split(' ')).toHaveLength(3);
    expect(validateLensLayout(empty).valid).toBe(true);
  });

  it('renders a notice as one line within limits', () => {
    const layout = renderLensPage({ mode: 'notice', paired: true, noticeText: 'ALERT SET: ETH BELOW 1700' });
    expect(layout.totalChars).toBeLessThanOrEqual(SIGNAL_LENS_LINE_MAX);
    expect(validateLensLayout(layout).valid).toBe(true);
  });
});

describe('price alert rules', () => {
  const rule: PriceAlertRule = {
    id: 'al_1',
    asset: 'ETH',
    direction: 'below',
    price: 1700,
    referencePrice: 1784,
    createdAt: NOW,
    createdVia: 'voice',
  };

  it('refuses a rule the live price has already crossed, and unknown assets', () => {
    expect(checkNewRule({ asset: 'ETH', direction: 'below', price: 1800 }, 1784, 0)).toEqual({
      ok: false,
      reason: 'ETH ALREADY AT OR BELOW 1800',
    });
    expect(checkNewRule({ asset: 'ETH', direction: 'above', price: 1700 }, 1784, 0).ok).toBe(false);
    expect(checkNewRule({ asset: 'DOGE', direction: 'below', price: 1 }, 2, 0).ok).toBe(false);
    expect(checkNewRule({ asset: 'ETH', direction: 'below', price: 1700 }, undefined, 0).ok).toBe(false);
    expect(checkNewRule({ asset: 'ETH', direction: 'below', price: 1700 }, 1784, 20).ok).toBe(false);
    expect(checkNewRule({ asset: 'ETH', direction: 'below', price: 1700 }, 1784, 0)).toEqual({ ok: true });
  });

  it('fires only once the live price reaches the target', () => {
    expect(ruleCrossed(rule, 1700.01)).toBe(false);
    expect(ruleCrossed(rule, 1700)).toBe(true);
    expect(ruleCrossed({ ...rule, direction: 'above', price: 1800 }, 1800.5)).toBe(true);
    expect(ruleCrossed(rule, undefined)).toBe(false);
  });

  it('shows the live price with at least the rule\'s precision', () => {
    const s = priceAlertSignal({ ...rule, direction: 'above', price: 1660.72 }, 1660.75, NOW);
    expect(s.line).toBe('ETH TESTNET 1660.75 ABOVE 1660.72');
    const btc = priceAlertSignal({ ...rule, asset: 'BTC', direction: 'above', price: 58864.15 }, 58864.2, NOW);
    expect(signalLensLine(btc)).toBe('BTC TESTNET 58864.20 ABOVE 58864.15');
  });

  it('raises a notice signal with a lens-safe line and no action', () => {
    const s = priceAlertSignal(rule, 1699.8, NOW);
    expect(s.line).toBe('ETH TESTNET 1699.8 BELOW 1700');
    expect(s.action).toBeNull();
    expect(s.severity).toBe('notice');
    expect(signalLensLine(s).length).toBeLessThanOrEqual(SIGNAL_LENS_LINE_MAX);
  });
});
