import { SIGNAL_LENS_LINE_MAX, fitSignalLine, type Signal } from './signal.js';

export const ALERT_ASSETS = ['ETH', 'BTC', 'SOL'] as const;
export type AlertAsset = (typeof ALERT_ASSETS)[number];
export type AlertDirection = 'below' | 'above';
export const MAX_ALERT_RULES = 20;
/** A fired price alert stays in the queue this long unless cleared. */
export const PRICE_SIGNAL_TTL_MS = 15 * 60_000;

export interface PriceAlertRule {
  id: string;
  asset: AlertAsset;
  direction: AlertDirection;
  price: number;
  /** Live price when the rule was stored; always on the far side of `price`. */
  referencePrice: number;
  createdAt: number;
  createdVia: 'voice' | 'miniapp' | 'api';
}

export type RuleCheck = { ok: true } | { ok: false; reason: string };

/**
 * A rule only makes sense if the live price has yet to cross it,
 * so "tell me if ETH drops below 1800" is refused while ETH is already under 1800.
 */
export function checkNewRule(
  rule: { asset: string; direction: string; price: number },
  livePrice: number | undefined,
  existingCount: number,
): RuleCheck {
  if (!(ALERT_ASSETS as readonly string[]).includes(rule.asset)) {
    return { ok: false, reason: `ALERTS COVER ETH, BTC, SOL ONLY` };
  }
  if (rule.direction !== 'below' && rule.direction !== 'above') {
    return { ok: false, reason: 'SAY BELOW OR ABOVE' };
  }
  if (!Number.isFinite(rule.price) || rule.price <= 0) {
    return { ok: false, reason: 'ALERT PRICE MUST BE POSITIVE' };
  }
  if (existingCount >= MAX_ALERT_RULES) {
    return { ok: false, reason: `AT MOST ${MAX_ALERT_RULES} ALERTS` };
  }
  if (livePrice === undefined || !Number.isFinite(livePrice) || livePrice <= 0) {
    return { ok: false, reason: `NO LIVE ${rule.asset} PRICE` };
  }
  if (rule.direction === 'below' && livePrice <= rule.price) {
    return { ok: false, reason: `${rule.asset} ALREADY AT OR BELOW ${rule.price}` };
  }
  if (rule.direction === 'above' && livePrice >= rule.price) {
    return { ok: false, reason: `${rule.asset} ALREADY AT OR ABOVE ${rule.price}` };
  }
  return { ok: true };
}

export function ruleCrossed(rule: PriceAlertRule, livePrice: number | undefined): boolean {
  if (livePrice === undefined || !Number.isFinite(livePrice) || livePrice <= 0) return false;
  return rule.direction === 'below' ? livePrice <= rule.price : livePrice >= rule.price;
}

export function describeRule(rule: Pick<PriceAlertRule, 'asset' | 'direction' | 'price'>): string {
  return `${rule.asset} ${rule.direction.toUpperCase()} ${rule.price}`;
}

/** Live price with at least the rule's own precision, so 1660.75 never reads as 1660.7 next to a 1660.72 rule. */
export function formatPrice(price: number, rulePrice: number): string {
  const ruleDecimals = (String(rulePrice).split('.')[1] ?? '').length;
  return price.toFixed(Math.min(8, Math.max(price >= 1000 ? 1 : 2, ruleDecimals)));
}

export function priceAlertSignal(rule: PriceAlertRule, livePrice: number, now: number): Signal {
  return {
    id: `price_alert:${rule.id}`,
    source: 'price_alert',
    kind: 'price_cross',
    severity: 'notice',
    line: fitSignalLine(
      `${rule.asset} TESTNET ${formatPrice(livePrice, rule.price)} ${rule.direction.toUpperCase()} ${rule.price}`,
      SIGNAL_LENS_LINE_MAX,
    ),
    action: null,
    lossDistancePct: null,
    usdAtRisk: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + PRICE_SIGNAL_TTL_MS,
  };
}
