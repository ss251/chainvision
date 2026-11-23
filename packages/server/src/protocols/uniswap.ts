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
import type { UniswapLpPosition, UniswapSnapshot, UserThresholds } from '@chainvision/shared';
import { type AppConfig, SEPOLIA_TOKENS, UNISWAP_V3_SEPOLIA } from '../config.js';
import {
  assertAllowedErc20Approval,
  assertAllowedEvmContract,
  assertWithinActionCaps,
} from '../safety/policy.js';

const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
]);

const QUOTER_V2_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

const SWAP_ROUTER_02_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);

const POSITION_MANAGER_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
]);

const FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
]);

const WETH9_ABI = parseAbi([
  'function deposit() payable',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
]);

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
]);

export interface SwapRoute {
  tokenInAddress: `0x${string}`;
  tokenOutAddress: `0x${string}`;
  inDecimals: number;
  outDecimals: number;
  fee: number;
  pairLabel: string;
  needsWethWrap: boolean;
}

export function resolveSepoliaSwapRoute(
  tokenIn: 'ETH' | 'WETH' | 'USDC' | 'DAI',
  tokenOut: 'ETH' | 'WETH' | 'USDC' | 'DAI',
): SwapRoute {
  if ((tokenIn === 'ETH' || tokenIn === 'WETH') && tokenOut === 'USDC') {
    return {
      tokenInAddress: SEPOLIA_TOKENS.WETH9.address,
      tokenOutAddress: SEPOLIA_TOKENS.CIRCLE_USDC.address,
      inDecimals: 18,
      outDecimals: 6,
      fee: 500,
      pairLabel: 'WETH/USDC',
      needsWethWrap: tokenIn === 'ETH',
    };
  }
  if (tokenIn === 'USDC' && (tokenOut === 'ETH' || tokenOut === 'WETH')) {
    return {
      tokenInAddress: SEPOLIA_TOKENS.CIRCLE_USDC.address,
      tokenOutAddress: SEPOLIA_TOKENS.WETH9.address,
      inDecimals: 6,
      outDecimals: 18,
      fee: 500,
      pairLabel: 'USDC/WETH',
      needsWethWrap: false,
    };
  }
  if (tokenIn === 'USDC' && tokenOut === 'DAI') {
    return {
      tokenInAddress: SEPOLIA_TOKENS.AAVE_USDC.address,
      tokenOutAddress: SEPOLIA_TOKENS.AAVE_DAI.address,
      inDecimals: 6,
      outDecimals: 18,
      fee: 500,
      pairLabel: 'USDC/DAI',
      needsWethWrap: false,
    };
  }
  if (tokenIn === 'DAI' && tokenOut === 'USDC') {
    return {
      tokenInAddress: SEPOLIA_TOKENS.AAVE_DAI.address,
      tokenOutAddress: SEPOLIA_TOKENS.AAVE_USDC.address,
      inDecimals: 18,
      outDecimals: 6,
      fee: 500,
      pairLabel: 'DAI/USDC',
      needsWethWrap: false,
    };
  }
  throw new Error(`Unsupported Sepolia swap route: ${tokenIn} -> ${tokenOut}`);
}

export class UniswapSepoliaClient {
  private readonly publicClient;
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.publicClient = createPublicClient({
      chain: sepolia,
      transport: http(config.sepoliaRpcUrl),
    });
  }

  async quoteSwap(
    tokenIn: 'ETH' | 'WETH' | 'USDC' | 'DAI',
    tokenOut: 'ETH' | 'WETH' | 'USDC' | 'DAI',
    amountIn: number,
  ): Promise<{ amountOut: number; amountOutRaw: bigint; route: SwapRoute }> {
    const route = resolveSepoliaSwapRoute(tokenIn, tokenOut);
    const amountInRaw = parseUnits(amountIn.toString(), route.inDecimals);
    const sim = await this.publicClient.simulateContract({
      address: UNISWAP_V3_SEPOLIA.quoterV2,
      abi: QUOTER_V2_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn: route.tokenInAddress,
          tokenOut: route.tokenOutAddress,
          amountIn: amountInRaw,
          fee: route.fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const amountOutRaw = sim.result[0];
    return {
      amountOut: Number(formatUnits(amountOutRaw, route.outDecimals)),
      amountOutRaw,
      route,
    };
  }

  async readSnapshot(overrideAddress?: `0x${string}`): Promise<UniswapSnapshot> {
    const address = overrideAddress ?? this.config.sepoliaAddress;
    try {
      const [slot0, ethQuote, usdcDaiQuote, nftBal] = await Promise.all([
        this.publicClient.readContract({
          address: UNISWAP_V3_SEPOLIA.pools.wethCircleUsdc500,
          abi: POOL_ABI,
          functionName: 'slot0',
        }),
        this.quoteSwap('WETH', 'USDC', 0.01).catch(() => ({ amountOut: 0 })),
        this.quoteSwap('USDC', 'DAI', 10).catch(() => ({ amountOut: 0 })),
        this.publicClient.readContract({
          address: UNISWAP_V3_SEPOLIA.positionManager,
          abi: POSITION_MANAGER_ABI,
          functionName: 'balanceOf',
          args: [address],
        }),
      ]);

      const currentTick = Number(slot0[1]);
      const lpPositions: UniswapLpPosition[] = [];
      const count = Math.min(Number(nftBal), 5);

      for (let i = 0; i < count; i++) {
        const tokenId = await this.publicClient.readContract({
          address: UNISWAP_V3_SEPOLIA.positionManager,
          abi: POSITION_MANAGER_ABI,
          functionName: 'tokenOfOwnerByIndex',
          args: [address, BigInt(i)],
        });
        const pos = await this.publicClient.readContract({
          address: UNISWAP_V3_SEPOLIA.positionManager,
          abi: POSITION_MANAGER_ABI,
          functionName: 'positions',
          args: [tokenId],
        });
        const liquidity = pos[7];
        if (liquidity === 0n) continue;
        const poolAddr = await this.publicClient.readContract({
          address: UNISWAP_V3_SEPOLIA.factory,
          abi: FACTORY_ABI,
          functionName: 'getPool',
          args: [pos[2], pos[3], pos[4]],
        });
        let poolTick = currentTick;
        if (poolAddr !== '0x0000000000000000000000000000000000000000') {
          const pSlot0 = await this.publicClient.readContract({
            address: poolAddr,
            abi: POOL_ABI,
            functionName: 'slot0',
          });
          poolTick = Number(pSlot0[1]);
        }
        const tickLower = Number(pos[5]);
        const tickUpper = Number(pos[6]);
        lpPositions.push({
          tokenId: tokenId.toString(),
          pair: `${pos[2].slice(0, 6)}/${pos[3].slice(0, 6)}`,
          feeTier: Number(pos[4]),
          tickLower,
          tickUpper,
          currentTick: poolTick,
          inRange: poolTick >= tickLower && poolTick <= tickUpper,
          liquidity: liquidity.toString(),
        });
      }

      return {
        network: 'sepolia',
        address,
        poolAddress: UNISWAP_V3_SEPOLIA.pools.wethCircleUsdc500,
        pair: 'WETH/USDC',
        feeTier: 500,
        currentTick,
        ethQuoteUsdc: ethQuote.amountOut * 100,
        usdcToDaiRate: usdcDaiQuote.amountOut / 10,
        lpPositions,
      };
    } catch (err) {
      return {
        network: 'sepolia',
        address,
        poolAddress: UNISWAP_V3_SEPOLIA.pools.wethCircleUsdc500,
        pair: 'WETH/USDC',
        feeTier: 500,
        currentTick: 0,
        ethQuoteUsdc: 0,
        usdcToDaiRate: 0,
        lpPositions: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async executeSwap(params: {
    tokenIn: 'ETH' | 'WETH' | 'USDC' | 'DAI';
    tokenOut: 'ETH' | 'WETH' | 'USDC' | 'DAI';
    amountIn: number;
    slippageBps?: number;
    thresholds: UserThresholds;
  }): Promise<{ txHash: `0x${string}`; explorerUrl: string; quotedOut: number; route: SwapRoute }> {
    if (!this.config.sepoliaPrivateKey) {
      throw new Error('SEPOLIA_PRIVATE_KEY is not configured');
    }
    const chainId = await this.publicClient.getChainId();
    assertAllowedEvmContract(UNISWAP_V3_SEPOLIA.swapRouter02, chainId);

    if (params.tokenIn === 'ETH' || params.tokenIn === 'WETH') {
      assertWithinActionCaps({ amountEth: params.amountIn, thresholds: params.thresholds });
    } else {
      assertWithinActionCaps({
        amountUsdc: params.amountIn,
        amountUsd: params.amountIn,
        thresholds: params.thresholds,
      });
    }

    const account = privateKeyToAccount(this.config.sepoliaPrivateKey);
    const walletClient = createWalletClient({
      account,
      chain: sepolia,
      transport: http(this.config.sepoliaRpcUrl),
    });

    const quote = await this.quoteSwap(params.tokenIn, params.tokenOut, params.amountIn);
    const amountInRaw = parseUnits(params.amountIn.toString(), quote.route.inDecimals);
    const slippageBps = params.slippageBps ?? 300; // 3% testnet default
    const amountOutMin = (quote.amountOutRaw * BigInt(10000 - slippageBps)) / 10000n;

    if (quote.route.needsWethWrap) {
      assertAllowedEvmContract(SEPOLIA_TOKENS.WETH9.address, chainId);
      const wrapHash = await walletClient.writeContract({
        address: SEPOLIA_TOKENS.WETH9.address,
        abi: WETH9_ABI,
        functionName: 'deposit',
        value: amountInRaw,
      });
      await this.publicClient.waitForTransactionReceipt({ hash: wrapHash });
    }

    assertAllowedErc20Approval(quote.route.tokenInAddress, UNISWAP_V3_SEPOLIA.swapRouter02, chainId);
    const allowance = await this.publicClient.readContract({
      address: quote.route.tokenInAddress,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [account.address, UNISWAP_V3_SEPOLIA.swapRouter02],
    });
    if (allowance < amountInRaw) {
      const approveAmount = amountInRaw * 5n;
      const approveHash = await walletClient.writeContract({
        address: quote.route.tokenInAddress,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [UNISWAP_V3_SEPOLIA.swapRouter02, approveAmount],
      });
      await this.publicClient.waitForTransactionReceipt({ hash: approveHash });
      // Wait briefly for load-balanced Sepolia RPC replicas to observe the new allowance
      for (let i = 0; i < 6; i++) {
        const cur = await this.publicClient.readContract({
          address: quote.route.tokenInAddress,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [account.address, UNISWAP_V3_SEPOLIA.swapRouter02],
        });
        if (cur >= amountInRaw) break;
        await new Promise((r) => setTimeout(r, 800));
      }
    }

    const txHash = await walletClient.writeContract({
      address: UNISWAP_V3_SEPOLIA.swapRouter02,
      abi: SWAP_ROUTER_02_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: quote.route.tokenInAddress,
          tokenOut: quote.route.tokenOutAddress,
          fee: quote.route.fee,
          recipient: account.address,
          amountIn: amountInRaw,
          amountOutMinimum: amountOutMin,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return {
      txHash,
      explorerUrl: `https://sepolia.etherscan.io/tx/${txHash}`,
      quotedOut: quote.amountOut,
      route: quote.route,
    };
  }
}
