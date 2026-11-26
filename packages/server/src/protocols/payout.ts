import { createPublicClient, createWalletClient, formatUnits, http, parseAbi, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { type AppConfig, SEPOLIA_TOKENS } from '../config.js';
import { assertAllowedPayout } from '../safety/policy.js';

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
]);

/** Sends Sepolia test USDC from the app's own capped test wallet to an approved requester. */
export class SepoliaPayoutClient {
  private readonly publicClient;
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.publicClient = createPublicClient({ chain: sepolia, transport: http(config.sepoliaRpcUrl) });
  }

  get token() {
    return SEPOLIA_TOKENS[this.config.payoutToken];
  }

  async balance(): Promise<number> {
    const raw = await this.publicClient.readContract({
      address: this.token.address,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [this.config.sepoliaAddress],
    });
    return Number(formatUnits(raw, this.token.decimals));
  }

  async transferUsdc(params: {
    to: `0x${string}`;
    amount: number;
    approvedRecipients: Set<string>;
    perRequestCapUsdc: number;
    dailyCapUsdc: number;
    paidLastDayUsdc: number;
  }): Promise<{ txHash: `0x${string}`; explorerUrl: string; before: number; after: number }> {
    if (!this.config.sepoliaPrivateKey) throw new Error('SEPOLIA_PRIVATE_KEY is not configured');
    const chainId = await this.publicClient.getChainId();
    const token = this.token;
    assertAllowedPayout({
      chainId,
      token: token.address,
      to: params.to,
      amountUsdc: params.amount,
      approvedRecipients: params.approvedRecipients,
      perRequestCapUsdc: params.perRequestCapUsdc,
      dailyCapUsdc: params.dailyCapUsdc,
      paidLastDayUsdc: params.paidLastDayUsdc,
    });
    const before = await this.balance();
    if (before < params.amount) throw new Error(`Test wallet holds ${before} USDC, less than ${params.amount}`);
    const account = privateKeyToAccount(this.config.sepoliaPrivateKey);
    const walletClient = createWalletClient({ account, chain: sepolia, transport: http(this.config.sepoliaRpcUrl) });
    const txHash = await walletClient.writeContract({
      address: token.address,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [params.to, parseUnits(params.amount.toString(), token.decimals)],
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') throw new Error(`USDC transfer reverted: ${txHash}`);
    return { txHash, explorerUrl: `https://sepolia.etherscan.io/tx/${txHash}`, before, after: await this.balance() };
  }
}
