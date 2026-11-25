import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  parseAbi,
  parseUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import type { AaveSnapshot, UserThresholds } from '@chainvision/shared';
import {
  AAVE_V3_SEPOLIA,
  type AppConfig,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_TOKENS,
} from '../config.js';
import {
  assertAllowedErc20Approval,
  assertAllowedEvmContract,
  assertSepoliaOnly,
  assertWithinActionCaps,
} from '../safety/policy.js';

const AAVE_POOL_ABI = parseAbi([
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)',
]);

const DATA_PROVIDER_ABI = parseAbi([
  'function getReserveData(address asset) view returns (uint256 unbacked, uint256 accruedToTreasuryScaled, uint256 totalAToken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 averageStableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint40 lastUpdateTimestamp)',
  'function getReserveCaps(address asset) view returns (uint256 borrowCap, uint256 supplyCap)',
]);

const WETH_GATEWAY_ABI = parseAbi([
  'function depositETH(address pool, address onBehalfOf, uint16 referralCode) payable',
]);

const FAUCET_ABI = parseAbi([
  'function mint(address token, address to, uint256 value) returns (uint256)',
]);

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
]);

const RAY = 1e27;

export class AaveSepoliaClient {
  private readonly publicClient;
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.publicClient = createPublicClient({
      chain: sepolia,
      transport: http(config.sepoliaRpcUrl),
    });
  }

  async readSnapshot(overrideAddress?: `0x${string}`): Promise<AaveSnapshot> {
    const address = overrideAddress ?? this.config.sepoliaAddress;
    try {
      const [
        accountData,
        usdcReserve,
        usdcCaps,
        daiReserve,
        daiCaps,
        eursReserve,
        wethReserve,
        usdcBal,
        daiBal,
        eursBal,
        ethBal,
      ] = await Promise.all([
        this.publicClient.readContract({
          address: AAVE_V3_SEPOLIA.pool,
          abi: AAVE_POOL_ABI,
          functionName: 'getUserAccountData',
          args: [address],
        }),
        this.publicClient.readContract({
          address: AAVE_V3_SEPOLIA.poolDataProvider,
          abi: DATA_PROVIDER_ABI,
          functionName: 'getReserveData',
          args: [SEPOLIA_TOKENS.AAVE_USDC.address],
        }),
        this.publicClient.readContract({
          address: AAVE_V3_SEPOLIA.poolDataProvider,
          abi: DATA_PROVIDER_ABI,
          functionName: 'getReserveCaps',
          args: [SEPOLIA_TOKENS.AAVE_USDC.address],
        }),
        this.publicClient.readContract({
          address: AAVE_V3_SEPOLIA.poolDataProvider,
          abi: DATA_PROVIDER_ABI,
          functionName: 'getReserveData',
          args: [SEPOLIA_TOKENS.AAVE_DAI.address],
        }),
        this.publicClient.readContract({
          address: AAVE_V3_SEPOLIA.poolDataProvider,
          abi: DATA_PROVIDER_ABI,
          functionName: 'getReserveCaps',
          args: [SEPOLIA_TOKENS.AAVE_DAI.address],
        }),
        this.publicClient.readContract({
          address: AAVE_V3_SEPOLIA.poolDataProvider,
          abi: DATA_PROVIDER_ABI,
          functionName: 'getReserveData',
          args: [SEPOLIA_TOKENS.AAVE_EURS.address],
        }),
        this.publicClient.readContract({
          address: AAVE_V3_SEPOLIA.poolDataProvider,
          abi: DATA_PROVIDER_ABI,
          functionName: 'getReserveData',
          args: [SEPOLIA_TOKENS.AAVE_WETH.address],
        }),
        this.publicClient.readContract({
          address: SEPOLIA_TOKENS.AAVE_USDC.address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [address],
        }),
        this.publicClient.readContract({
          address: SEPOLIA_TOKENS.AAVE_DAI.address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [address],
        }),
        this.publicClient.readContract({
          address: SEPOLIA_TOKENS.AAVE_EURS.address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [address],
        }),
        this.publicClient.getBalance({ address }),
      ]);

      const [
        totalCollateralBase,
        totalDebtBase,
        availableBorrowsBase,
        currentLiqThreshold,
        ltv,
        healthFactorRaw,
      ] = accountData;

      const totalDebtUsd = Number(formatUnits(totalDebtBase, 8));
      const healthFactor =
        totalDebtBase === 0n ? null : Number(formatUnits(healthFactorRaw, 18));

      const usdcCapFull =
        usdcCaps[1] > 0n &&
        Number(formatUnits(usdcReserve[2], SEPOLIA_TOKENS.AAVE_USDC.decimals)) >= Number(usdcCaps[1]);
      const daiCapFull =
        daiCaps[1] > 0n &&
        Number(formatUnits(daiReserve[2], SEPOLIA_TOKENS.AAVE_DAI.decimals)) >= Number(daiCaps[1]);

      return {
        network: 'sepolia',
        address,
        healthFactor,
        totalCollateralUsd: Number(formatUnits(totalCollateralBase, 8)),
        totalDebtUsd,
        availableBorrowsUsd: Number(formatUnits(availableBorrowsBase, 8)),
        currentLiquidationThresholdPct: Number(currentLiqThreshold) / 100,
        ltvPct: Number(ltv) / 100,
        usdcBalance: Number(formatUnits(usdcBal, SEPOLIA_TOKENS.AAVE_USDC.decimals)),
        daiBalance: Number(formatUnits(daiBal, SEPOLIA_TOKENS.AAVE_DAI.decimals)),
        eursBalance: Number(formatUnits(eursBal, SEPOLIA_TOKENS.AAVE_EURS.decimals)),
        ethBalance: Number(formatUnits(ethBal, 18)),
        rates: [
          {
            symbol: 'USDC',
            address: SEPOLIA_TOKENS.AAVE_USDC.address,
            supplyApyPct: (Number(usdcReserve[5]) / RAY) * 100,
            borrowApyPct: (Number(usdcReserve[6]) / RAY) * 100,
            supplyCapReached: usdcCapFull,
          },
          {
            symbol: 'EURS',
            address: SEPOLIA_TOKENS.AAVE_EURS.address,
            supplyApyPct: (Number(eursReserve[5]) / RAY) * 100,
            borrowApyPct: (Number(eursReserve[6]) / RAY) * 100,
            supplyCapReached: false,
          },
          {
            symbol: 'DAI',
            address: SEPOLIA_TOKENS.AAVE_DAI.address,
            supplyApyPct: (Number(daiReserve[5]) / RAY) * 100,
            borrowApyPct: (Number(daiReserve[6]) / RAY) * 100,
            supplyCapReached: daiCapFull,
          },
          {
            symbol: 'WETH',
            address: SEPOLIA_TOKENS.AAVE_WETH.address,
            supplyApyPct: (Number(wethReserve[5]) / RAY) * 100,
            borrowApyPct: (Number(wethReserve[6]) / RAY) * 100,
            supplyCapReached: false,
          },
        ],
      };
    } catch (err) {
      return {
        network: 'sepolia',
        address,
        healthFactor: null,
        totalCollateralUsd: 0,
        totalDebtUsd: 0,
        availableBorrowsUsd: 0,
        currentLiquidationThresholdPct: 0,
        ltvPct: 0,
        usdcBalance: 0,
        daiBalance: 0,
        ethBalance: 0,
        rates: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private getWalletClient() {
    if (!this.config.sepoliaPrivateKey) {
      throw new Error('SEPOLIA_PRIVATE_KEY is not configured');
    }
    const account = privateKeyToAccount(this.config.sepoliaPrivateKey);
    return {
      account,
      walletClient: createWalletClient({
        account,
        chain: sepolia,
        transport: http(this.config.sepoliaRpcUrl),
      }),
    };
  }

  private async ensureApproval(
    token: `0x${string}`,
    spender: `0x${string}`,
    amount: bigint,
  ): Promise<void> {
    const chainId = await this.publicClient.getChainId();
    assertAllowedErc20Approval(token, spender, chainId);
    const { account, walletClient } = this.getWalletClient();
    const allowance = await this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [account.address, spender],
    });
    if (allowance < amount) {
      // Bounded reusable approval (5x action amount) to conserve Sepolia gas across repeated demo runs
      const approveAmount = amount * 5n;
      const hash = await walletClient.writeContract({
        address: token,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [spender, approveAmount],
      });
      await this.publicClient.waitForTransactionReceipt({ hash });
      for (let i = 0; i < 6; i++) {
        const cur = await this.publicClient.readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [account.address, spender],
        });
        if (cur >= amount) break;
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  }

  async supply(params: {
    token: 'USDC' | 'DAI' | 'ETH' | 'EURS' | 'WBTC';
    amount: number;
    thresholds: UserThresholds;
  }): Promise<{ txHash: `0x${string}`; explorerUrl: string; before: AaveSnapshot; after: AaveSnapshot }> {
    const chainId = await this.publicClient.getChainId();
    assertSepoliaOnly(chainId);

    if (params.token === 'ETH') {
      assertWithinActionCaps({ amountEth: params.amount, thresholds: params.thresholds });
    } else if (params.token === 'WBTC') {
      assertWithinActionCaps({ amountUsd: params.amount * 100000, thresholds: params.thresholds });
    } else {
      assertWithinActionCaps({
        amountUsdc: params.amount,
        amountUsd: params.amount,
        thresholds: params.thresholds,
      });
    }

    const { account, walletClient } = this.getWalletClient();
    const before = await this.readSnapshot(account.address);

    let txHash: `0x${string}`;
    if (params.token === 'ETH') {
      assertAllowedEvmContract(AAVE_V3_SEPOLIA.wrappedTokenGatewayV3, chainId);
      const value = parseUnits(params.amount.toString(), 18);
      txHash = await walletClient.writeContract({
        address: AAVE_V3_SEPOLIA.wrappedTokenGatewayV3,
        abi: WETH_GATEWAY_ABI,
        functionName: 'depositETH',
        args: [AAVE_V3_SEPOLIA.pool, account.address, 0],
        value,
      });
    } else {
      const tok =
        params.token === 'USDC'
          ? SEPOLIA_TOKENS.AAVE_USDC
          : params.token === 'DAI'
            ? SEPOLIA_TOKENS.AAVE_DAI
            : params.token === 'EURS'
              ? SEPOLIA_TOKENS.AAVE_EURS
              : SEPOLIA_TOKENS.AAVE_WBTC;
      const amountRaw = parseUnits(params.amount.toString(), tok.decimals);
      await this.ensureApproval(tok.address, AAVE_V3_SEPOLIA.pool, amountRaw);
      assertAllowedEvmContract(AAVE_V3_SEPOLIA.pool, chainId);
      txHash = await walletClient.writeContract({
        address: AAVE_V3_SEPOLIA.pool,
        abi: AAVE_POOL_ABI,
        functionName: 'supply',
        args: [tok.address, amountRaw, account.address, 0],
      });
    }

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') {
      throw new Error(`Aave tx reverted: ${txHash}`);
    }
    await new Promise((r) => setTimeout(r, 2500));
    const after = await this.readSnapshot(account.address);
    return {
      txHash,
      explorerUrl: `https://sepolia.etherscan.io/tx/${txHash}`,
      before,
      after,
    };
  }

  async repay(params: {
    token: 'USDC' | 'DAI';
    amount: number;
    thresholds: UserThresholds;
  }): Promise<{ txHash: `0x${string}`; explorerUrl: string; before: AaveSnapshot; after: AaveSnapshot }> {
    const chainId = await this.publicClient.getChainId();
    assertAllowedEvmContract(AAVE_V3_SEPOLIA.pool, chainId);
    assertWithinActionCaps({
      amountUsdc: params.amount,
      amountUsd: params.amount,
      thresholds: params.thresholds,
    });

    const { account, walletClient } = this.getWalletClient();
    const before = await this.readSnapshot(account.address);
    const tok = params.token === 'USDC' ? SEPOLIA_TOKENS.AAVE_USDC : SEPOLIA_TOKENS.AAVE_DAI;
    const amountRaw = parseUnits(params.amount.toString(), tok.decimals);

    await this.ensureApproval(tok.address, AAVE_V3_SEPOLIA.pool, amountRaw);

    const txHash = await walletClient.writeContract({
      address: AAVE_V3_SEPOLIA.pool,
      abi: AAVE_POOL_ABI,
      functionName: 'repay',
      args: [tok.address, amountRaw, 2n, account.address],
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') {
      throw new Error(`Aave tx reverted: ${txHash}`);
    }
    await new Promise((r) => setTimeout(r, 2500));
    const after = await this.readSnapshot(account.address);
    return {
      txHash,
      explorerUrl: `https://sepolia.etherscan.io/tx/${txHash}`,
      before,
      after,
    };
  }

  async borrowForDemoSetup(params: {
    token: 'USDC' | 'DAI';
    amount: number;
  }): Promise<`0x${string}`> {
    const chainId = await this.publicClient.getChainId();
    assertAllowedEvmContract(AAVE_V3_SEPOLIA.pool, chainId);
    const { account, walletClient } = this.getWalletClient();
    const tok = params.token === 'USDC' ? SEPOLIA_TOKENS.AAVE_USDC : SEPOLIA_TOKENS.AAVE_DAI;
    const amountRaw = parseUnits(params.amount.toString(), tok.decimals);
    const txHash = await walletClient.writeContract({
      address: AAVE_V3_SEPOLIA.pool,
      abi: AAVE_POOL_ABI,
      functionName: 'borrow',
      args: [tok.address, amountRaw, 2n, 0, account.address],
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  async mintFromFaucet(params: {
    token: 'USDC' | 'DAI' | 'WBTC' | 'EURS';
    amount: number;
  }): Promise<`0x${string}`> {
    const chainId = await this.publicClient.getChainId();
    assertAllowedEvmContract(AAVE_V3_SEPOLIA.faucet, chainId);
    const { account, walletClient } = this.getWalletClient();
    const tok =
      params.token === 'USDC'
        ? SEPOLIA_TOKENS.AAVE_USDC
        : params.token === 'DAI'
          ? SEPOLIA_TOKENS.AAVE_DAI
          : params.token === 'EURS'
            ? SEPOLIA_TOKENS.AAVE_EURS
            : SEPOLIA_TOKENS.AAVE_WBTC;
    const amountRaw = parseUnits(params.amount.toString(), tok.decimals);
    const txHash = await walletClient.writeContract({
      address: AAVE_V3_SEPOLIA.faucet,
      abi: FAUCET_ABI,
      functionName: 'mint',
      args: [tok.address, account.address, amountRaw],
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }
}

export { SEPOLIA_CHAIN_ID };
