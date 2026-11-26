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

export type ProvenanceKind = 'recorded_testnet' | 'live_public' | 'sandbox_replay';

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
  updatedAt: number | null;
}

export interface JudgeStepMeta {
  id: JudgeStepId;
  number: number;
  label: string;
  shortTitle: string;
  track: string;
  provenance: ProvenanceKind;
  provenanceLabel: string;
  provenanceDetail: string;
  whatToTry: string;
  proofUrl?: string;
  proofLabel?: string;
}

export interface TelegramMessagePreview {
  recipient: 'Wearer' | 'Kit (Requester)';
  title: string;
  lines: string[];
  explorerUrl?: string;
  explorerLabel?: string;
}

export interface JudgeSnapshot {
  step: JudgeStepMeta;
  lensState: LensViewState;
  layout: LensPageLayout;
  validation: LensValidationResult;
  litChars: number;
  lensLineLength: number;
  resolvedSteps: JudgeStepId[];
  telegramMessages: TelegramMessagePreview[];
  lastActionNote: string;
}

/**
 * Fallback market prices captured from live public testnet/Coinbase endpoints so the
 * walkthrough renders immediately even before live browser fetches resolve or when offline.
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
  updatedAt: null,
};

/**
 * Every testnet execution proof recorded from ChainVision's real verification runs on PR #6
 * (commit 12871f3). No private keys or secrets exist in this static bundle.
 */
export const VERIFIED_PROOFS: readonly VerifiedProof[] = [
  {
    id: 'aave_repay',
    action: 'Aave v3 loan repay (5 USDC)',
    network: 'Ethereum Sepolia',
    recordedAt: '2026-11-25 06:28:36 UTC (block 12207803)',
    details: 'verify:testnet — Aave v3 Pool repay(USDC), status ok',
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
    details: 'verify:testnet — SwapRouter02 exactInputSingle, status ok',
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
    details: 'verify:testnet — Aave Sepolia test USDC transfer after glasses tap',
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
    details: 'sim:demo — KIT ASKS 20 USDC - TAP: PAY confirmed in evenhub-simulator',
    txOrOrderId: '0xc453a91d030307a604667169047689f8703f8cc98de4281c4a33fa5252d8178d',
    explorerUrl:
      'https://sepolia.etherscan.io/tx/0xc453a91d030307a604667169047689f8703f8cc98de4281c4a33fa5252d8178d',
    explorerLabel: 'Sepolia Etherscan',
  },
  {
    id: 'hl_trim',
    action: 'Hyperliquid ETH-PERP reduce-only trim (50%)',
    network: 'Hyperliquid Testnet',
    recordedAt: '2026-11-25 (sim:demo, PR #6)',
    details: 'Non-withdrawable EIP-712 source:"b" agent; ETH size 0.0363 -> 0.0182 (IOC)',
    txOrOrderId: '65942782652',
    explorerUrl: 'https://app.hyperliquid-testnet.xyz/explorer',
    explorerLabel: 'Hyperliquid Testnet Explorer',
  },
];

export const JUDGE_STEPS: readonly JudgeStepMeta[] = [
  {
    id: 'blank',
    number: 1,
    label: '1. Blank Lens',
    shortTitle: 'Blank until something needs you',
    track: 'Even G2 UX',
    provenance: 'live_public',
    provenanceLabel: 'LIVE SHARED RENDERER',
    provenanceDetail:
      'Rendered directly by @chainvision/shared renderLensPage({ mode: "idle" }). Zero lit characters keep G2 waveguides completely clear until a real threshold breaches or someone asks to be paid.',
    whatToTry:
      'Verify the 0/1000 char layout badge below, try Swipe Up to peek at live public prices, or click Next Step.',
  },
  {
    id: 'exchange_margin',
    number: 2,
    label: '2. Exchange Margin',
    shortTitle: 'Bybit low margin -> one-tap move',
    track: 'Track 03 · Exchanges',
    provenance: 'sandbox_replay',
    provenanceLabel: 'LIVE PUBLIC PRICES · SANDBOX TRANSFER REPLAY',
    provenanceDetail:
      'Bybit testnet and Coinbase BTC/ETH marks are fetched live from public endpoints. The signed Bybit V5 Funding -> Trading transfer is a recorded sandbox replay because no Bybit API keys live in this static page (and Bybit testnet keys are not yet provisioned).',
    whatToTry:
      'Click Single Tap (Confirm) to move 500 USDT from Funding to Trading within the 500/action & 1,500/24h cap, or Swipe Down to dismiss.',
  },
  {
    id: 'hl_liq',
    number: 3,
    label: '3. Hyperliquid Trim',
    shortTitle: 'Hyperliquid liq risk -> one-tap trim',
    track: 'Track 02 · Crypto & DeFi',
    provenance: 'recorded_testnet',
    provenanceLabel: 'RECORDED REAL TESTNET RUN + LIVE HL MARK',
    provenanceDetail:
      'ETH mark price streams live from Hyperliquid testnet /info (allMids). The one-tap reduce-only trim replays ChainVision’s real sim:demo testnet fill: order 65942782652 trimmed ETH-PERP from 0.0363 to 0.0182 via a non-withdrawable EIP-712 source:"b" agent.',
    whatToTry:
      'Click Single Tap (Confirm) to execute the 50% reduce-only trim and inspect the recorded Hyperliquid testnet order receipt.',
    proofUrl: 'https://app.hyperliquid-testnet.xyz/explorer',
    proofLabel: 'Hyperliquid Testnet Explorer (Order 65942782652)',
  },
  {
    id: 'telegram_request',
    number: 4,
    label: '4. Telegram /ask',
    shortTitle: 'Telegram money request -> tap to pay',
    track: 'Best Telegram Integration',
    provenance: 'recorded_testnet',
    provenanceLabel: 'RECORDED REAL SEPOLIA RUN',
    provenanceDetail:
      'Replays the real sim:demo Sepolia payout recorded on 2026-11-25 (block 12207816): Kit sent /ask 20 USDC, and one tap on the glasses transferred 20 Sepolia test USDC to Kit’s pre-approved address with receipts to both chats.',
    whatToTry:
      'Click Single Tap (Confirm) to pay 20 testnet USDC and open the Etherscan proof, or click Swipe Down to preview declining Kit politely.',
    proofUrl:
      'https://sepolia.etherscan.io/tx/0xc453a91d030307a604667169047689f8703f8cc98de4281c4a33fa5252d8178d',
    proofLabel: 'Sepolia Etherscan tx 0xc453a91d..d8178d',
  },
  {
    id: 'voice_brief',
    number: 5,
    label: '5. Voice Brief',
    shortTitle: '"What matters?" + two-venue voice check',
    track: 'Voice & Queue',
    provenance: 'live_public',
    provenanceLabel: 'LIVE SIGNAL QUEUE + LIVE PUBLIC FEEDS',
    provenanceDetail:
      'Ranks every unresolved signal with @chainvision/shared SignalQueue (money at risk soonest first, <= 3 lines, or NOTHING NEEDS YOU when clear). The bonus voice order card pulls live Binance Spot Testnet and Coinbase public BTC prices side by side.',
    whatToTry:
      'See the ranked brief, click "Voice: Buy 0.001 BTC" to inspect the live two-venue confirm card, or click "Reset Queue" to replay the full 60-second loop.',
  },
];

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
  // Two-minute mark drawdown moving toward liquidation (~1.5% / min -> ~4m ETA at 6.0% away).
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
    // Refresh live snapshots / active signal prices without losing receipts
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
        'Bybit Trading margin dropped below 250 USDT free. Single tap moves 500 USDT Funding -> Trading.';
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
      this.lastActionNote = `Hyperliquid ETH-PERP long is 6.0% from liquidation (live mark $${this.prices.hlEth.toFixed(1)}). Single tap trims 50% reduce-only.`;
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
        'Approved requester Kit sent /ask 20 USDC in Telegram. Single tap pays from the capped Sepolia wallet; swipe down declines.';
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
          id: 'rcpt_bybit_sandbox',
          actionId: action.id,
          protocol: 'bybit',
          actionType: 'bybit_transfer',
          network: 'bybit-testnet',
          summary: 'BYBIT MOVE 500 USDT FUNDING TO TRADING',
          beforeFact: 'TRADING FREE $182.40 · FUNDING 1200',
          afterFact: 'TRADING FREE $682.40 · FUNDING 700',
          txHashOrOrderId: 'sandbox-replay-no-key',
          explorerUrl: 'https://testnet.bybit.com',
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
            recipient: 'Wearer',
            title: 'ChainVision Sandbox Receipt (Bybit Testnet Replay)',
            lines: [
              'BYBIT MOVE 500 USDT FUNDING TO TRADING',
              'Before: TRADING FREE $182.40 · FUNDING 1200 USDT',
              'After: TRADING FREE $682.40 · FUNDING 700 USDT',
              'Caps enforced: 500/action · 1,500/24h (sandbox replay, no keys in browser)',
            ],
            explorerUrl: 'https://testnet.bybit.com',
            explorerLabel: 'Bybit Testnet',
          },
        ];
        this.lastActionNote =
          'Confirmed by single tap (sandbox replay — no Bybit key in static bundle). Telegram receipt posted.';
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
          summary: 'TRIM 50% ETH (REDUCE-ONLY IOC)',
          beforeFact: 'SZ 0.0363 ETH',
          afterFact: 'SZ 0.0182 ETH',
          txHashOrOrderId: '65942782652',
          explorerUrl: 'https://app.hyperliquid-testnet.xyz/explorer',
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
            recipient: 'Wearer',
            title: 'ChainVision Testnet Receipt (Recorded Real Run)',
            lines: [
              'Hyperliquid Testnet · Reduce-Only IOC Trim (50% ETH)',
              'Position size: 0.0363 -> 0.0182 ETH (non-withdrawable source:"b" agent)',
              'Order ID: 65942782652 (recorded from PR #6 sim:demo)',
            ],
            explorerUrl: 'https://app.hyperliquid-testnet.xyz/explorer',
            explorerLabel: 'Open Hyperliquid Testnet Explorer',
          },
        ];
        this.lastActionNote =
          'Confirmed by single tap: replays real Hyperliquid testnet reduce-only order 65942782652 (0.0363 -> 0.0182 ETH).';
        return this.snapshot();
      }

      if (action.actionType === 'usdc_payout') {
        this.resolved.add('telegram_request');
        const txHash = '0xc453a91d030307a604667169047689f8703f8cc98de4281c4a33fa5252d8178d';
        const explorerUrl = `https://sepolia.etherscan.io/tx/${txHash}`;
        const receipt: ExecutionReceipt = {
          id: 'rcpt_sepolia_usdc20',
          actionId: action.id,
          protocol: 'sepolia',
          actionType: 'usdc_payout',
          network: 'sepolia',
          summary: 'PAID 20 USDC TO KIT',
          beforeFact: 'WALLET 500.00 USDC',
          afterFact: 'WALLET 480.00 USDC',
          txHashOrOrderId: txHash,
          explorerUrl,
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
            recipient: 'Wearer',
            title: 'ChainVision Testnet Receipt (Recorded Real Sepolia Tx)',
            lines: [
              'PAID 20 USDC TO KIT (Sepolia test USDC 0x94a9..E4C8)',
              'Block 12207816 · 2026-11-25 06:31:24 UTC',
              `Tx: ${txHash}`,
            ],
            explorerUrl,
            explorerLabel: 'View on Sepolia Etherscan',
          },
          {
            recipient: 'Kit (Requester)',
            title: 'Payment Received from Wearer',
            lines: [
              'The wearer paid your request: 20 USDC on Sepolia testnet',
              'To: 0x1E570D5BAfE30Bd6a0980d3f786d7492E1D4Ce30',
              'Testnet only · Not financial advice',
            ],
            explorerUrl,
            explorerLabel: 'View on Sepolia Etherscan',
          },
        ];
        this.lastActionNote =
          'Confirmed by single tap: replays real Sepolia payout tx 0xc453a91d..d8178d (20 USDC to Kit) with dual Telegram receipts.';
        return this.snapshot();
      }
    }

    if (this.lensState.mode === 'confirm' && this.lensState.pendingAction?.actionType === 'binance_limit') {
      const a = this.lensState.pendingAction;
      const receipt: ExecutionReceipt = {
        id: 'rcpt_binance_sandbox',
        actionId: a.id,
        protocol: 'binance',
        actionType: 'binance_limit',
        network: 'binance-spot-testnet',
        summary: `BINANCE TESTNET LIMIT BUY ${a.params.qty} BTC @ ${a.params.price}`,
        beforeFact: 'FREE 1200 USDT',
        afterFact: 'ORDER NEW (SANDBOX REPLAY)',
        txHashOrOrderId: 'sandbox-replay-no-key',
        explorerUrl: 'https://testnet.binance.vision',
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
          recipient: 'Wearer',
          title: 'ChainVision Sandbox Receipt (Binance Spot Testnet)',
          lines: [
            receipt.summary,
            `Prices checked: ${a.comparisonLine ?? 'N/A'}`,
            'Sandbox replay: live public prices, no Binance API key in static page.',
          ],
          explorerUrl: 'https://testnet.binance.vision',
          explorerLabel: 'Binance Spot Testnet',
        },
      ];
      this.lastActionNote =
        'Two-venue voice limit order confirmed (sandbox replay with live Binance Testnet + Coinbase prices).';
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
      this.telegramMessages = [
        {
          recipient: 'Kit (Requester)',
          title: 'Request Declined',
          lines: [
            'The wearer declined your request for 20 USDC this time. No funds moved.',
          ],
        },
      ];
      this.lensState = {
        mode: 'idle',
        paired: true,
        pairingCode: '482915',
        snapshots: this.snapshots(),
      };
      this.lastActionNote = 'Swiped down: declined Kit’s 20 USDC request politely; lens returned to blank.';
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
    const names = ['Aave v3 Sepolia', 'Hyperliquid Testnet', 'Uniswap v3 Sepolia', 'Exchanges (Bybit / Binance / Coinbase)'];
    this.lastActionNote = `Swiped up: viewing live protocol snapshot ${nextIdx + 1}/4 (${names[nextIdx]}).`;
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
    this.lastActionNote = `Voice command "buy 0.001 BTC at ${action.params.price}": live two-venue check (${action.comparisonLine}). Tap confirms; swipe down cancels.`;
    return this.snapshot();
  }

  resetQueue(): JudgeSnapshot {
    this.resolved.clear();
    this.telegramMessages = [];
    this.positionIndex = 0;
    return this.selectStep('blank');
  }

  snapshot(): JudgeSnapshot {
    const layout = renderLensPage(this.lensState);
    const validation = validateLensLayout(layout);
    const step = JUDGE_STEPS.find((s) => s.id === this.stepId) ?? JUDGE_STEPS[0]!;
    const lensLineLength =
      this.lensState.mode === 'signal' && this.lensState.signal
        ? signalLensLine(this.lensState.signal).length
        : Math.max(0, ...layout.textObject.flatMap((c) => c.content.split('\n').map((l) => l.length)));

    return {
      step,
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
    if (snap.lensState.mode === 'signal' && snap.lensState.signal) {
      const line = signalLensLine(snap.lensState.signal);
      if (line.length > SIGNAL_LENS_LINE_MAX) {
        errors.push(`${label}: signal line exceeds ${SIGNAL_LENS_LINE_MAX} chars (${line.length})`);
      }
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
