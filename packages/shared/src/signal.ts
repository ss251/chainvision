import type { PendingAction } from './types.js';
import { sanitizeForG2 } from './text.js';
import type { ExchangeSignalKind } from './exchange.js';

export type SignalSource = 'aave' | 'uniswap' | 'hyperliquid' | 'exchange' | 'price_alert' | 'telegram' | 'ton';
export type SignalKind = 'loan_health' | 'lp_range' | 'liquidation_distance' | 'price_cross' | 'money_request' | 'incoming_payment' | 'low_balance';
export type SignalSeverity = 'critical' | 'warning' | 'notice';

/** Longest fact a signal with an action may carry; with " - TAP: <prompt>" the lens line stays within SIGNAL_LENS_LINE_MAX. */
export const SIGNAL_LINE_MAX = 34;
export const SIGNAL_PROMPT_MAX = 18;
export const SIGNAL_LENS_LINE_MAX = 60;

export const BRIEF_MAX_LINES = 3;
export const BRIEF_EMPTY_TEXT = 'NOTHING NEEDS YOU';
/** The brief and one-line notices blank themselves after these. */
export const BRIEF_SHOW_MS = 10_000;
export const NOTICE_SHOW_MS = 5_000;

/** A shown line blanks itself after this long if untouched. */
export const SIGNAL_SHOW_MS = 10_000;
/** After blanking itself, a line returns only if it is still raised this long afterwards. */
export const SIGNAL_RESHOW_MS = 60_000;
/** A swipe hides a signal for this long unless it escalates. */
export const SIGNAL_DISMISS_MS = 15 * 60_000;

/** Rolling lookback window for mark-price velocity toward liquidation. */
export const LIQ_ETA_WINDOW_MS = 3 * 60_000;
/** Minimum elapsed time between oldest and newest sample before estimating an ETA. */
export const LIQ_ETA_MIN_SPAN_MS = 10_000;
/** Omit noisy multi-hour ETAs when price is barely drifting toward liquidation. */
export const LIQ_ETA_MAX_MINUTES = 240;

export interface PriceSample {
  price: number;
  at: number;
}

export interface LiquidationEtaInput {
  side: 'LONG' | 'SHORT';
  markPx: number;
  liqPx: number | null;
  samples: readonly PriceSample[];
  now: number;
  windowMs?: number;
  minSpanMs?: number;
  maxMinutes?: number;
}

/**
 * Estimates minutes until mark price hits liquidation at its recent velocity over the lookback window.
 * Returns null when price is flat, moving away from liquidation, has too little history, or exceeds maxMinutes.
 */
export function estimateLiquidationEtaMinutes(input: LiquidationEtaInput): number | null {
  const {
    side,
    markPx,
    liqPx,
    samples,
    now,
    windowMs = LIQ_ETA_WINDOW_MS,
    minSpanMs = LIQ_ETA_MIN_SPAN_MS,
    maxMinutes = LIQ_ETA_MAX_MINUTES,
  } = input;
  if (!Number.isFinite(markPx) || markPx <= 0 || liqPx === null || !Number.isFinite(liqPx) || liqPx <= 0) {
    return null;
  }
  const distance = side === 'LONG' ? markPx - liqPx : liqPx - markPx;
  if (distance <= 0) return null;

  const cutoff = now - windowMs;
  const recent = samples
    .filter((s) => Number.isFinite(s.price) && s.price > 0 && Number.isFinite(s.at) && s.at >= cutoff && s.at <= now)
    .sort((a, b) => a.at - b.at);
  if (recent.length < 2) return null;

  const oldest = recent[0]!;
  const newest = recent[recent.length - 1]!;
  const spanMs = newest.at - oldest.at;
  if (spanMs < minSpanMs) return null;

  const deltaTowardLiq = side === 'LONG' ? oldest.price - newest.price : newest.price - oldest.price;
  if (deltaTowardLiq <= 0) return null;

  const ratePerMin = deltaTowardLiq / (spanMs / 60_000);
  if (!Number.isFinite(ratePerMin) || ratePerMin <= 0) return null;

  const etaMinutes = distance / ratePerMin;
  if (!Number.isFinite(etaMinutes) || etaMinutes <= 0 || etaMinutes > maxMinutes) return null;
  return etaMinutes;
}

export function formatLiqEta(etaMinutes: number | null): string | null {
  if (etaMinutes === null || !Number.isFinite(etaMinutes) || etaMinutes <= 0) return null;
  if (etaMinutes < 1) return '<1m';
  const rounded = Math.round(etaMinutes);
  if (rounded < 100) return `~${rounded}m`;
  return `~${Math.round(etaMinutes / 60)}h`;
}

/**
 * Formats a Hyperliquid or exchange liquidation risk fact within SIGNAL_LINE_MAX.
 * Includes "LIQ ~4m" when mark price is moving toward liquidation; otherwise keeps "LIQ X.X% AWAY".
 */
export function formatLiqRiskLine(params: {
  venue: string;
  coin: string;
  side: 'LONG' | 'SHORT';
  liqDistancePct: number;
  etaMinutes?: number | null;
}): string {
  const pct = params.liqDistancePct.toFixed(1);
  const eta = formatLiqEta(params.etaMinutes ?? null);
  if (eta) {
    return fitSignalLine(`${params.venue} ${params.coin} ${params.side} LIQ ${eta} (${pct}%)`, SIGNAL_LINE_MAX);
  }
  return fitSignalLine(`${params.venue} ${params.coin} ${params.side} LIQ ${pct}% AWAY`, SIGNAL_LINE_MAX);
}

/** Rolling per-symbol mark-price history used to compute liquidation velocity across watcher polls. */
export class MarkPriceHistory {
  private readonly byKey = new Map<string, PriceSample[]>();
  private readonly windowMs: number;

  constructor(windowMs = LIQ_ETA_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  record(key: string, price: number, at: number): void {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(at)) return;
    const cutoff = at - this.windowMs;
    const prev = (this.byKey.get(key) ?? []).filter((s) => s.at >= cutoff && s.at <= at);
    const last = prev[prev.length - 1];
    if (last && last.at === at) {
      last.price = price;
    } else {
      prev.push({ price, at });
    }
    this.byKey.set(key, prev);
  }

  samples(key: string, now: number): PriceSample[] {
    const cutoff = now - this.windowMs;
    const list = (this.byKey.get(key) ?? []).filter((s) => s.at >= cutoff && s.at <= now);
    if (list.length === 0) this.byKey.delete(key);
    else this.byKey.set(key, list);
    return list;
  }
}

export interface Signal {
  /** Stable identity of the condition, e.g. "aave:health" or "hyperliquid:liq:ETH". */
  id: string;
  source: SignalSource;
  kind: SignalKind | ExchangeSignalKind;
  severity: SignalSeverity;
  /** The one fact the lens shows, G2-safe: at most SIGNAL_LINE_MAX characters with an action, SIGNAL_LENS_LINE_MAX without. */
  line: string;
  /** The fix a tap approves, or null when a tap only clears the line. */
  action: PendingAction | null;
  /** Percent move left before money is lost; null when no money is at risk. */
  lossDistancePct: number | null;
  /** Dollar value exposed if the loss happens (0 when nothing is at risk). */
  usdAtRisk: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export function fitSignalLine(text: string, max = SIGNAL_LINE_MAX): string {
  const clean = sanitizeForG2(text).replace(/\n/g, ' ');
  return clean.length <= max ? clean : clean.slice(0, max - 2) + '..';
}

const SEVERITY_RANK: Record<SignalSeverity, number> = { critical: 0, warning: 1, notice: 2 };

export function severityRank(severity: SignalSeverity): number {
  return SEVERITY_RANK[severity];
}

/**
 * Ranking, money at risk soonest first:
 * 1. severity: critical, then warning, then notice;
 * 2. signals with money at risk before those without, smallest loss distance first;
 * 3. larger dollar exposure first;
 * 4. the one that expires sooner first;
 * 5. the older one first, then by id so the order is total and stable.
 */
export function compareSignals(a: Signal, b: Signal): number {
  const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (sev !== 0) return sev;
  const aRisk = a.lossDistancePct;
  const bRisk = b.lossDistancePct;
  if (aRisk !== null && bRisk === null) return -1;
  if (aRisk === null && bRisk !== null) return 1;
  if (aRisk !== null && bRisk !== null && aRisk !== bRisk) return aRisk - bRisk;
  if (a.usdAtRisk !== b.usdAtRisk) return b.usdAtRisk - a.usdAtRisk;
  if (a.expiresAt !== b.expiresAt) return a.expiresAt - b.expiresAt;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function rankSignals(signals: Signal[]): Signal[] {
  return [...signals].sort(compareSignals);
}

interface QueueEntry {
  signal: Signal;
  hiddenUntil: number;
  hiddenAtSeverity: SignalSeverity | null;
}

/**
 * One priority queue for every source. Watchers re-emit what is still true on every poll;
 * anything a source stops emitting leaves the queue, and anything not re-emitted expires.
 */
export class SignalQueue {
  private readonly entries = new Map<string, QueueEntry>();

  upsert(signal: Signal): void {
    const prev = this.entries.get(signal.id);
    if (!prev) {
      this.entries.set(signal.id, { signal, hiddenUntil: 0, hiddenAtSeverity: null });
      return;
    }
    const keepActionId =
      prev.signal.action && signal.action && prev.signal.action.actionType === signal.action.actionType;
    const next: Signal = {
      ...signal,
      createdAt: prev.signal.createdAt,
      action: keepActionId && signal.action && prev.signal.action
        ? { ...signal.action, id: prev.signal.action.id, createdAt: prev.signal.action.createdAt }
        : signal.action,
    };
    const escalated =
      prev.hiddenAtSeverity !== null && SEVERITY_RANK[next.severity] < SEVERITY_RANK[prev.hiddenAtSeverity];
    this.entries.set(signal.id, {
      signal: next,
      hiddenUntil: escalated ? 0 : prev.hiddenUntil,
      hiddenAtSeverity: escalated ? null : prev.hiddenAtSeverity,
    });
  }

  /** Replace everything one source currently says; signals it no longer emits leave the queue. */
  replaceSource(source: SignalSource, signals: Signal[]): void {
    const keep = new Set(signals.map((s) => s.id));
    for (const [id, entry] of this.entries) {
      if (entry.signal.source === source && !keep.has(id)) this.entries.delete(id);
    }
    for (const s of signals) this.upsert(s);
  }

  remove(id: string): boolean {
    return this.entries.delete(id);
  }

  get(id: string): Signal | null {
    return this.entries.get(id)?.signal ?? null;
  }

  findByActionId(actionId: string): Signal | null {
    for (const { signal } of this.entries.values()) {
      if (signal.action?.id === actionId) return signal;
    }
    return null;
  }

  hide(ids: string[], until: number): void {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      entry.hiddenUntil = Math.max(entry.hiddenUntil, until);
      entry.hiddenAtSeverity = entry.signal.severity;
    }
  }

  dismiss(id: string, now: number): void {
    this.hide([id], now + SIGNAL_DISMISS_MS);
  }

  prune(now: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.signal.expiresAt <= now) this.entries.delete(id);
    }
  }

  /** Every live signal, ranked, including ones hidden by a swipe or by blanking itself. */
  ranked(now: number): Signal[] {
    return rankSignals(
      [...this.entries.values()].filter((e) => e.signal.expiresAt > now).map((e) => e.signal),
    );
  }

  /** Live signals the lens may show right now, ranked. */
  visible(now: number): Signal[] {
    return rankSignals(
      [...this.entries.values()]
        .filter((e) => e.signal.expiresAt > now && e.hiddenUntil <= now)
        .map((e) => e.signal),
    );
  }

  top(now: number): Signal | null {
    return this.visible(now)[0] ?? null;
  }

  get size(): number {
    return this.entries.size;
  }
}
