import { describe, expect, it } from 'vitest';
import { parseIntentJson, parseVoiceIntentLocally } from '@chainvision/shared';

describe('Voice intent JSON parsing (OpenRouter schema)', () => {
  it('parses valid aave_supply JSON', () => {
    const res = parseIntentJson(
      '{"action":"aave_supply","token":"USDC","amount":200,"compareVenues":true,"confidence":0.96}',
    );
    expect(res).toEqual({
      action: 'aave_supply',
      token: 'USDC',
      amount: 200,
      compareVenues: true,
      confidence: 0.96,
    });
  });

  it('strips markdown json fences cleanly', () => {
    const res = parseIntentJson(
      '```json\n{"action":"uniswap_swap","tokenIn":"ETH","tokenOut":"USDC","amountPct":50}\n```',
    );
    expect(res.action).toBe('uniswap_swap');
    if (res.action === 'uniswap_swap') {
      expect(res.tokenIn).toBe('ETH');
      expect(res.tokenOut).toBe('USDC');
      expect(res.amountPct).toBe(50);
    }
  });

  it('rejects same-token swaps', () => {
    const res = parseIntentJson(
      '{"action":"uniswap_swap","tokenIn":"USDC","tokenOut":"USDC","amount":100}',
    );
    expect(res.action).toBe('unsupported');
  });

  it('rejects swaps missing both amount and amountPct', () => {
    const res = parseIntentJson('{"action":"uniswap_swap","tokenIn":"ETH","tokenOut":"USDC"}');
    expect(res.action).toBe('unsupported');
  });

  it('rejects malformed JSON without throwing', () => {
    const res = parseIntentJson('not json at all');
    expect(res.action).toBe('unsupported');
  });

  it('rejects negative amounts or out-of-range percentages', () => {
    expect(parseIntentJson('{"action":"aave_repay","token":"USDC","amount":-50}').action).toBe(
      'unsupported',
    );
    expect(parseIntentJson('{"action":"hl_trim","coin":"ETH","amountPct":150}').action).toBe(
      'unsupported',
    );
  });
});

describe('Local voice intent parser (stub/fallback)', () => {
  it('parses "put 200 USDC to work" as aave_supply', () => {
    const res = parseVoiceIntentLocally('put 200 USDC to work');
    expect(res.action).toBe('aave_supply');
    if (res.action === 'aave_supply') {
      expect(res.token).toBe('USDC');
      expect(res.amount).toBe(200);
    }
  });

  it('parses "swap half my ETH to USDC" as 50% uniswap_swap', () => {
    const res = parseVoiceIntentLocally('swap half my ETH to USDC');
    expect(res.action).toBe('uniswap_swap');
    if (res.action === 'uniswap_swap') {
      expect(res.tokenIn).toBe('ETH');
      expect(res.tokenOut).toBe('USDC');
      expect(res.amountPct).toBe(50);
    }
  });

  it('parses "swap 0.01 ETH for USDC" with exact amount', () => {
    const res = parseVoiceIntentLocally('swap 0.01 ETH for USDC');
    expect(res.action).toBe('uniswap_swap');
    if (res.action === 'uniswap_swap') {
      expect(res.amount).toBe(0.01);
    }
  });

  it('parses "repay 300 USDC on Aave" as aave_repay', () => {
    const res = parseVoiceIntentLocally('repay 300 USDC on Aave');
    expect(res.action).toBe('aave_repay');
    if (res.action === 'aave_repay') {
      expect(res.token).toBe('USDC');
      expect(res.amount).toBe(300);
    }
  });

  it('parses "trim half my ETH perp" as 50% hl_trim', () => {
    const res = parseVoiceIntentLocally('trim half my ETH perp');
    expect(res.action).toBe('hl_trim');
    if (res.action === 'hl_trim') {
      expect(res.coin).toBe('ETH');
      expect(res.amountPct).toBe(50);
    }
  });

  it('blocks withdrawals, transfers, and mainnet requests', () => {
    expect(parseVoiceIntentLocally('withdraw 500 USDC to my wallet').action).toBe('unsupported');
    expect(parseVoiceIntentLocally('swap 1 ETH on mainnet').action).toBe('unsupported');
  });
});
