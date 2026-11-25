import crypto from 'node:crypto';
import {
  checkTonPayout,
  formatTon,
  parseTonAmount,
  tonPaidInLastDay,
  type ExecutionReceipt,
  type PendingAction,
  type TonCaps,
  type TonPayoutView,
  type TonRequestView,
  type TonRequesterView,
} from '@chainvision/shared';
import { tonAddressKey } from './address.js';
import type { TonTestnetWallet, TonTransferResult } from './wallet.js';

/**
 * What the TON rail reads from the Telegram request model: open requests, their requesters and
 * past payouts. The request book from the money-request flow satisfies it once its Requester
 * carries `tonAddress` and its MoneyRequest and Payout carry `currency`.
 */
export interface TonRequestBookView {
  request(id: string): TonRequestView | null;
  requester(telegramUserId: string): TonRequesterView | null;
  readonly requesters: TonRequesterView[];
  readonly payouts: TonPayoutView[];
}

/** The request model as the engine uses it: read requests, and record the outcome of a payout. */
export interface TonRequestDesk extends TonRequestBookView {
  /** The transfer is on chain: mark the request paid, record the payout and send the requester its receipt. */
  settle(paid: TonPaid): Promise<void>;
  /** The transfer failed after every check passed: mark the request failed and tell the requester. */
  failed(requestId: string, message: string): Promise<void>;
}

/** A send that failed after the request passed every check, as opposed to a request that was refused. */
export class TonTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TonTransferError';
  }
}

export function approvedTonAddressKeys(requesters: TonRequesterView[]): Set<string> {
  const keys = new Set<string>();
  for (const r of requesters) {
    const key = r.status === 'approved' && r.tonAddress ? tonAddressKey(r.tonAddress) : null;
    if (key) keys.add(key);
  }
  return keys;
}

export interface TonPaid {
  request: TonRequestView;
  requester: TonRequesterView & { tonAddress: string };
  transfer: TonTransferResult;
  receipt: ExecutionReceipt;
  /** Receipt text for the requester's chat and the group the request came from. */
  requesterText: string;
}

/** Pays a TON request from the app's capped test wallet. Every rule is checked again here, at the moment of paying. */
export class TonRequestRail {
  private readonly paying = new Set<string>();

  constructor(readonly wallet: TonTestnetWallet) {}

  async pay(action: PendingAction, book: TonRequestBookView, caps: TonCaps, now = Date.now()): Promise<TonPaid> {
    if (action.actionType !== 'ton_payout') throw new Error('Not a TON payout');
    const id = action.params.requestId ?? '';
    const request = book.request(id);
    const requester = request ? book.requester(request.requesterId) : null;
    if (this.paying.has(id)) throw new Error('This request is already being paid');
    const check = checkTonPayout({ request, requester, payouts: book.payouts, caps, now });
    if (!check.ok) throw new Error(check.reason);
    if (!request || !requester?.tonAddress) throw new Error('Request not found');
    const amountNano = parseTonAmount(request.amount);
    if (amountNano === null) throw new Error('Request amount is not a valid TON amount');

    this.paying.add(id);
    try {
      const transfer = await this.wallet
        .transfer({
          to: requester.tonAddress,
          amountNano,
          comment: `ChainVision request ${request.id}`,
          approvedRecipientKeys: approvedTonAddressKeys(book.requesters),
          perRequestNano: parseTonAmount(caps.perRequestTon) ?? 0n,
          dailyNano: parseTonAmount(caps.dailyTon) ?? 0n,
          paidLastDayNano: tonPaidInLastDay(book.payouts, now),
        })
        .catch((err: unknown) => {
          throw new TonTransferError(err instanceof Error ? err.message : String(err));
        });
      const amount = formatTon(amountNano);
      const receipt: ExecutionReceipt = {
        id: `rcpt_${crypto.randomBytes(4).toString('hex')}`,
        actionId: action.id,
        protocol: 'ton',
        actionType: 'ton_payout',
        network: 'ton-testnet',
        summary: `PAID ${amount} TON TO ${requester.name}`,
        beforeFact: `WALLET ${formatTon(transfer.beforeNano)} TON`,
        afterFact: `WALLET ${formatTon(transfer.afterNano)} TON`,
        txHashOrOrderId: transfer.txHash,
        explorerUrl: transfer.explorerUrl,
        telegramPosted: false,
        timestamp: Date.now(),
      };
      const requesterText = [
        'ChainVision Testnet Receipt',
        `The wearer paid your request: ${amount} TON on TON testnet`,
        `To: ${transfer.to}`,
        `Tx: ${transfer.txHash}`,
        `Explorer: ${transfer.explorerUrl}`,
        'Testnet only · Not financial advice',
      ].join('\n');
      return { request, requester: { ...requester, tonAddress: requester.tonAddress }, transfer, receipt, requesterText };
    } finally {
      this.paying.delete(id);
    }
  }
}
