import type { ExchangeActionType, ExchangeDeskSnapshot } from './exchange.js';
import type { Signal } from './signal.js';

export type ProtocolName = 'aave' | 'uniswap' | 'hyperliquid' | 'exchange';

export interface AaveReserveRate {
  symbol: string;
  address: string;
  supplyApyPct: number;
  borrowApyPct: number;
  supplyCapReached?: boolean;
}

export interface AaveSnapshot {
  network: 'sepolia';
  address: string;
  healthFactor: number | null; // null when zero debt
  totalCollateralUsd: number;
  totalDebtUsd: number;
  availableBorrowsUsd: number;
  currentLiquidationThresholdPct: number;
  ltvPct: number;
  usdcBalance: number;
  daiBalance: number;
  eursBalance?: number;
  ethBalance: number;
  rates: AaveReserveRate[];
  error?: string;
}

export interface UniswapLpPosition {
  tokenId: string;
  pair: string;
  feeTier: number;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  inRange: boolean;
  liquidity: string;
}

export interface UniswapSnapshot {
  network: 'sepolia';
  address: string;
  poolAddress: string;
  pair: string;
  feeTier: number;
  currentTick: number;
  ethQuoteUsdc: number; // output USDC for 1 WETH (or scaled from 0.01 WETH)
  usdcToDaiRate: number; // output DAI for 1 AaveUSDC
  lpPositions: UniswapLpPosition[];
  error?: string;
}

export interface HyperliquidPosition {
  coin: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPx: number;
  markPx: number;
  liquidationPx: number | null;
  liqDistancePct: number | null;
  unrealizedPnlUsd: number;
  leverage: number;
  notionalUsd: number;
}

export interface HyperliquidSnapshot {
  network: 'hyperliquid-testnet';
  accountAddress: string;
  agentAddress: string;
  accountValueUsd: number;
  marginUsedUsd: number;
  ethMarkPx: number;
  btcMarkPx: number;
  ethFundingPctHr: number;
  /** Testnet mark prices by coin (ETH, BTC, SOL when listed). */
  markPrices?: Record<string, number>;
  positions: HyperliquidPosition[];
  error?: string;
}

export interface ExchangePosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPx: number;
  markPx: number;
  unrealizedPnlUsd: number;
  liqDistancePct: number | null;
}

export interface ExchangeSnapshot {
  venue: 'bybit-testnet' | 'binance-testnet';
  mode: 'authenticated' | 'public';
  ethMarkPx: number;
  ethFundingPct: number;
  equityUsd: number | null;
  positions: ExchangePosition[];
  error?: string;
}

export interface ProtocolSnapshots {
  updatedAt: number;
  aave: AaveSnapshot;
  uniswap: UniswapSnapshot;
  hyperliquid: HyperliquidSnapshot;
  exchange: ExchangeSnapshot;
  /** Bybit and Binance testnet accounts and Coinbase public prices. */
  exchanges?: ExchangeDeskSnapshot;
}

export interface UserThresholds {
  aaveMinHealthFactor: number;
  aaveDefaultRepayUsdc: number;
  uniswapAlertOutOfRange: boolean;
  hlMinLiqDistancePct: number;
  hlDefaultTrimPct: number;
  exchangeMinLiqDistancePct: number;
  maxSingleActionUsd: number;
  maxEvmSwapEth: number;
  maxUsdcAction: number;
}

export const DEFAULT_THRESHOLDS: UserThresholds = {
  aaveMinHealthFactor: 1.35,
  aaveDefaultRepayUsdc: 300,
  uniswapAlertOutOfRange: true,
  hlMinLiqDistancePct: 10,
  hlDefaultTrimPct: 50,
  exchangeMinLiqDistancePct: 10,
  maxSingleActionUsd: 1000,
  maxEvmSwapEth: 0.25,
  maxUsdcAction: 500,
};

export type ExecutableActionType =
  | ExchangeActionType
  | 'aave_repay'
  | 'aave_supply'
  | 'uniswap_swap'
  | 'hl_trim';

export interface PendingAction {
  id: string;
  source: 'watcher' | 'voice';
  protocol: 'aave' | 'uniswap' | 'hyperliquid' | 'bybit' | 'binance';
  actionType: ExecutableActionType;
  headline: string;
  factLine: string;
  comparisonLine?: string;
  actionPrompt: string;
  params: {
    symbol?: string;
    side?: 'buy' | 'sell';
    qty?: number;
    price?: number;
    tokenIn?: string;
    tokenOut?: string;
    amount?: number;
    amountPct?: number;
    coin?: string;
    slippageBps?: number;
    feeTier?: number;
  };
  createdAt: number;
  expiresAt: number;
  requiresTap: true;
}

export interface ExecutionReceipt {
  id: string;
  actionId: string;
  protocol: 'aave' | 'uniswap' | 'hyperliquid' | 'bybit' | 'binance';
  actionType: ExecutableActionType;
  network: 'sepolia' | 'hyperliquid-testnet' | 'bybit-testnet' | 'binance-spot-testnet';
  summary: string;
  beforeFact: string;
  afterFact: string;
  txHashOrOrderId: string;
  explorerUrl: string;
  telegramPosted: boolean;
  timestamp: number;
}

export type LensMode =
  | 'idle'
  | 'alert'
  | 'signal'
  | 'brief'
  | 'notice'
  | 'confirm'
  | 'voice_listening'
  | 'executing'
  | 'result'
  | 'positions'
  | 'error';

export interface LensViewState {
  mode: LensMode;
  paired: boolean;
  pairingCode?: string;
  pendingAction?: PendingAction | null;
  signal?: Signal | null;
  queueSize?: number;
  briefLines?: string[];
  noticeText?: string;
  lastReceipt?: ExecutionReceipt | null;
  snapshots?: ProtocolSnapshots | null;
  positionPageIndex?: number;
  voiceTranscript?: string;
  errorMessage?: string;
}

export interface PairingSession {
  code: string;
  walletAddress: string | null;
  telegramChatId: string | null;
  thresholds: UserThresholds;
  pairedAt: number | null;
}

export type WsServerMessage =
  | { type: 'state'; state: LensViewState; session: PairingSession }
  | { type: 'signal'; signal: Signal }
  | { type: 'confirm'; action: PendingAction }
  | { type: 'executing'; actionId: string; label: string }
  | { type: 'receipt'; receipt: ExecutionReceipt }
  | { type: 'error'; message: string };

export type WsClientMessage =
  | { type: 'register'; code?: string }
  | { type: 'tap_confirm'; actionId: string }
  | { type: 'dismiss'; actionId?: string }
  | { type: 'cycle_view' }
  | { type: 'request_sync' };
