import crypto from 'node:crypto';
import {
  REQUEST_TTL_MS,
  checkAsk,
  checkTonAsk,
  isOpen,
  paidInLastDay,
  requesterDisplayName,
  type MoneyRequest,
  type Payout,
  type RequestCaps,
  type RequestMessage,
  type RequestResolution,
  type RequestStatus,
  type Requester,
  type TonCaps,
} from '@chainvision/shared';
import { parseTonAddress, testnetFriendly, tonAddressKey } from '../ton/address.js';

export type AskResult = { ok: true; request: MoneyRequest; requester: Requester } | { ok: false; reason: string };

/** Requesters the wearer knows, their requests, and what has been paid; persisted through `save`. */
export class RequestBook {
  constructor(
    private readonly state: { requesters: Requester[]; requests: MoneyRequest[]; payouts: Payout[] },
    private readonly save: () => void,
  ) {}

  get requesters(): Requester[] {
    return this.state.requesters;
  }

  get requests(): MoneyRequest[] {
    return this.state.requests;
  }

  get payouts(): Payout[] {
    return this.state.payouts;
  }

  requester(telegramUserId: string): Requester | null {
    return this.state.requesters.find((r) => r.telegramUserId === telegramUserId) ?? null;
  }

  request(id: string): MoneyRequest | null {
    return this.state.requests.find((r) => r.id === id) ?? null;
  }

  approvedAddresses(): Set<string> {
    return new Set(this.state.requesters.filter((r) => r.status === 'approved' && r.address).map((r) => (r.address as string).toLowerCase()));
  }

  paidLastDay(now: number): number {
    return paidInLastDay(this.state.payouts, now);
  }

  /** Register or update a requester with a Sepolia or a TON testnet address. A new address always needs the wearer's approval again. */
  register(
    user: { id: string; firstName: string; username: string | null },
    address: string,
    name: string | undefined,
    now: number,
  ): { ok: true; requester: Requester; needsApproval: boolean } | { ok: false; reason: string } {
    const evm = /^0x[0-9a-fA-F]{40}$/.test(address) ? (address as `0x${string}`) : null;
    const ton = evm ? null : parseTonAddress(address);
    if (!evm && !ton) {
      return { ok: false, reason: 'Send a Sepolia address (0x...) or a TON testnet address: /register <address> <name>' };
    }
    const tonAddress = ton ? testnetFriendly(ton.address) : null;
    const existing = this.requester(user.id);
    const displayName = requesterDisplayName(name || user.firstName);
    if (existing) {
      const sameAddress = evm
        ? existing.address?.toLowerCase() === evm.toLowerCase()
        : Boolean(existing.tonAddress) && tonAddressKey(existing.tonAddress as string) === ton?.address.toRawString();
      existing.name = displayName;
      existing.username = user.username;
      if (!sameAddress) {
        if (evm) existing.address = evm;
        else existing.tonAddress = tonAddress;
        existing.status = 'pending';
        existing.approvedAt = null;
      }
      this.save();
      return { ok: true, requester: existing, needsApproval: existing.status !== 'approved' };
    }
    const requester: Requester = {
      telegramUserId: user.id,
      name: displayName,
      username: user.username,
      address: evm,
      tonAddress,
      status: 'pending',
      registeredAt: now,
      approvedAt: null,
    };
    this.state.requesters.push(requester);
    this.save();
    return { ok: true, requester, needsApproval: true };
  }

  approve(telegramUserId: string, now: number): Requester | null {
    const r = this.requester(telegramUserId);
    if (!r) return null;
    r.status = 'approved';
    r.approvedAt = now;
    this.save();
    return r;
  }

  remove(telegramUserId: string): boolean {
    const before = this.state.requesters.length;
    this.state.requesters = this.state.requesters.filter((r) => r.telegramUserId !== telegramUserId);
    if (this.state.requesters.length === before) return false;
    this.save();
    return true;
  }

  ask(
    telegramUserId: string,
    amount: number,
    chat: { id: string; isGroup: boolean },
    caps: RequestCaps,
    now: number,
  ): AskResult {
    const requester = this.requester(telegramUserId);
    const check = checkAsk({ requester, amount, requests: this.state.requests, payouts: this.state.payouts, caps, now });
    if (!check.ok) return check;
    return this.openRequest(requester as Requester, amount, 'USDC', chat, now);
  }

  askTon(telegramUserId: string, amount: number, chat: { id: string; isGroup: boolean }, caps: TonCaps, now: number): AskResult {
    const requester = this.requester(telegramUserId);
    const openRequestIds = this.state.requests.filter((r) => r.requesterId === telegramUserId && isOpen(r, now)).map((r) => r.id);
    const check = checkTonAsk({ requester, amount, openRequestIds, payouts: this.state.payouts, caps, now });
    if (!check.ok) return check;
    return this.openRequest(requester as Requester, amount, 'TON', chat, now);
  }

  private openRequest(requester: Requester, amount: number, currency: 'USDC' | 'TON', chat: { id: string; isGroup: boolean }, now: number): AskResult {
    const telegramUserId = requester.telegramUserId;
    const request: MoneyRequest = {
      id: `rq_${crypto.randomBytes(4).toString('hex')}`,
      requesterId: telegramUserId,
      amount,
      currency,
      createdAt: now,
      expiresAt: now + REQUEST_TTL_MS,
      status: 'open',
      askedInChatId: chat.id,
      askedInGroup: chat.isGroup,
      resolvedAt: null,
      resolvedVia: null,
      txHash: null,
      error: null,
      messages: [],
    };
    this.state.requests.push(request);
    this.save();
    return { ok: true, request, requester };
  }

  open(now: number): MoneyRequest[] {
    return this.state.requests.filter((r) => isOpen(r, now));
  }

  /** Mark every open request past its expiry as expired and return them. */
  expire(now: number): MoneyRequest[] {
    const expired = this.state.requests.filter((r) => r.status === 'open' && r.expiresAt <= now);
    for (const r of expired) {
      r.status = 'expired';
      r.resolvedAt = now;
      r.resolvedVia = 'expiry';
    }
    if (expired.length) this.save();
    return expired;
  }

  resolve(
    request: MoneyRequest,
    status: Exclude<RequestStatus, 'open'>,
    via: RequestResolution,
    now: number,
    extra: { txHash?: string; error?: string } = {},
  ): void {
    request.status = status;
    request.resolvedAt = now;
    request.resolvedVia = via;
    request.txHash = extra.txHash ?? request.txHash;
    request.error = extra.error ?? request.error;
    if (status === 'paid' && extra.txHash) {
      this.state.payouts.push({
        requestId: request.id,
        requesterId: request.requesterId,
        amount: request.amount,
        currency: request.currency ?? 'USDC',
        txHash: extra.txHash,
        at: now,
      });
    }
    this.save();
  }

  noteMessage(request: MoneyRequest, message: RequestMessage): void {
    request.messages.push(message);
    this.save();
  }
}
