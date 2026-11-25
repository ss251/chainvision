import fs from 'node:fs';
import path from 'node:path';
import { EXCHANGE_CAPS, type ExchangeActionType } from '@chainvision/shared';

const DAY_MS = 24 * 60 * 60_000;

interface LedgerEntry {
  type: ExchangeActionType;
  amount: number;
  at: number;
  ref: string;
}

export class ExchangeCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExchangeCapError';
  }
}

/**
 * Per-action and rolling 24-hour limits for exchange writes.
 * Kept in a mode-600 JSON file when one is given, so a restart does not reset the day.
 */
export class ExchangeCapLedger {
  private entries: LedgerEntry[] = [];

  constructor(private readonly file: string | null = null) {
    if (file && fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries?: LedgerEntry[] };
        this.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      } catch {
        this.entries = [];
      }
    }
  }

  usedToday(type: ExchangeActionType, now = Date.now()): number {
    return this.entries.filter((e) => e.type === type && now - e.at < DAY_MS).reduce((sum, e) => sum + e.amount, 0);
  }

  /** The most a single action of this type may move right now: the per-action cap or what is left of the day. */
  allowance(type: ExchangeActionType, now = Date.now()): number {
    const cap = EXCHANGE_CAPS[type];
    return Math.max(0, Math.min(cap.perAction, cap.perDay - this.usedToday(type, now)));
  }

  check(type: ExchangeActionType, amount: number, now = Date.now()): void {
    const cap = EXCHANGE_CAPS[type];
    const unit = cap.unit === 'USD' ? ' USD' : ' orders';
    if (!(amount > 0)) throw new ExchangeCapError('Amount must be positive');
    if (amount > cap.perAction) {
      throw new ExchangeCapError(type + ' ' + amount.toFixed(2) + unit + ' exceeds the per-action cap of ' + cap.perAction + unit);
    }
    const used = this.usedToday(type, now);
    if (used + amount > cap.perDay) {
      throw new ExchangeCapError(
        type + ' daily cap ' + cap.perDay + unit + ' reached (' + used.toFixed(2) + ' used in the last 24 h)',
      );
    }
  }

  record(type: ExchangeActionType, amount: number, ref: string, now = Date.now()): void {
    this.entries = this.entries.filter((e) => now - e.at < DAY_MS);
    this.entries.push({ type, amount, at: now, ref });
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ entries: this.entries }, null, 2), { mode: 0o600 });
  }
}
