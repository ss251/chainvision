import type { UserThresholds } from '@chainvision/shared';
import {
  AAVE_V3_SEPOLIA,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_TOKENS,
  UNISWAP_V3_SEPOLIA,
} from '../config.js';

export const ALLOWED_EXECUTION_CONTRACTS = new Set<string>(
  [
    AAVE_V3_SEPOLIA.pool,
    AAVE_V3_SEPOLIA.wrappedTokenGatewayV3,
    AAVE_V3_SEPOLIA.faucet,
    UNISWAP_V3_SEPOLIA.swapRouter02,
    UNISWAP_V3_SEPOLIA.positionManager,
    SEPOLIA_TOKENS.WETH9.address,
  ].map((a) => a.toLowerCase()),
);

export const ALLOWED_APPROVE_TOKENS = new Set<string>(
  [
    SEPOLIA_TOKENS.WETH9.address,
    SEPOLIA_TOKENS.CIRCLE_USDC.address,
    SEPOLIA_TOKENS.AAVE_USDC.address,
    SEPOLIA_TOKENS.AAVE_DAI.address,
    SEPOLIA_TOKENS.AAVE_WETH.address,
    SEPOLIA_TOKENS.AAVE_WBTC.address,
    SEPOLIA_TOKENS.AAVE_EURS.address,
  ].map((a) => a.toLowerCase()),
);

export const ALLOWED_SPENDERS = new Set<string>(
  [
    AAVE_V3_SEPOLIA.pool,
    UNISWAP_V3_SEPOLIA.swapRouter02,
    UNISWAP_V3_SEPOLIA.positionManager,
  ].map((a) => a.toLowerCase()),
);

/** Tokens a Telegram money request may be paid in: Sepolia test USDC only. */
export const ALLOWED_PAYOUT_TOKENS = new Set<string>(
  [SEPOLIA_TOKENS.AAVE_USDC.address, SEPOLIA_TOKENS.CIRCLE_USDC.address].map((a) => a.toLowerCase()),
);

export class SafetyPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafetyPolicyError';
  }
}

export function assertSepoliaOnly(chainId: number): void {
  if (chainId !== SEPOLIA_CHAIN_ID) {
    throw new SafetyPolicyError(
      `Testnet-only policy violation: chainId ${chainId} is not Sepolia (${SEPOLIA_CHAIN_ID})`,
    );
  }
}

export function assertAllowedEvmContract(to: string, chainId: number): void {
  assertSepoliaOnly(chainId);
  if (!ALLOWED_EXECUTION_CONTRACTS.has(to.toLowerCase())) {
    throw new SafetyPolicyError(`Blocked contract ${to}: not in Sepolia allowlist`);
  }
}

export function assertAllowedErc20Approval(
  token: string,
  spender: string,
  chainId: number,
): void {
  assertSepoliaOnly(chainId);
  if (!ALLOWED_APPROVE_TOKENS.has(token.toLowerCase())) {
    throw new SafetyPolicyError(`Blocked token approval ${token}: not in Sepolia token allowlist`);
  }
  if (!ALLOWED_SPENDERS.has(spender.toLowerCase())) {
    throw new SafetyPolicyError(`Blocked spender ${spender}: not in Sepolia spender allowlist`);
  }
}

export function assertWithinActionCaps(params: {
  amountUsd?: number;
  amountEth?: number;
  amountUsdc?: number;
  thresholds: UserThresholds;
}): void {
  const { amountUsd, amountEth, amountUsdc, thresholds } = params;
  if (amountUsd !== undefined && amountUsd > thresholds.maxSingleActionUsd) {
    throw new SafetyPolicyError(
      `Action notional $${amountUsd.toFixed(2)} exceeds cap $${thresholds.maxSingleActionUsd}`,
    );
  }
  if (amountEth !== undefined && amountEth > thresholds.maxEvmSwapEth) {
    throw new SafetyPolicyError(
      `ETH amount ${amountEth} exceeds per-action cap ${thresholds.maxEvmSwapEth} ETH`,
    );
  }
  if (amountUsdc !== undefined && amountUsdc > thresholds.maxUsdcAction) {
    throw new SafetyPolicyError(
      `Stablecoin amount ${amountUsdc} exceeds per-action cap ${thresholds.maxUsdcAction}`,
    );
  }
}

export function assertHyperliquidOrderAllowed(params: {
  apiUrl: string;
  reduceOnly: boolean;
  isWithdraw?: boolean;
  notionalUsd: number;
  thresholds: UserThresholds;
}): void {
  if (!params.apiUrl.includes('testnet')) {
    throw new SafetyPolicyError(`Hyperliquid mainnet is blocked: ${params.apiUrl}`);
  }
  if (params.isWithdraw) {
    throw new SafetyPolicyError('Hyperliquid withdrawals are permanently disabled (non-withdrawable agent)');
  }
  if (!params.reduceOnly) {
    throw new SafetyPolicyError('Phase 1 Hyperliquid orders are restricted to reduce-only');
  }
  if (params.notionalUsd > params.thresholds.maxSingleActionUsd) {
    throw new SafetyPolicyError(
      `Hyperliquid order notional $${params.notionalUsd.toFixed(2)} exceeds cap $${params.thresholds.maxSingleActionUsd}`,
    );
  }
}

/**
 * A payout to a requester: Sepolia only, Sepolia test USDC only, only to an address the wearer
 * approved, and never above the per-request or rolling-24-hour caps.
 */
export function assertAllowedPayout(params: {
  chainId: number;
  token: string;
  to: string;
  amountUsdc: number;
  approvedRecipients: Set<string>;
  perRequestCapUsdc: number;
  dailyCapUsdc: number;
  paidLastDayUsdc: number;
}): void {
  assertSepoliaOnly(params.chainId);
  if (!ALLOWED_PAYOUT_TOKENS.has(params.token.toLowerCase())) {
    throw new SafetyPolicyError(`Blocked payout token ${params.token}: only Sepolia test USDC`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(params.to) || !params.approvedRecipients.has(params.to.toLowerCase())) {
    throw new SafetyPolicyError(`Blocked payout to ${params.to}: not an approved requester address`);
  }
  if (!Number.isFinite(params.amountUsdc) || params.amountUsdc <= 0) {
    throw new SafetyPolicyError('Payout amount must be positive');
  }
  if (params.amountUsdc > params.perRequestCapUsdc) {
    throw new SafetyPolicyError(`Payout ${params.amountUsdc} USDC exceeds per-request cap ${params.perRequestCapUsdc}`);
  }
  if (params.paidLastDayUsdc + params.amountUsdc > params.dailyCapUsdc) {
    throw new SafetyPolicyError(
      `Payout ${params.amountUsdc} USDC would pass the daily cap ${params.dailyCapUsdc} (${params.paidLastDayUsdc} paid in 24 h)`,
    );
  }
}
