import fs from 'node:fs';
import path from 'node:path';
import type { PriceAlertRule } from '@chainvision/shared';

export interface PersistedState {
  alertRules: PriceAlertRule[];
}

const EMPTY: PersistedState = { alertRules: [] };

/** Small JSON file (mode 600) for state that must survive a restart; no file means memory only. */
export class StateStore {
  constructor(private readonly file: string | null) {}

  load(): PersistedState {
    if (!this.file || !fs.existsSync(this.file)) return structuredClone(EMPTY);
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<PersistedState>;
    return { alertRules: Array.isArray(parsed.alertRules) ? parsed.alertRules : [] };
  }

  save(state: PersistedState): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
