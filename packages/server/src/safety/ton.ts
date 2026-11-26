import { formatTon } from '@chainvision/shared';
import { TONCENTER_TESTNET_URL } from '../ton/toncenter.js';
import { SafetyPolicyError } from './policy.js';

/**
 * A TON payout to a requester: only through the testnet endpoint, only to an address the wearer
 * approved, a positive whole number of nanotons, and never above the per-request or rolling-24-hour caps.
 */
export function assertAllowedTonPayout(params: {
  endpoint: string;
  toKey: string;
  approvedRecipientKeys: Set<string>;
  amountNano: bigint;
  perRequestNano: bigint;
  dailyNano: bigint;
  paidLastDayNano: bigint;
}): void {
  if (params.endpoint !== TONCENTER_TESTNET_URL) {
    throw new SafetyPolicyError(`Blocked TON payout through ${params.endpoint}: testnet only`);
  }
  if (!params.approvedRecipientKeys.has(params.toKey)) {
    throw new SafetyPolicyError(`Blocked TON payout to ${params.toKey}: not an approved requester address`);
  }
  if (params.amountNano <= 0n) throw new SafetyPolicyError('TON payout amount must be positive');
  if (params.amountNano > params.perRequestNano) {
    throw new SafetyPolicyError(`TON payout ${formatTon(params.amountNano)} exceeds per-request cap ${formatTon(params.perRequestNano)}`);
  }
  if (params.paidLastDayNano + params.amountNano > params.dailyNano) {
    throw new SafetyPolicyError(
      `TON payout ${formatTon(params.amountNano)} would pass the daily cap ${formatTon(params.dailyNano)} (${formatTon(params.paidLastDayNano)} paid in 24 h)`,
    );
  }
}
