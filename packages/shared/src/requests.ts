import type { RuleCheck } from './alerts.js';
import { fitSignalLine, type Signal } from './signal.js';
import type { PendingAction } from './types.js';

/** A Telegram money request expires if the wearer has not answered within this long. */
export const REQUEST_TTL_MS = 5 * 60_000;
export const DAY_MS = 24 * 60 * 60_000;
export const REQUEST_NAME_MAX = 12;

export interface Requester {
  telegramUserId: string;
  name: string;
  username: string | null;
  address: `0x${string}`;
  status: 'pending' | 'approved';
  registeredAt: number;
  approvedAt: number | null;
}

export type RequestStatus = 'open' | 'paid' | 'declined' | 'expired' | 'failed';
export type RequestResolution = 'glasses_tap' | 'telegram_confirm' | 'lens_swipe' | 'telegram_decline' | 'expiry';

export interface RequestMessage {
  role: 'wearer' | 'requester' | 'group';
  kind: string;
  messageId: number;
}

export interface MoneyRequest {
  id: string;
  requesterId: string;
  amount: number;
  createdAt: number;
  expiresAt: number;
  status: RequestStatus;
  askedInChatId: string;
  askedInGroup: boolean;
  resolvedAt: number | null;
  resolvedVia: RequestResolution | null;
  txHash: string | null;
  error: string | null;
  messages: RequestMessage[];
}

export interface Payout {
  requestId: string;
  requesterId: string;
  amount: number;
  txHash: string;
  at: number;
}

export interface RequestCaps {
  perRequestUsdc: number;
  dailyUsdc: number;
}

/** A requester's chosen display name, reduced to what the lens can show. */
export function requesterDisplayName(raw: string): string {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  return (clean || 'SOMEONE').slice(0, REQUEST_NAME_MAX).trim();
}

/**
 * Amount from "/ask 20 USDC", "/ask@bot 20.5 usdc" or "/ask 20". Only USDC is accepted,
 * at most 6 decimals (the token's precision). Returns null when it cannot be read honestly.
 */
export function parseAskAmount(text: string): number | null {
  const m = text.trim().match(/^\/ask(?:@\w+)?\s+(\d+(?:\.\d+)?)(?:\s*(\w+))?\s*$/i);
  if (!m?.[1]) return null;
  if (m[2] && m[2].toUpperCase() !== 'USDC') return null;
  const amount = Number(m[1]);
  const decimals = (m[1].split('.')[1] ?? '').length;
  if (!Number.isFinite(amount) || amount <= 0 || decimals > 6) return null;
  return amount;
}

export function paidInLastDay(payouts: Payout[], now: number): number {
  return payouts.filter((p) => now - p.at < DAY_MS).reduce((sum, p) => sum + p.amount, 0);
}

export function isOpen(request: MoneyRequest, now: number): boolean {
  return request.status === 'open' && request.expiresAt > now;
}

function checkAmount(amount: number, paidToday: number, caps: RequestCaps): RuleCheck {
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'Say an amount, for example /ask 20 USDC.' };
  if (amount > caps.perRequestUsdc) {
    return { ok: false, reason: `Requests are capped at ${caps.perRequestUsdc} USDC each.` };
  }
  if (paidToday + amount > caps.dailyUsdc) {
    const left = Math.max(0, caps.dailyUsdc - paidToday);
    return { ok: false, reason: `That would pass the ${caps.dailyUsdc} USDC daily limit (${left} USDC left today).` };
  }
  return { ok: true };
}

/** Rules for a new request: known and approved requester, caps, and one open request each. */
export function checkAsk(params: {
  requester: Requester | null;
  amount: number;
  requests: MoneyRequest[];
  payouts: Payout[];
  caps: RequestCaps;
  now: number;
}): RuleCheck {
  const { requester, amount, requests, payouts, caps, now } = params;
  if (!requester) {
    return { ok: false, reason: 'Register first in a private chat with me: /register <your Sepolia address> <name>.' };
  }
  if (requester.status !== 'approved') {
    return { ok: false, reason: 'The wearer has not approved you yet. They approve new requesters once in the ChainVision Mini App.' };
  }
  if (requests.some((r) => r.requesterId === requester.telegramUserId && isOpen(r, now))) {
    return { ok: false, reason: 'You already have an open request. Wait for an answer or for it to expire.' };
  }
  return checkAmount(amount, paidInLastDay(payouts, now), caps);
}

/** The same rules again at the moment of paying, so nothing that changed since the ask slips through. */
export function checkPayout(params: {
  request: MoneyRequest | null;
  requester: Requester | null;
  payouts: Payout[];
  caps: RequestCaps;
  now: number;
}): RuleCheck {
  const { request, requester, payouts, caps, now } = params;
  if (!request || !isOpen(request, now)) return { ok: false, reason: 'This request is no longer open.' };
  if (!requester || requester.telegramUserId !== request.requesterId || requester.status !== 'approved') {
    return { ok: false, reason: 'The requester is no longer approved.' };
  }
  return checkAmount(request.amount, paidInLastDay(payouts, now), caps);
}

export function formatUsdc(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(6).replace(/0+$/, '');
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}..${address.slice(-4)}`;
}

/** The lens line and the tap action for an open request: "KIT ASKS 20 USDC - TAP: PAY". */
export function requestSignal(request: MoneyRequest, requester: Requester, actionId: string, now: number): Signal {
  const amount = formatUsdc(request.amount);
  const action: PendingAction = {
    id: actionId,
    source: 'telegram',
    protocol: 'sepolia',
    actionType: 'usdc_payout',
    headline: `${requester.name} ASKS ${amount} USDC`,
    factLine: `TO ${shortAddress(requester.address)} ON SEPOLIA (TESTNET USDC)`,
    actionPrompt: 'PAY',
    params: { tokenIn: 'USDC', amount: request.amount, to: requester.address, requestId: request.id },
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    requiresTap: true,
  };
  return {
    id: `request:${request.id}`,
    source: 'telegram',
    kind: 'money_request',
    severity: 'warning',
    line: fitSignalLine(`${requester.name} ASKS ${amount} USDC`),
    action,
    lossDistancePct: null,
    usdAtRisk: 0,
    createdAt: request.createdAt,
    updatedAt: now,
    expiresAt: request.expiresAt,
  };
}
