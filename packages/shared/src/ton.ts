import type { RuleCheck } from './alerts.js';
import { SIGNAL_LENS_LINE_MAX, SIGNAL_LINE_MAX, fitSignalLine, type Signal } from './signal.js';
import type { PendingAction } from './types.js';

/** 1 TON (Gram) = 10^9 nanotons; every amount that reaches the chain is an integer of nanotons. */
export const NANO_PER_TON = 1_000_000_000n;
export const TON_DECIMALS = 9;
/** An incoming payment stays on the lens queue this long after it lands. */
export const TON_INCOMING_WINDOW_MS = 10 * 60_000;
/** A low-balance line stays raised this long after the balance crosses below the floor. */
export const TON_LOW_BALANCE_WINDOW_MS = 10 * 60_000;

export interface TonIncomingTransfer {
  /** Transaction hash, hex. */
  hash: string;
  lt: string;
  from: string;
  amountNano: string;
  comment: string;
  at: number;
}

export interface TonWalletSnapshot {
  network: 'ton-testnet';
  address: string | null;
  balanceNano: string | null;
  state: string | null;
  incoming: TonIncomingTransfer[];
  updatedAt: number;
  error?: string;
}

export interface TonCaps {
  perRequestTon: number;
  dailyTon: number;
}

/**
 * Parses a decimal TON amount ("2", "0.5", "1.000000001") into nanotons without floating point.
 * At most 9 decimals; returns null for anything that cannot be read exactly or is not positive.
 */
export function parseTonAmount(input: string | number): bigint | null {
  const text = typeof input === 'number' ? (Number.isFinite(input) ? numberToPlain(input) : '') : input.trim();
  const m = text.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m?.[1]) return null;
  const frac = m[2] ?? '';
  if (frac.length > TON_DECIMALS) return null;
  const nano = BigInt(m[1]) * NANO_PER_TON + BigInt(frac.padEnd(TON_DECIMALS, '0') || '0');
  return nano > 0n ? nano : null;
}

function numberToPlain(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const fixed = n.toFixed(TON_DECIMALS).replace(/0+$/, '').replace(/\.$/, '');
  return Number(fixed) === n ? fixed : '';
}

/** "2", "0.5", "1.000000001": nanotons as a plain decimal TON string, no trailing zeros. */
export function formatTon(nano: bigint | string): string {
  const value = typeof nano === 'string' ? BigInt(nano) : nano;
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  const whole = abs / NANO_PER_TON;
  const frac = (abs % NANO_PER_TON).toString().padStart(TON_DECIMALS, '0').replace(/0+$/, '');
  return `${sign}${whole}${frac ? '.' + frac : ''}`;
}

/** Short display form for the lens: at most `digits` decimals, rounded down so it never overstates. */
export function formatTonShort(nano: bigint | string, digits = 2): string {
  const value = typeof nano === 'string' ? BigInt(nano) : nano;
  const step = 10n ** BigInt(TON_DECIMALS - digits);
  return formatTon((value / step) * step);
}

/**
 * Amount from "/ask 2 TON", "/ask@bot 0.5 ton" or "/ask 2 gram". The unit is required, so an
 * existing "/ask 20" or "/ask 20 USDC" is never read as TON. Returns TON as a number with at most
 * 9 decimals, or null.
 */
export function parseTonAsk(text: string): number | null {
  const m = text.trim().match(/^\/ask(?:@\w+)?\s+(\d+(?:\.\d+)?)\s*(\w+)\s*$/i);
  if (!m?.[1] || !m[2] || !['TON', 'GRAM'].includes(m[2].toUpperCase())) return null;
  return parseTonAmount(m[1]) === null ? null : Number(m[1]);
}

export function shortTonAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 4)}..${address.slice(-4)}`;
}

/** The parts of a Telegram requester the TON rail needs (a structural view of the request model). */
export interface TonRequesterView {
  telegramUserId: string;
  name: string;
  status: 'pending' | 'approved';
  tonAddress?: string | null;
}

/** The parts of a money request the TON rail needs; `amount` is in TON for a TON request. */
export interface TonRequestView {
  id: string;
  requesterId: string;
  amount: number;
  currency?: 'USDC' | 'TON';
  status: string;
  createdAt: number;
  expiresAt: number;
}

export interface TonPayoutView {
  amount: number;
  currency?: 'USDC' | 'TON';
  at: number;
}

const DAY_MS = 24 * 60 * 60_000;

/** TON paid to requesters in the last rolling 24 hours, in nanotons; USDC payouts never count. */
export function tonPaidInLastDay(payouts: TonPayoutView[], now: number): bigint {
  return payouts
    .filter((p) => p.currency === 'TON' && now - p.at < DAY_MS)
    .reduce((sum, p) => sum + (parseTonAmount(p.amount) ?? 0n), 0n);
}

function checkTonAmount(amount: number, paidTodayNano: bigint, caps: TonCaps): RuleCheck {
  const nano = parseTonAmount(amount);
  if (nano === null) return { ok: false, reason: 'Say an amount, for example /ask 2 TON.' };
  const perRequest = parseTonAmount(caps.perRequestTon) ?? 0n;
  const daily = parseTonAmount(caps.dailyTon) ?? 0n;
  if (nano > perRequest) return { ok: false, reason: `TON requests are capped at ${formatTon(perRequest)} TON each.` };
  if (paidTodayNano + nano > daily) {
    const left = daily > paidTodayNano ? daily - paidTodayNano : 0n;
    return { ok: false, reason: `That would pass the ${formatTon(daily)} TON daily limit (${formatTon(left)} TON left today).` };
  }
  return { ok: true };
}

/** Rules for a new TON request: known, approved requester with a registered TON address, one open request each, caps. */
export function checkTonAsk(params: {
  requester: TonRequesterView | null;
  amount: number;
  openRequestIds: string[];
  payouts: TonPayoutView[];
  caps: TonCaps;
  now: number;
}): RuleCheck {
  const { requester, amount, openRequestIds, payouts, caps, now } = params;
  if (!requester) return { ok: false, reason: 'Register first in a private chat with me: /register <your TON testnet address> <name>.' };
  if (requester.status !== 'approved') {
    return { ok: false, reason: 'The wearer has not approved you yet. They approve new requesters once in the ChainVision Mini App.' };
  }
  if (!requester.tonAddress) return { ok: false, reason: 'Register a TON testnet address first: /register <TON address> <name>.' };
  if (openRequestIds.length > 0) return { ok: false, reason: 'You already have an open request. Wait for an answer or for it to expire.' };
  return checkTonAmount(amount, tonPaidInLastDay(payouts, now), caps);
}

/** The same rules again at the moment of paying, so nothing that changed since the ask slips through. */
export function checkTonPayout(params: {
  request: TonRequestView | null;
  requester: TonRequesterView | null;
  payouts: TonPayoutView[];
  caps: TonCaps;
  now: number;
}): RuleCheck {
  const { request, requester, payouts, caps, now } = params;
  if (!request || request.status !== 'open' || request.expiresAt <= now) return { ok: false, reason: 'This request is no longer open.' };
  if (request.currency !== 'TON') return { ok: false, reason: 'This request is not a TON request.' };
  if (!requester || requester.telegramUserId !== request.requesterId || requester.status !== 'approved' || !requester.tonAddress) {
    return { ok: false, reason: 'The requester is no longer approved.' };
  }
  return checkTonAmount(request.amount, tonPaidInLastDay(payouts, now), caps);
}

/** The lens line and the tap action for an open TON request: "KIT ASKS 2 TON - TAP: PAY". */
export function tonRequestSignal(
  request: TonRequestView,
  requester: TonRequesterView & { tonAddress: string },
  actionId: string,
  now: number,
): Signal {
  const amount = formatTon(parseTonAmount(request.amount) ?? 0n);
  const action: PendingAction = {
    id: actionId,
    source: 'telegram',
    protocol: 'ton',
    actionType: 'ton_payout',
    headline: `${requester.name} ASKS ${amount} TON`,
    factLine: `TO ${shortTonAddress(requester.tonAddress)} ON TON TESTNET`,
    actionPrompt: 'PAY',
    params: { tokenIn: 'TON', amount: request.amount, to: requester.tonAddress, requestId: request.id },
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    requiresTap: true,
  };
  return {
    id: `request:${request.id}`,
    source: 'telegram',
    kind: 'money_request',
    severity: 'warning',
    line: fitSignalLine(`${requester.name} ASKS ${amount} TON`, SIGNAL_LINE_MAX),
    action,
    lossDistancePct: null,
    usdAtRisk: 0,
    createdAt: request.createdAt,
    updatedAt: now,
    expiresAt: request.expiresAt,
  };
}

/**
 * Signals from one read of the app's test wallet: every payment that landed in the last
 * TON_INCOMING_WINDOW_MS, and a low balance for TON_LOW_BALANCE_WINDOW_MS after it crossed the floor.
 * Neither carries an action: a tap clears the line.
 */
export function tonWalletSignals(
  snap: TonWalletSnapshot,
  opts: { lowBalanceTon: number; lowSince: number | null },
  now: number,
): Signal[] {
  const signals: Signal[] = [];
  for (const t of snap.incoming) {
    if (now - t.at >= TON_INCOMING_WINDOW_MS || t.at > now + 60_000) continue;
    signals.push({
      id: `ton:in:${t.lt}`,
      source: 'ton',
      kind: 'incoming_payment',
      severity: 'notice',
      line: fitSignalLine(`RECEIVED ${formatTonShort(t.amountNano, 3)} TON FROM ${shortTonAddress(t.from)} (TESTNET)`, SIGNAL_LENS_LINE_MAX),
      action: null,
      lossDistancePct: null,
      usdAtRisk: 0,
      createdAt: t.at,
      updatedAt: now,
      expiresAt: t.at + TON_INCOMING_WINDOW_MS,
    });
  }
  const floor = parseTonAmount(opts.lowBalanceTon);
  if (snap.balanceNano !== null && floor !== null && opts.lowSince !== null && BigInt(snap.balanceNano) < floor) {
    const expiresAt = opts.lowSince + TON_LOW_BALANCE_WINDOW_MS;
    if (expiresAt > now) {
      signals.push({
        id: 'ton:low',
        source: 'ton',
        kind: 'low_balance',
        severity: 'notice',
        line: fitSignalLine(`TON TEST WALLET ${formatTonShort(snap.balanceNano)} TON, UNDER ${formatTon(floor)}`, SIGNAL_LENS_LINE_MAX),
        action: null,
        lossDistancePct: null,
        usdAtRisk: 0,
        createdAt: opts.lowSince,
        updatedAt: now,
        expiresAt,
      });
    }
  }
  return signals;
}

/**
 * One read-only brief line for the wallets the app only looks at: the wearer's TON Connect wallet
 * (testnet) and their Gram Wallet address on mainnet. Null when neither is known.
 */
export function tonReadOnlyBriefLine(balances: { connectedTestnetNano: string | null; mainnetNano: string | null }): string | null {
  const parts: string[] = [];
  if (balances.connectedTestnetNano !== null) parts.push(`TON ${formatTonShort(balances.connectedTestnetNano)} TESTNET`);
  if (balances.mainnetNano !== null) parts.push(`GRAM ${formatTonShort(balances.mainnetNano)} MAINNET`);
  if (parts.length === 0) return null;
  return fitSignalLine(`READ-ONLY ${parts.join(' · ')}`, SIGNAL_LENS_LINE_MAX - 2);
}
