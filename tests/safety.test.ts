import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS } from '@chainvision/shared';
import { AAVE_V3_SEPOLIA, SEPOLIA_CHAIN_ID, SEPOLIA_TOKENS, UNISWAP_V3_SEPOLIA } from '../packages/server/src/config.js';
import { computeHyperliquidActionHash } from '../packages/server/src/protocols/hyperliquid.js';
import {
  assertAllowedErc20Approval,
  assertAllowedEvmContract,
  assertHyperliquidOrderAllowed,
  assertSepoliaOnly,
  assertWithinActionCaps,
  SafetyPolicyError,
} from '../packages/server/src/safety/policy.js';

describe('Safety policy engine (testnet-only, allowlisted, capped)', () => {
  it('allows only Sepolia chainId 11155111 and blocks Ethereum mainnet (1)', () => {
    expect(() => assertSepoliaOnly(SEPOLIA_CHAIN_ID)).not.toThrow();
    expect(() => assertSepoliaOnly(1)).toThrow(SafetyPolicyError);
    expect(() => assertSepoliaOnly(42161)).toThrow(SafetyPolicyError);
  });

  it('allows only Aave Pool and Uniswap Router contracts on Sepolia', () => {
    expect(() => assertAllowedEvmContract(AAVE_V3_SEPOLIA.pool, SEPOLIA_CHAIN_ID)).not.toThrow();
    expect(() =>
      assertAllowedEvmContract(UNISWAP_V3_SEPOLIA.swapRouter02, SEPOLIA_CHAIN_ID),
    ).not.toThrow();
    expect(() =>
      assertAllowedEvmContract('0x000000000000000000000000000000000000dEaD', SEPOLIA_CHAIN_ID),
    ).toThrow(SafetyPolicyError);
  });

  it('restricts ERC20 approvals strictly to allowlisted tokens and spenders', () => {
    expect(() =>
      assertAllowedErc20Approval(
        SEPOLIA_TOKENS.AAVE_USDC.address,
        AAVE_V3_SEPOLIA.pool,
        SEPOLIA_CHAIN_ID,
      ),
    ).not.toThrow();
    expect(() =>
      assertAllowedErc20Approval(
        SEPOLIA_TOKENS.AAVE_USDC.address,
        '0x1111111111111111111111111111111111111111',
        SEPOLIA_CHAIN_ID,
      ),
    ).toThrow(SafetyPolicyError);
  });

  it('enforces per-action notional, ETH, and USDC caps', () => {
    expect(() =>
      assertWithinActionCaps({ amountUsd: 300, amountUsdc: 300, thresholds: DEFAULT_THRESHOLDS }),
    ).not.toThrow();
    expect(() =>
      assertWithinActionCaps({ amountUsd: 2500, thresholds: DEFAULT_THRESHOLDS }),
    ).toThrow(SafetyPolicyError);
    expect(() =>
      assertWithinActionCaps({ amountEth: 1.5, thresholds: DEFAULT_THRESHOLDS }),
    ).toThrow(SafetyPolicyError);
  });

  it('enforces Hyperliquid testnet-only, reduce-only, non-withdrawable policy', () => {
    expect(() =>
      assertHyperliquidOrderAllowed({
        apiUrl: 'https://api.hyperliquid-testnet.xyz',
        reduceOnly: true,
        isWithdraw: false,
        notionalUsd: 250,
        thresholds: DEFAULT_THRESHOLDS,
      }),
    ).not.toThrow();

    // Mainnet URL blocked
    expect(() =>
      assertHyperliquidOrderAllowed({
        apiUrl: 'https://api.hyperliquid.xyz',
        reduceOnly: true,
        notionalUsd: 100,
        thresholds: DEFAULT_THRESHOLDS,
      }),
    ).toThrow(SafetyPolicyError);

    // Withdraw blocked
    expect(() =>
      assertHyperliquidOrderAllowed({
        apiUrl: 'https://api.hyperliquid-testnet.xyz',
        reduceOnly: true,
        isWithdraw: true,
        notionalUsd: 100,
        thresholds: DEFAULT_THRESHOLDS,
      }),
    ).toThrow(SafetyPolicyError);

    // Non-reduce-only blocked in Phase 1
    expect(() =>
      assertHyperliquidOrderAllowed({
        apiUrl: 'https://api.hyperliquid-testnet.xyz',
        reduceOnly: false,
        notionalUsd: 100,
        thresholds: DEFAULT_THRESHOLDS,
      }),
    ).toThrow(SafetyPolicyError);
  });

  it('computes deterministic Hyperliquid L1 action hash', () => {
    const h1 = computeHyperliquidActionHash({ type: 'order', orders: [], grouping: 'na' }, 1700000000000);
    const h2 = computeHyperliquidActionHash({ type: 'order', orders: [], grouping: 'na' }, 1700000000000);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
