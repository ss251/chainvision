import { Address } from '@ton/core';

export interface ParsedTonAddress {
  address: Address;
  /** Bounce flag the owner encoded in a user-friendly address; a raw address is sent non-bounceable. */
  bounceable: boolean;
  testOnly: boolean;
}

/** Accepts a user-friendly TON address (EQ.., UQ.., kQ.., 0Q..) or a raw "0:<64 hex>" one; checksum verified. */
export function parseTonAddress(input: string): ParsedTonAddress | null {
  const text = input.trim();
  try {
    if (Address.isFriendly(text)) {
      const parsed = Address.parseFriendly(text);
      return { address: parsed.address, bounceable: parsed.isBounceable, testOnly: parsed.isTestOnly };
    }
    if (Address.isRaw(text)) return { address: Address.parseRaw(text), bounceable: false, testOnly: false };
  } catch {
    return null;
  }
  return null;
}

/** The form shown to people for a testnet account: testnet, non-bounceable, URL-safe ("0Q.."). */
export function testnetFriendly(address: Address): string {
  return address.toString({ testOnly: true, bounceable: false, urlSafe: true });
}

/** One comparable key per account, whatever form it was written in. */
export function tonAddressKey(input: string): string | null {
  return parseTonAddress(input)?.address.toRawString() ?? null;
}
