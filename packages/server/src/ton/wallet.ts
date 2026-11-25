import { SendMode, beginCell, external, internal, storeMessage, type Address } from '@ton/core';
import { mnemonicToPrivateKey, mnemonicValidate, type KeyPair } from '@ton/crypto';
import { WalletContractV4 } from '@ton/ton';
import { formatTon, type TonIncomingTransfer, type TonWalletSnapshot } from '@chainvision/shared';
import { assertAllowedTonPayout } from '../safety/ton.js';
import { parseTonAddress, testnetFriendly, tonAddressKey } from './address.js';
import { TONCENTER_TESTNET_URL, Toncenter, tonHashToHex, tonTestnetTxUrl, type ToncenterTransaction } from './toncenter.js';

/** Kept in the wallet on every payout so it can always pay its own fees. */
export const TON_FEE_RESERVE_NANO = 50_000_000n;
const CONFIRM_TIMEOUT_MS = 90_000;

export interface TonTransferResult {
  txHash: string;
  messageHash: string;
  explorerUrl: string;
  from: string;
  to: string;
  amountNano: bigint;
  beforeNano: bigint;
  afterNano: bigint;
}

export function incomingTransfers(txs: ToncenterTransaction[]): TonIncomingTransfer[] {
  const out: TonIncomingTransfer[] = [];
  for (const tx of txs) {
    const msg = tx.in_msg;
    const value = BigInt(msg?.value || '0');
    if (!msg?.source || value <= 0n) continue;
    const from = parseTonAddress(msg.source);
    out.push({
      hash: tonHashToHex(tx.transaction_id.hash),
      lt: tx.transaction_id.lt,
      from: from ? testnetFriendly(from.address) : msg.source,
      amountNano: value.toString(),
      comment: msg.message ?? '',
      at: tx.utime * 1000,
    });
  }
  return out;
}

/**
 * The app's own TON testnet wallet (v4r2), derived from TON_TESTNET_MNEMONIC. It reads through
 * toncenter testnet and can only send through it; the caller passes the requester caps it is held to.
 */
export class TonTestnetWallet {
  private keyPair: Promise<KeyPair> | null = null;

  constructor(
    private readonly mnemonic: string | null,
    readonly api: Toncenter = new Toncenter('testnet'),
  ) {
    if (api.network !== 'testnet' || api.baseUrl !== TONCENTER_TESTNET_URL) {
      throw new Error('The app TON wallet only runs on testnet');
    }
  }

  get configured(): boolean {
    return Boolean(this.mnemonic);
  }

  private keys(): Promise<KeyPair> {
    if (!this.mnemonic) return Promise.reject(new Error('TON_TESTNET_MNEMONIC is not configured'));
    this.keyPair ??= (async () => {
      const words = (this.mnemonic as string).trim().split(/\s+/);
      if (!(await mnemonicValidate(words))) throw new Error('TON_TESTNET_MNEMONIC is not a valid TON mnemonic');
      return mnemonicToPrivateKey(words);
    })();
    return this.keyPair;
  }

  private async contract(): Promise<WalletContractV4> {
    return WalletContractV4.create({ workchain: 0, publicKey: (await this.keys()).publicKey });
  }

  async address(): Promise<Address> {
    return (await this.contract()).address;
  }

  /** Testnet, non-bounceable form, the one to paste into a faucet or wallet. */
  async friendlyAddress(): Promise<string> {
    return testnetFriendly(await this.address());
  }

  async balanceNano(): Promise<bigint> {
    return BigInt(await this.api.getAddressBalance(testnetFriendly(await this.address())));
  }

  async read(now = Date.now()): Promise<TonWalletSnapshot> {
    if (!this.mnemonic) {
      return { network: 'ton-testnet', address: null, balanceNano: null, state: null, incoming: [], updatedAt: now, error: 'TON_TESTNET_MNEMONIC is not configured' };
    }
    let address: string | null = null;
    try {
      address = await this.friendlyAddress();
      const info = await this.api.getWalletInformation(address);
      const txs = await this.api.getTransactions(address, 10);
      return { network: 'ton-testnet', address, balanceNano: BigInt(info.balance).toString(), state: info.account_state, incoming: incomingTransfers(txs), updatedAt: now };
    } catch (err) {
      return { network: 'ton-testnet', address, balanceNano: null, state: null, incoming: [], updatedAt: now, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Send testnet TON to an approved requester and wait until the chain shows it. The first send
   * from a fresh wallet also deploys the wallet contract.
   */
  async transfer(params: {
    to: string;
    amountNano: bigint;
    comment: string;
    approvedRecipientKeys: Set<string>;
    perRequestNano: bigint;
    dailyNano: bigint;
    paidLastDayNano: bigint;
  }): Promise<TonTransferResult> {
    const dest = parseTonAddress(params.to);
    if (!dest) throw new Error(`Not a TON address: ${params.to}`);
    assertAllowedTonPayout({
      endpoint: this.api.baseUrl,
      toKey: dest.address.toRawString(),
      approvedRecipientKeys: params.approvedRecipientKeys,
      amountNano: params.amountNano,
      perRequestNano: params.perRequestNano,
      dailyNano: params.dailyNano,
      paidLastDayNano: params.paidLastDayNano,
    });
    const keys = await this.keys();
    const wallet = await this.contract();
    const from = testnetFriendly(wallet.address);
    const info = await this.api.getWalletInformation(from);
    const beforeNano = BigInt(info.balance);
    if (beforeNano < params.amountNano + TON_FEE_RESERVE_NANO) {
      throw new Error(`Test wallet holds ${formatTon(beforeNano)} TON, less than ${formatTon(params.amountNano)} TON plus fees`);
    }
    const seqno = info.account_state === 'active' ? Number(info.seqno ?? 0) : 0;
    const lastLt = BigInt((await this.api.getTransactions(from, 1))[0]?.transaction_id.lt ?? '0');
    const body = wallet.createTransfer({
      seqno,
      secretKey: keys.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
      messages: [internal({ to: dest.address, value: params.amountNano, bounce: dest.bounceable, body: params.comment })],
    });
    const ext = external({ to: wallet.address, init: seqno === 0 ? wallet.init : undefined, body });
    const boc = beginCell().store(storeMessage(ext)).endCell().toBoc().toString('base64');
    const sent = await this.api.sendBocReturnHash(boc);

    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    const toKey = dest.address.toRawString();
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const after = await this.api.getWalletInformation(from).catch(() => null);
      if (!after || Number(after.seqno ?? 0) <= seqno) continue;
      const txs = await this.api.getTransactions(from, 5).catch(() => []);
      const tx = txs.find(
        (t) =>
          BigInt(t.transaction_id.lt) > lastLt &&
          !t.in_msg?.source &&
          (t.out_msgs ?? []).some((m) => m.destination && tonAddressKey(m.destination) === toKey && BigInt(m.value ?? '0') === params.amountNano),
      );
      if (!tx) continue;
      return {
        txHash: tonHashToHex(tx.transaction_id.hash),
        messageHash: tonHashToHex(sent.hash),
        explorerUrl: tonTestnetTxUrl(tx.transaction_id.hash),
        from,
        to: testnetFriendly(dest.address),
        amountNano: params.amountNano,
        beforeNano,
        afterNano: BigInt(after.balance),
      };
    }
    throw new Error(`TON transfer not seen on testnet within ${CONFIRM_TIMEOUT_MS / 1000} s (message ${tonHashToHex(sent.hash)})`);
  }
}

/** Balance of any address, read-only. The mainnet instance has no way to send. */
export async function readTonBalance(api: Toncenter, address: string): Promise<bigint> {
  const parsed = parseTonAddress(address);
  if (!parsed) throw new Error(`Not a TON address: ${address}`);
  return BigInt(await api.getAddressBalance(parsed.address.toString({ testOnly: api.network === 'testnet', bounceable: false })));
}
