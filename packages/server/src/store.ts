import fs from 'node:fs';
import path from 'node:path';
import type { MoneyRequest, Payout, PriceAlertRule, Requester } from '@chainvision/shared';

export interface PersistedState {
  alertRules: PriceAlertRule[];
  requesters: Requester[];
  requests: MoneyRequest[];
  payouts: Payout[];
}

function empty(): PersistedState {
  return { alertRules: [], requesters: [], requests: [], payouts: [] };
}

/** Small JSON file (mode 600) for state that must survive a restart; no file means memory only. */
export class StateStore {
  constructor(private readonly file: string | null) {}

  load(): PersistedState {
    if (!this.file || !fs.existsSync(this.file)) return empty();
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<PersistedState>;
    const list = <T>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : []);
    return {
      alertRules: list(parsed.alertRules),
      requesters: list(parsed.requesters),
      requests: list(parsed.requests),
      payouts: list(parsed.payouts),
    };
  }

  save(state: PersistedState): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
