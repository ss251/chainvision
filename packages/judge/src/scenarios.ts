import {
  BRIEF_MAX_LINES,
  EXCHANGE_CAPS,
  SIGNAL_LENS_LINE_MAX,
  SIGNAL_LINE_MAX,
  SignalQueue,
  estimateLiquidationEtaMinutes,
  fitSignalLine,
  formatLiqRiskLine,
  renderLensPage,
  signalLensLine,
  twoVenueLine,
  validateLensLayout,
  type ExecutionReceipt,
  type LensPageLayout,
  type LensValidationResult,
  type LensViewState,
  type PendingAction,
  type ProtocolSnapshots,
  type Signal,
} from '@chainvision/shared';

export type JudgeStepId =
  | 'blank'
  | 'exchange_margin'
  | 'hl_liq'
  | 'telegram_request'
  | 'voice_brief';

/**
 * The only three provenance labels used on the judge page:
 * - recorded: replayed from an executed ChainVision testnet run (always carries an explorer proof link)
 * - live: fetched directly from public read-only endpoints in this browser (always carries a fetch timestamp)
 * - example: scripted scenario or example action (no live keys or live position required)
 */
export type ProvenanceKind = 'recorded' | 'live' | 'example';

export const PROVENANCE_DEFINITIONS: Record<ProvenanceKind, { label: string; description: string }> = {
  recorded: {
    label: 'RECORDED FROM A REAL TESTNET RUN',
    description: 'Replayed from an executed ChainVision testnet run, with a direct link to its explorer transaction.',
  },
  live: {
    label: 'LIVE PUBLIC DATA',
    description: 'Fetched directly from public read-only endpoints in this browser, shown with its UTC timestamp.',
  },
  example: {
    label: 'EXAMPLE',
    description: 'Scripted scenario or example action showing how the lens and caps behave without keys or a live position.',
  },
};

export type FeedState = 'loading' | 'live' | 'unavailable';

export interface VerifiedProof {
  id: string;
  action: string;
  network: string;
  recordedAt: string;
  details: string;
  txOrOrderId: string;
  explorerUrl: string;
  explorerLabel: string;
}

export interface LiveMarketPrices {
  hlEth: number;
  hlBtc: number;
  bybitBtc: number;
  bybitEth: number;
  binanceBtc: number;
  binanceEth: number;
  coinbaseBtc: number;
  coinbaseEth: number;
  liveSources: string[];
  feedState: FeedState;
  updatedAt: number | null;
  fallbackRecordedAt: string;
}

export interface JudgeStepMeta {
  id: JudgeStepId;
  number: number;
  label: string;
  shortTitle: string;
  track: string;
  whatToTry: string;
}

export interface ActiveProvenance {
  kind: ProvenanceKind;
  badgeText: string;
  detail: string;
  proofUrl?: string;
  proofLabel?: string;
}

export interface TelegramMessagePreview {
  recipient: 'Wearer (Owner Chat)';
  title: string;
  lines: string[];
  explorerUrl?: string;
  explorerLabel?: string;
}

export interface JudgeSnapshot {
  step: JudgeStepMeta;
  provenance: ActiveProvenance;
  lensState: LensViewState;
  layout: LensPageLayout;
  validation: LensValidationResult;
  litChars: number;
  lensLineLength: number;
  resolvedSteps: JudgeStepId[];
  telegramMessages: TelegramMessagePreview[];
  lastActionNote: string;
}

export const HL_FILL_TX_HASH =
  '0x3be55891d105ce793d5f042ef3a61401040070776c08ed4bdfae03e49009a863';
export const HL_FILL_EXPLORER_URL =
  `https://app.hyperliquid-testnet.xyz/explorer/tx/${HL_FILL_TX_HASH}`;
export const SEPOLIA_PAYOUT_20_HASH =
  '0xc453a91d030307a604667169047689f8703f8cc98de4281c4a33fa5252d8178d';
export const SEPOLIA_PAYOUT_20_URL =
  `https://sepolia.etherscan.io/tx/${SEPOLIA_PAYOUT_20_HASH}`;

/**
 * Fallback market prices captured from public testnet/Coinbase endpoints so the
 * page still renders if public feeds are blocked or rate-limited.
 */
export const RECORDED_FALLBACK_PRICES: LiveMarketPrices = {
  hlEth: 1684.5,
  hlBtc: 60380.0,
  bybitBtc: 60000.0,
  bybitEth: 1685.2,
  binanceBtc: 60448.01,
  binanceEth: 1685.8,
  coinbaseBtc: 60370.08,
  coinbaseEth: 1683.8,
  liveSources: [],
  feedState: 'loading',
  updatedAt: null,
  fallbackRecordedAt: '2026-11-27 00:05 UTC',
};

/**
 * Real testnet transactions and fills from ChainVision's verification runs on PR #6 (commit 12871f3).
 * No private keys or secrets exist in this static bundle.
 */
export const VERIFIED_PROOFS: readonly VerifiedProof[] = [
  {
    id: 'aave_repay',
    action: 'Aave v3 loan repay (5 USDC)',
    network: 'Ethereum Sepolia',
    recordedAt: '2026-11-25 06:28:36 UTC (block 12207803)',
    details: 'verify:testnet — Aave v3 Pool repay(USDC), 4.923417 variable debt burned',
    txOrOrderId: '0x8b6b4210ac28750395a242f578369421183315906f18e2ab3ddf68e1f904ea0c',
    explorerUrl:
      'https://sepolia.etherscan.io/tx/0x8b6b4210ac28750395a242f578369421183315906f18e2ab3ddf68e1f904ea0c',
    explorerLabel: 'Sepolia Etherscan',
  },
  {
    id: 'uniswap_swap',
    action: 'Uniswap v3 swap (5 USDC -> 17.15 DAI)',
    network: 'Ethereum Sepolia',
    recordedAt: '2026-11-25 06:28:48 UTC (block 12207804)',
    details: 'verify:testnet — SwapRouter02 exactInputSingle, 5 USDC -> 17.1513 DAI',
    txOrOrderId: '0x784a80d485cf97a27b84909f4290871b4a9e009b19612de3cbdde151ba6b0578',
    explorerUrl:
      'https://sepolia.etherscan.io/tx/0x784a80d485cf97a27b84909f4290871b4a9e009b19612de3cbdde151ba6b0578',
    explorerLabel: 'Sepolia Etherscan',
  },
  {
    id: 'usdc_payout_verify',
    action: 'Telegram /ask payout (2 USDC to Kit)',
    network: 'Ethereum Sepolia',
    recordedAt: '2026-11-25 06:29:00 UTC (block 12207805)',
    details: 'verify:testnet — 2 Aave Sepolia test USDC transferred from 0x537B..fB0 to 0x1E57..Ce30',
    txOrOrderId: '0xa0dee5452b95d4fcfabeefb13947d8a1d25b10d067baea07608f219dde4b68be',
    explorerUrl:
      'https://sepolia.etherscan.io/tx/0xa0dee5452b95d4fcfabeefb13947d8a1d25b10d067baea07608f219dde4b68be',
    explorerLabel: 'Sepolia Etherscan',
  },
  {
    id: 'usdc_payout_demo',
    action: 'Telegram /ask payout (20 USDC to Kit)',
    network: 'Ethereum Sepolia',
    recordedAt: '2026-11-25 06:31:24 UTC (block 12207816)',
    details: 'sim:demo — dev-injected /ask 20 USDC in owner chat, tapped in simulator, 20 USDC to 0x1E57..Ce30',
    txOrOrderId: SEPOLIA_PAYOUT_20_HASH,
    explorerUrl: SEPOLIA_PAYOUT_20_URL,
    explorerLabel: 'Sepolia Etherscan',
  },
  {
    id: 'hl_trim',
    action: 'Hyperliquid ETH-PERP reduce-only IOC sell (0.0181 ETH @ $1,653.7)',
    network: 'Hyperliquid Testnet',
    recordedAt: '2026-11-25 06:31:07 UTC',
    details: 'sim:demo — order 65942782652, position 0.0363 -> 0.0182 ETH via non-withdrawable source:"b" agent',
    txOrOrderId: HL_FILL_TX_HASH,
    explorerUrl: HL_FILL_EXPLORER_URL,
    explorerLabel: 'Hyperliquid Testnet Explorer (tx)',
  },
];

export const JUDGE_STEPS: readonly JudgeStepMeta[] = [
  {
    id: 'blank',
    number: 1,
    label: '1. Blank Lens',
    shortTitle: 'Blank until something needs you',
    track: 'Even G2 UX',
    whatToTry:
      'Check the 0/1000 char validator bar below, click Swipe Up to peek at positions, or click Next Step.',
  },
  {
    id: 'exchange_margin',
    number: 2,
    label: '2. Exchange Margin',
    shortTitle: 'Bybit low margin -> one-tap move',
    track: 'Track 03 · Exchanges',
    whatToTry:
      'Click Single Tap (Confirm) to preview the 500 USDT Funding -> Trading action (example only), or Swipe Down to dismiss.',
  },
  {
    id: 'hl_liq',
    number: 3,
    label: '3. Hyperliquid Trim',
    shortTitle: 'Hyperliquid liq risk -> one-tap trim',
    track: 'Track 02 · Crypto & DeFi',
    whatToTry:
      'Inspect the example LIQ ~4m risk line, then click Single Tap (Confirm) to view the recorded real Hyperliquid testnet fill (order 65942782652).',
  },
  {
    id: 'telegram_request',
    number: 4,
    label: '4. Telegram /ask',
    shortTitle: 'Telegram money request -> tap to pay',
    track: 'Best Telegram Integration',
    whatToTry:
      'Click Single Tap (Confirm) to replay the recorded 20 USDC Sepolia payout and open the Etherscan tx, or Swipe Down for an example decline.',
  },
  {
    id: 'voice_brief',
    number: 5,
    label: '5. Voice Brief',
    shortTitle: '"What matters?" + two-venue voice check',
    track: 'Voice & Queue',
    whatToTry:
      'See the ranked brief, click "Voice: Buy 0.001 BTC" to inspect the two-venue Binance/Coinbase confirm card, or click "Reset Queue".',
  },
];

export function formatUtcTime(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19) + ' UTC';
}

/**
 * Validates both Even G2 platform limits (validateLensLayout) AND the 60-character per-line
 * ceiling across every rendered container so the judge page fails loudly if any line overflows.
 */
export function validateJudgeLensLayout(layout: LensPageLayout): LensValidationResult {
  const base = validateLensLayout(layout);
  const errors = [...base.errors];
  for (const c of layout.textObject) {
    for (const line of c.content.split('\n')) {
      if (line.length > SIGNAL_LENS_LINE_MAX) {
        errors.push(
          `Container ${c.containerName} line exceeds ${SIGNAL_LENS_LINE_MAX} chars (${line.length}/${SIGNAL_LENS_LINE_MAX})`,
        );
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function priceContextNote(prices: LiveMarketPrices, venueName: string, price: number): string {
  const formatted = price >= 1000 ? `$${price.toFixed(1)}` : `$${price.toFixed(2)}`;
  if (prices.feedState === 'live' && prices.liveSources.includes(venueName) && prices.updatedAt !== null) {
    return `${venueName} mark ${formatted} (live public data, ${formatUtcTime(prices.updatedAt)})`;
  }
  return `${venueName} mark ${formatted} (last recorded ${prices.fallbackRecordedAt}; live feed unavailable)`;
}

function buildSnapshots(prices: LiveMarketPrices, trimmedHl: boolean, movedBybit: boolean): ProtocolSnapshots {
  const hlSize = trimmedHl ? 0.0182 : 0.0363;
  const hlLiqPx = Number((prices.hlEth * 0.94).toFixed(1));
  return {
    updatedAt: prices.updatedAt ?? Date.now(),
    aave: {
      network: 'sepolia',
      address: '0x537B1ED6f937C1A27e7C6249026732565B381fB0',
      healthFactor: 1.54,
      totalCollateralUsd: 1620,
      totalDebtUsd: 820,
      availableBorrowsUsd: 420,
      currentLiquidationThresholdPct: 78,
      ltvPct: 73,
      usdcBalance: 480,
      daiBalance: 17.15,
      ethBalance: 0.42,
      rates: [
        {
          symbol: 'EURS',
          address: '0x6d906e526a4e2Ca02097BA9d0caA3c382F52278E',
          supplyApyPct: 3.4,
          borrowApyPct: 5.1,
        },
      ],
    },
    uniswap: {
      network: 'sepolia',
      address: '0x537B1ED6f937C1A27e7C6249026732565B381fB0',
      poolAddress: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E',
      pair: 'WETH/USDC',
      feeTier: 3000,
      currentTick: -201420,
      ethQuoteUsdc: prices.hlEth,
      usdcToDaiRate: 3.43,
      lpPositions: [],
    },
    hyperliquid: {
      network: 'hyperliquid-testnet',
      accountAddress: '0x0000000000000000000000000000000000000000',
      agentAddress: '0x0000000000000000000000000000000000000000',
      accountValueUsd: 96.4,
      marginUsedUsd: trimmedHl ? 6.1 : 12.2,
      ethMarkPx: prices.hlEth,
      btcMarkPx: prices.hlBtc,
      ethFundingPctHr: 0.0012,
      markPrices: { ETH: prices.hlEth, BTC: prices.hlBtc },
      positions: [
        {
          coin: 'ETH',
          side: 'LONG',
          size: hlSize,
          entryPx: Number((prices.hlEth * 1.012).toFixed(1)),
          markPx: prices.hlEth,
          liquidationPx: hlLiqPx,
          liqDistancePct: trimmedHl ? 12.1 : 6.0,
          unrealizedPnlUsd: -0.74,
          leverage: 5,
          notionalUsd: Number((hlSize * prices.hlEth).toFixed(2)),
        },
      ],
    },
    exchange: {
      venue: 'bybit-testnet',
      mode: 'public',
      ethMarkPx: prices.bybitEth,
      ethFundingPct: 0.01,
      equityUsd: movedBybit ? 1182.4 : 682.4,
      positions: [],
    },
    exchanges: {
      updatedAt: prices.updatedAt ?? Date.now(),
      bybit: {
        marks: { BTC: prices.bybitBtc, ETH: prices.bybitEth },
        signed: 'ok',
        account: {
          tradingEquityUsd: movedBybit ? 1182.4 : 682.4,
          tradingAvailableUsd: movedBybit ? 682.4 : 182.4,
          maintenanceMarginRate: movedBybit ? 0.14 : 0.38,
          fundingUsdt: movedBybit ? 700 : 1200,
        },
        positions: [
          {
            symbol: 'BTCUSDT',
            coin: 'BTC',
            side: 'LONG',
            size: 0.008,
            entryPx: Number((prices.bybitBtc * 1.008).toFixed(0)),
            markPx: prices.bybitBtc,
            liqPx: Number((prices.bybitBtc * 0.938).toFixed(0)),
            liqDistancePct: 6.2,
            notionalUsd: Number((0.008 * prices.bybitBtc).toFixed(2)),
            unrealizedPnlUsd: -3.84,
            leverage: 10,
            positionIdx: 0,
          },
        ],
      },
      binance: {
        prices: { BTC: prices.binanceBtc, ETH: prices.binanceEth },
        signed: 'skipped',
        balances: [],
        openOrders: [],
        recentFills: [],
      },
      coinbase: {
        prices: { BTC: prices.coinbaseBtc, ETH: prices.coinbaseEth },
      },
    },
  };
}

function makeExchangeMarginSignal(prices: LiveMarketPrices, now: number): Signal {
  const cap = EXCHANGE_CAPS.bybit_transfer;
  return {
    id: 'bybit:margin',
    source: 'exchange',
    kind: 'margin_low',
    severity: 'warning',
    line: fitSignalLine('BYBIT MARGIN LOW', SIGNAL_LINE_MAX),
    lossDistancePct: 6.2,
    usdAtRisk: 682.4,
    createdAt: now - 30_000,
    updatedAt: now,
    expiresAt: now + 300_000,
    action: {
      id: 'judge_bybit_move',
      source: 'watcher',
      protocol: 'bybit',
      actionType: 'bybit_transfer',
      headline: 'BYBIT TESTNET: MOVE 500 USDT FUNDING TO TRADING',
      factLine: `TRADING FREE $182.40 · MMR 38.0% · BTC $${prices.bybitBtc.toFixed(0)}`,
      comparisonLine: `CAP ${cap.perAction} USDT PER ACTION · ${cap.perDay} PER DAY`,
      actionPrompt: 'MOVE 500 USDT FUNDING TO TRADING',
      params: { tokenIn: 'USDT', amount: 500 },
      createdAt: now,
      expiresAt: now + 300_000,
      requiresTap: true,
    },
  };
}

function makeHyperliquidSignal(prices: LiveMarketPrices, now: number): Signal {
  const liqPx = prices.hlEth * 0.94;
  // Scripted 2-minute drawdown example (~1.5%/min -> ~4m ETA at 6.0% away).
  const etaMinutes = estimateLiquidationEtaMinutes({
    side: 'LONG',
    markPx: prices.hlEth,
    liqPx,
    samples: [
      { price: prices.hlEth * 1.03, at: now - 120_000 },
      { price: prices.hlEth, at: now },
    ],
    now,
  });
  return {
    id: 'hyperliquid:liq:ETH',
    source: 'hyperliquid',
    kind: 'liquidation_distance',
    severity: 'warning',
    line: formatLiqRiskLine({
      venue: 'HL',
      coin: 'ETH',
      side: 'LONG',
      liqDistancePct: 6.0,
      etaMinutes,
    }),
    lossDistancePct: 6.0,
    usdAtRisk: 12.2,
    createdAt: now - 20_000,
    updatedAt: now,
    expiresAt: now + 300_000,
    action: {
      id: 'judge_hl_trim',
      source: 'watcher',
      protocol: 'hyperliquid',
      actionType: 'hl_trim',
      headline: 'HL ETH-PERP LONG · LIQ ~4m (6.0% AWAY)',
      factLine: `LIMIT 10% · SZ 0.0363 · MARK $${prices.hlEth.toFixed(1)}`,
      comparisonLine: twoVenueLine('HL TESTNET', prices.hlEth, prices.coinbaseEth),
      actionPrompt: 'TRIM 50% ETH',
      params: { coin: 'ETH', amountPct: 50 },
      createdAt: now,
      expiresAt: now + 300_000,
      requiresTap: true,
    },
  };
}

function makeTelegramRequestSignal(now: number): Signal {
  return {
    id: 'request:rq_demo20',
    source: 'telegram',
    kind: 'money_request',
    severity: 'warning',
    line: fitSignalLine('KIT ASKS 20 USDC', SIGNAL_LINE_MAX),
    lossDistancePct: null,
    usdAtRisk: 20,
    createdAt: now - 10_000,
    updatedAt: now,
    expiresAt: now + 300_000,
    action: {
      id: 'judge_tg_pay',
      source: 'telegram',
      protocol: 'sepolia',
      actionType: 'usdc_payout',
      headline: 'KIT ASKS 20 USDC',
      factLine: 'TO 0x1E57..Ce30 (SEPOLIA) · APPROVED REQUESTER',
      comparisonLine: 'CAP 25 USDC PER REQUEST · 50 USDC PER 24H',
      actionPrompt: 'PAY',
      params: { to: '0x1E570D5BAfE30Bd6a0980d3f786d7492E1D4Ce30', amount: 20, requestId: 'rq_demo20' },
      createdAt: now,
      expiresAt: now + 300_000,
      requiresTap: true,
    },
  };
}

function makeBinanceVoiceCard(prices: LiveMarketPrices, now: number): PendingAction {
  const limitPrice = Math.max(1000, Math.round((prices.binanceBtc * 0.96) / 100) * 100);
  const notional = (0.001 * limitPrice).toFixed(2);
  return {
    id: 'judge_binance_limit',
    source: 'voice',
    protocol: 'binance',
    actionType: 'binance_limit',
    headline: `BINANCE TESTNET: LIMIT BUY 0.001 BTC @ ${limitPrice}`,
    factLine: `$${notional} · CAP $500 PER ACTION · $1500 PER 24H`,
    comparisonLine: twoVenueLine('BINANCE TESTNET', prices.binanceBtc, prices.coinbaseBtc),
    actionPrompt: 'BUY 0.001 BTC',
    params: { symbol: 'BTCUSDT', coin: 'BTC', side: 'buy', qty: 0.001, price: limitPrice },
    createdAt: now,
    expiresAt: now + 120_000,
    requiresTap: true,
  };
}

export class JudgeWalkthrough {
  private prices: LiveMarketPrices = { ...RECORDED_FALLBACK_PRICES };
  private stepId: JudgeStepId = 'blank';
  private lensState: LensViewState = { mode: 'idle', paired: true, pairingCode: '482915' };
  private resolved = new Set<JudgeStepId>();
  private telegramMessages: TelegramMessagePreview[] = [];
  private positionIndex = 0;
  private lastActionNote = 'Lens starts completely blank (0 lit pixels).';
  private readonly nowFn: () => number;

  constructor(nowFn: () => number = () => Date.now()) {
    this.nowFn = nowFn;
    this.selectStep('blank');
  }

  updatePrices(next: Partial<LiveMarketPrices>): JudgeSnapshot {
    this.prices = { ...this.prices, ...next };
    if (this.lensState.mode === 'signal' && this.stepId === 'exchange_margin') {
      this.lensState = {
        ...this.lensState,
        signal: makeExchangeMarginSignal(this.prices, this.nowFn()),
        snapshots: this.snapshots(),
      };
    } else if (this.lensState.mode === 'signal' && this.stepId === 'hl_liq') {
      this.lensState = {
        ...this.lensState,
        signal: makeHyperliquidSignal(this.prices, this.nowFn()),
        snapshots: this.snapshots(),
      };
      this.lastActionNote = `Example liquidation scenario using ${priceContextNote(this.prices, 'Hyperliquid Testnet', this.prices.hlEth)}. Tap to replay recorded order 65942782652.`;
    } else if (this.lensState.mode === 'confirm' && this.lensState.pendingAction?.actionType === 'binance_limit') {
      this.lensState = {
        ...this.lensState,
        pendingAction: makeBinanceVoiceCard(this.prices, this.nowFn()),
        snapshots: this.snapshots(),
      };
    } else if (this.lensState.mode === 'positions') {
      this.lensState = {
        ...this.lensState,
        snapshots: this.snapshots(),
      };
    }
    return this.snapshot();
  }

  getPrices(): LiveMarketPrices {
    return this.prices;
  }

  private snapshots(): ProtocolSnapshots {
    return buildSnapshots(
      this.prices,
      this.resolved.has('hl_liq'),
      this.resolved.has('exchange_margin'),
    );
  }

  private buildQueue(now: number): SignalQueue {
    const queue = new SignalQueue();
    if (!this.resolved.has('exchange_margin')) queue.upsert(makeExchangeMarginSignal(this.prices, now));
    if (!this.resolved.has('hl_liq')) queue.upsert(makeHyperliquidSignal(this.prices, now));
    if (!this.resolved.has('telegram_request')) queue.upsert(makeTelegramRequestSignal(now));
    return queue;
  }

  selectStep(id: JudgeStepId): JudgeSnapshot {
    const now = this.nowFn();
    this.stepId = id;
    const snapshots = this.snapshots();

    if (id === 'blank') {
      this.lensState = {
        mode: 'idle',
        paired: true,
        pairingCode: '482915',
        snapshots,
        queueSize: this.buildQueue(now).size,
      };
      this.lastActionNote = 'Idle state: 0 lit characters on the 576x288 Even G2 lens.';
    } else if (id === 'exchange_margin') {
      const sig = makeExchangeMarginSignal(this.prices, now);
      this.lensState = {
        mode: 'signal',
        paired: true,
        pairingCode: '482915',
        signal: sig,
        snapshots,
        queueSize: this.buildQueue(now).size,
      };
      this.lastActionNote =
        'Example Track 03 margin alert: single tap previews a 500 USDT Funding -> Trading move (no Bybit key in this page).';
    } else if (id === 'hl_liq') {
      const sig = makeHyperliquidSignal(this.prices, now);
      this.lensState = {
        mode: 'signal',
        paired: true,
        pairingCode: '482915',
        signal: sig,
        snapshots,
        queueSize: this.buildQueue(now).size,
      };
      this.lastActionNote = `Example liquidation scenario using ${priceContextNote(this.prices, 'Hyperliquid Testnet', this.prices.hlEth)}. Tap to replay recorded order 65942782652.`;
    } else if (id === 'telegram_request') {
      const sig = makeTelegramRequestSignal(now);
      this.lensState = {
        mode: 'signal',
        paired: true,
        pairingCode: '482915',
        signal: sig,
        snapshots,
        queueSize: this.buildQueue(now).size,
      };
      this.lastActionNote =
        'Recorded from sim:demo (block 12207816): dev-injected /ask 20 USDC in the owner chat. Single tap replays the real Sepolia payout; swipe down previews a decline.';
    } else {
      const queue = this.buildQueue(now);
      const ranked = queue.ranked(now).slice(0, BRIEF_MAX_LINES).map((s) => s.line);
      this.lensState = {
        mode: 'brief',
        paired: true,
        pairingCode: '482915',
        briefLines: ranked,
        snapshots,
        queueSize: queue.size,
      };
      this.lastActionNote = ranked.length
        ? `Voice "What matters?" ranked ${ranked.length} open item${ranked.length === 1 ? '' : 's'} by money at risk soonest first.`
        : 'All signals resolved: voice "What matters?" returns NOTHING NEEDS YOU.';
    }

    return this.snapshot();
  }

  nextStep(): JudgeSnapshot {
    const idx = JUDGE_STEPS.findIndex((s) => s.id === this.stepId);
    const next = JUDGE_STEPS[(idx + 1) % JUDGE_STEPS.length]!;
    return this.selectStep(next.id);
  }

  tap(): JudgeSnapshot {
    const now = this.nowFn();

    if (this.lensState.mode === 'idle') {
      return this.swipeUp();
    }

    if (this.lensState.mode === 'signal' && this.lensState.signal?.action) {
      const action = this.lensState.signal.action;
      if (action.actionType === 'bybit_transfer') {
        this.resolved.add('exchange_margin');
        const receipt: ExecutionReceipt = {
          id: 'rcpt_bybit_example',
          actionId: action.id,
          protocol: 'bybit',
          actionType: 'bybit_transfer',
          network: 'bybit-testnet',
          summary: 'BYBIT MOVE 500 USDT FUNDING TO TRADING',
          beforeFact: 'FREE $182 · FUND 1200',
          afterFact: 'FREE $682 · FUND 700',
          txHashOrOrderId: 'example-no-key',
          explorerUrl: 'https://testnet.bybit.com',
          telegramPosted: false,
          timestamp: now,
        };
        this.lensState = {
          mode: 'result',
          paired: true,
          pairingCode: '482915',
          lastReceipt: receipt,
          snapshots: this.snapshots(),
        };
        this.telegramMessages = [];
        this.lastActionNote =
          'Example action confirmed locally (no Bybit testnet key in this page; no Telegram message was sent).';
        return this.snapshot();
      }

      if (action.actionType === 'hl_trim') {
        this.resolved.add('hl_liq');
        const receipt: ExecutionReceipt = {
          id: 'rcpt_hl_65942782652',
          actionId: action.id,
          protocol: 'hyperliquid',
          actionType: 'hl_trim',
          network: 'hyperliquid-testnet',
          summary: 'TRIM 0.0181 ETH @ $1653.7 (IOC)',
          beforeFact: 'SZ 0.0363 ETH',
          afterFact: 'SZ 0.0182 ETH',
          txHashOrOrderId: '65942782652',
          explorerUrl: HL_FILL_EXPLORER_URL,
          telegramPosted: true,
          timestamp: now,
        };
        this.lensState = {
          mode: 'result',
          paired: true,
          pairingCode: '482915',
          lastReceipt: receipt,
          snapshots: this.snapshots(),
        };
        this.telegramMessages = [
          {
            recipient: 'Wearer (Owner Chat)',
            title: 'Recorded Testnet Receipt (sim:demo, 2026-11-25 06:31:07 UTC)',
            lines: [
              'Hyperliquid Testnet · Reduce-Only IOC sell 0.0181 ETH @ $1,653.7',
              'Position: 0.0363 -> 0.0182 ETH (non-withdrawable source:"b" agent)',
              `Order ID: 65942782652 · Tx: ${HL_FILL_TX_HASH}`,
            ],
            explorerUrl: HL_FILL_EXPLORER_URL,
            explorerLabel: 'Open Hyperliquid Testnet Fill Tx',
          },
        ];
        this.lastActionNote =
          'Replays recorded real Hyperliquid testnet fill: order 65942782652 sold 0.0181 ETH @ $1,653.7 (0.0363 -> 0.0182 ETH) on 2026-11-25 06:31:07 UTC.';
        return this.snapshot();
      }

      if (action.actionType === 'usdc_payout') {
        this.resolved.add('telegram_request');
        const receipt: ExecutionReceipt = {
          id: 'rcpt_sepolia_usdc20',
          actionId: action.id,
          protocol: 'sepolia',
          actionType: 'usdc_payout',
          network: 'sepolia',
          summary: 'PAID 20 USDC TO KIT',
          beforeFact: 'WALLET 500.00 USDC',
          afterFact: 'WALLET 480.00 USDC',
          txHashOrOrderId: SEPOLIA_PAYOUT_20_HASH,
          explorerUrl: SEPOLIA_PAYOUT_20_URL,
          telegramPosted: true,
          timestamp: now,
        };
        this.lensState = {
          mode: 'result',
          paired: true,
          pairingCode: '482915',
          lastReceipt: receipt,
          snapshots: this.snapshots(),
        };
        this.telegramMessages = [
          {
            recipient: 'Wearer (Owner Chat)',
            title: 'Recorded Testnet Receipt (sim:demo, single owner chat)',
            lines: [
              'PAID 20 USDC TO KIT (Sepolia test USDC 0x94a9..E4C8 -> 0x1E57..Ce30)',
              'Block 12207816 · 2026-11-25 06:31:24 UTC',
              `Tx: ${SEPOLIA_PAYOUT_20_HASH}`,
              'Note: sim:demo injected /ask into the owner chat; a second Telegram account enables two-chat delivery.',
            ],
            explorerUrl: SEPOLIA_PAYOUT_20_URL,
            explorerLabel: 'View on Sepolia Etherscan',
          },
        ];
        this.lastActionNote =
          'Replays recorded real Sepolia payout tx 0xc453a91d..d8178d (20 USDC to 0x1E57..Ce30, block 12207816).';
        return this.snapshot();
      }
    }

    if (this.lensState.mode === 'confirm' && this.lensState.pendingAction?.actionType === 'binance_limit') {
      const a = this.lensState.pendingAction;
      const receipt: ExecutionReceipt = {
        id: 'rcpt_binance_example',
        actionId: a.id,
        protocol: 'binance',
        actionType: 'binance_limit',
        network: 'binance-spot-testnet',
        summary: `BINANCE LIMIT BUY ${a.params.qty} BTC @ ${a.params.price}`,
        beforeFact: 'FREE 1200 USDT',
        afterFact: 'EXAMPLE ORDER (NO KEY)',
        txHashOrOrderId: 'example-no-key',
        explorerUrl: 'https://testnet.binance.vision',
        telegramPosted: false,
        timestamp: now,
      };
      this.lensState = {
        mode: 'result',
        paired: true,
        pairingCode: '482915',
        lastReceipt: receipt,
        snapshots: this.snapshots(),
      };
      this.telegramMessages = [];
      this.lastActionNote =
        'Example order confirmed locally (no Binance testnet key in this page; no Telegram message was sent).';
      return this.snapshot();
    }

    // Result, brief, notice, positions -> tap returns to blank idle
    this.lensState = {
      mode: 'idle',
      paired: true,
      pairingCode: '482915',
      snapshots: this.snapshots(),
    };
    this.lastActionNote = 'Returned to blank idle screen (0 lit pixels).';
    return this.snapshot();
  }

  swipeDown(): JudgeSnapshot {
    if (this.lensState.mode === 'signal' && this.stepId === 'telegram_request') {
      this.resolved.add('telegram_request');
      this.telegramMessages = [];
      this.lensState = {
        mode: 'idle',
        paired: true,
        pairingCode: '482915',
        snapshots: this.snapshots(),
      };
      this.lastActionNote =
        'Example swipe-down decline: Kit would be notified that no funds moved (no Telegram message sent in this static page).';
      return this.snapshot();
    }

    this.lensState = {
      mode: 'idle',
      paired: true,
      pairingCode: '482915',
      snapshots: this.snapshots(),
    };
    this.lastActionNote = 'Swiped down: dismissed card (15 min cooldown unless severity escalates) -> blank lens.';
    return this.snapshot();
  }

  swipeUp(): JudgeSnapshot {
    const nextIdx = this.lensState.mode === 'positions' ? (this.positionIndex + 1) % 4 : 0;
    this.positionIndex = nextIdx;
    this.lensState = {
      mode: 'positions',
      paired: true,
      pairingCode: '482915',
      snapshots: this.snapshots(),
      positionPageIndex: nextIdx,
    };
    const names = [
      'Aave v3 Sepolia',
      'Hyperliquid Testnet',
      'Uniswap v3 Sepolia',
      'Exchanges (Bybit / Binance / Coinbase)',
    ];
    this.lastActionNote = `Swiped up: viewing protocol snapshot ${nextIdx + 1}/4 (${names[nextIdx]}).`;
    return this.snapshot();
  }

  triggerVoiceBrief(): JudgeSnapshot {
    return this.selectStep('voice_brief');
  }

  triggerVoiceBinanceCard(): JudgeSnapshot {
    const now = this.nowFn();
    this.stepId = 'voice_brief';
    const action = makeBinanceVoiceCard(this.prices, now);
    this.lensState = {
      mode: 'confirm',
      paired: true,
      pairingCode: '482915',
      pendingAction: action,
      snapshots: this.snapshots(),
    };
    const pricesFresh =
      this.prices.feedState === 'live' &&
      this.prices.updatedAt !== null &&
      this.prices.liveSources.includes('Binance Testnet') &&
      this.prices.liveSources.includes('Coinbase Public');
    this.lastActionNote = pricesFresh
      ? `Voice command "buy 0.001 BTC at ${action.params.price}" with live public prices (${formatUtcTime(this.prices.updatedAt!)}): ${action.comparisonLine}.`
      : `Voice command "buy 0.001 BTC at ${action.params.price}" using last recorded public prices (${this.prices.fallbackRecordedAt}): ${action.comparisonLine}.`;
    return this.snapshot();
  }

  resetQueue(): JudgeSnapshot {
    this.resolved.clear();
    this.telegramMessages = [];
    this.positionIndex = 0;
    return this.selectStep('blank');
  }

  private resolveProvenance(): ActiveProvenance {
    const p = this.prices;
    const liveAt = p.feedState === 'live' && p.updatedAt !== null ? formatUtcTime(p.updatedAt) : null;

    if (this.lensState.mode === 'positions') {
      if (liveAt && p.liveSources.length > 0) {
        return {
          kind: 'live',
          badgeText: `${PROVENANCE_DEFINITIONS.live.label} · ${liveAt}`,
          detail: `Public mark prices fetched live (${p.liveSources.join(', ')}) at ${liveAt}; account balances shown are example testnet figures.`,
        };
      }
      return {
        kind: 'example',
        badgeText: PROVENANCE_DEFINITIONS.example.label,
        detail: `Example protocol snapshots using last recorded public prices (${p.fallbackRecordedAt}; live feeds unavailable).`,
      };
    }

    if (this.stepId === 'blank') {
      return {
        kind: 'example',
        badgeText: PROVENANCE_DEFINITIONS.example.label,
        detail:
          'Rendered directly by @chainvision/shared renderLensPage({ mode: "idle" }). Zero lit characters keep Even G2 waveguides clear until a risk threshold breaches or someone asks to be paid.',
      };
    }

    if (this.stepId === 'exchange_margin') {
      const priceNote = priceContextNote(p, 'Bybit Testnet', p.bybitBtc);
      return {
        kind: 'example',
        badgeText: PROVENANCE_DEFINITIONS.example.label,
        detail:
          `Example of the Track 03 margin alert and one-tap Funding -> Trading transfer (${priceNote}). No Bybit write has run yet; signed Bybit and Binance actions run on testnet once keys are supplied.`,
      };
    }

    if (this.stepId === 'hl_liq') {
      if (this.lensState.mode === 'result' && this.lensState.lastReceipt?.protocol === 'hyperliquid') {
        return {
          kind: 'recorded',
          badgeText: PROVENANCE_DEFINITIONS.recorded.label,
          detail:
            'Recorded from ChainVision’s 2026-11-25 06:31:07 UTC Hyperliquid testnet run (order 65942782652): reduce-only IOC sell of 0.0181 ETH at $1,653.7, moving ETH-PERP from 0.0363 to 0.0182 via a non-withdrawable source:"b" agent.',
          proofUrl: HL_FILL_EXPLORER_URL,
          proofLabel: 'Hyperliquid Testnet Explorer tx 0x3be55891..9a863 (Order 65942782652)',
        };
      }
      const priceNote = priceContextNote(p, 'Hyperliquid Testnet', p.hlEth);
      return {
        kind: 'example',
        badgeText: PROVENANCE_DEFINITIONS.example.label,
        detail:
          `Example liquidation risk line (6.0% distance and ~4m ETA come from scripted drawdown samples; the ETA has not run against a live position yet) shown alongside ${priceNote}. Tap to replay the recorded real Hyperliquid testnet fill (order 65942782652).`,
      };
    }

    if (this.stepId === 'telegram_request') {
      if (this.lensState.mode === 'idle') {
        return {
          kind: 'example',
          badgeText: PROVENANCE_DEFINITIONS.example.label,
          detail:
            'Example of swiping down to decline a money request without moving funds. Return to Step 4 to inspect the recorded 20 USDC Sepolia payout.',
        };
      }
      return {
        kind: 'recorded',
        badgeText: PROVENANCE_DEFINITIONS.recorded.label,
        detail:
          'Recorded from ChainVision’s 2026-11-25 sim:demo run (Sepolia block 12207816, 06:31:24 UTC). In that run, /ask 20 USDC was injected through /api/dev/telegram-update into the owner’s single Telegram chat, and one tap in evenhub-simulator transferred 20 Sepolia test USDC from 0x537B..fB0 to 0x1E57..Ce30. With a second Telegram account, both chats receive receipts.',
        proofUrl: SEPOLIA_PAYOUT_20_URL,
        proofLabel: 'Sepolia Etherscan tx 0xc453a91d..d8178d',
      };
    }

    // Step 5: voice_brief (brief or two-venue Binance voice confirm card)
    if (this.lensState.mode === 'confirm' && this.lensState.pendingAction?.actionType === 'binance_limit') {
      const bothLive =
        liveAt !== null &&
        p.liveSources.includes('Binance Testnet') &&
        p.liveSources.includes('Coinbase Public');
      if (bothLive) {
        return {
          kind: 'live',
          badgeText: `${PROVENANCE_DEFINITIONS.live.label} · ${liveAt}`,
          detail: `Two-venue confirm card built from live public Binance Spot Testnet and Coinbase BTC prices fetched at ${liveAt}. Tapping previews an example local receipt because no Binance API key is in this page.`,
        };
      }
      return {
        kind: 'example',
        badgeText: PROVENANCE_DEFINITIONS.example.label,
        detail: `Example two-venue confirm card using last recorded Binance Testnet and Coinbase BTC prices (${p.fallbackRecordedAt}; live feeds unavailable). Signed Binance limit orders run on testnet once keys are supplied.`,
      };
    }

    if (this.lensState.mode === 'result' && this.lensState.lastReceipt?.protocol === 'binance') {
      return {
        kind: 'example',
        badgeText: PROVENANCE_DEFINITIONS.example.label,
        detail:
          'Example local receipt for a Binance Spot Testnet voice limit order. No Binance write ran and no Telegram message was sent; signed Binance orders run on testnet once keys are supplied.',
      };
    }

    return {
      kind: 'example',
      badgeText: PROVENANCE_DEFINITIONS.example.label,
      detail:
        'Ranks remaining open queue items with @chainvision/shared SignalQueue (money at risk soonest first, <= 3 lines, or NOTHING NEEDS YOU when clear). Click "Voice: Buy 0.001 BTC" to compare Binance Spot Testnet and Coinbase prices.',
    };
  }

  snapshot(): JudgeSnapshot {
    const layout = renderLensPage(this.lensState);
    const validation = validateJudgeLensLayout(layout);
    const step = JUDGE_STEPS.find((s) => s.id === this.stepId) ?? JUDGE_STEPS[0]!;
    const provenance = this.resolveProvenance();
    const lensLineLength =
      this.lensState.mode === 'signal' && this.lensState.signal
        ? signalLensLine(this.lensState.signal).length
        : Math.max(0, ...layout.textObject.flatMap((c) => c.content.split('\n').map((l) => l.length)));

    return {
      step,
      provenance,
      lensState: this.lensState,
      layout,
      validation,
      litChars: layout.totalChars,
      lensLineLength,
      resolvedSteps: [...this.resolved],
      telegramMessages: [...this.telegramMessages],
      lastActionNote: this.lastActionNote,
    };
  }
}

export function validateAllJudgeSteps(prices: LiveMarketPrices = RECORDED_FALLBACK_PRICES): {
  valid: boolean;
  checkedStates: number;
  errors: string[];
} {
  const errors: string[] = [];
  let checkedStates = 0;
  const walk = new JudgeWalkthrough(() => 1_764_052_000_000);
  walk.updatePrices(prices);

  const check = (label: string, snap: JudgeSnapshot) => {
    checkedStates += 1;
    if (!snap.validation.valid) {
      errors.push(`${label}: ${snap.validation.errors.join('; ')}`);
    }
    if (snap.lensLineLength > SIGNAL_LENS_LINE_MAX) {
      errors.push(`${label}: max line exceeds ${SIGNAL_LENS_LINE_MAX} chars (${snap.lensLineLength})`);
    }
    if (snap.provenance.kind === 'recorded') {
      if (!snap.provenance.proofUrl || !snap.provenance.proofUrl.startsWith('https://')) {
        errors.push(`${label}: recorded state is missing a proofUrl`);
      } else if (/\/explorer\/?$/.test(snap.provenance.proofUrl)) {
        errors.push(`${label}: recorded state proofUrl points to explorer home page (${snap.provenance.proofUrl})`);
      }
    }
    if (snap.provenance.kind === 'example' && snap.lensState.mode === 'result' && snap.lensState.lastReceipt?.telegramPosted) {
      errors.push(`${label}: example receipt must not set telegramPosted=true`);
    }
  };

  for (const step of JUDGE_STEPS) {
    const before = walk.selectStep(step.id);
    check(`step:${step.id}:initial`, before);
    if (step.id === 'exchange_margin' || step.id === 'hl_liq' || step.id === 'telegram_request') {
      const after = walk.tap();
      check(`step:${step.id}:after_tap`, after);
    }
  }
  check('voice:binance_confirm', walk.triggerVoiceBinanceCard());
  check('voice:binance_after_tap', walk.tap());
  for (let i = 0; i < 4; i++) {
    check(`positions:${i}`, walk.swipeUp());
  }
  check('brief:after_all_resolved', walk.selectStep('voice_brief'));
  check('swipe_down:blank', walk.swipeDown());

  return { valid: errors.length === 0, checkedStates, errors };
}

export type { LensPageLayout, LensValidationResult };
