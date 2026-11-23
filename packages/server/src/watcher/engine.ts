import crypto from 'node:crypto';
import {
  DEFAULT_THRESHOLDS,
  type ExecutionReceipt,
  type LensViewState,
  type PairingSession,
  type PendingAction,
  type ProtocolSnapshots,
  type UserThresholds,
  type VoiceIntent,
  type WsServerMessage,
} from '@chainvision/shared';
import type { AppConfig } from '../config.js';
import { AaveSepoliaClient } from '../protocols/aave.js';
import { ExchangeTestnetWatcher } from '../protocols/exchange.js';
import { HyperliquidTestnetClient } from '../protocols/hyperliquid.js';
import { UniswapSepoliaClient } from '../protocols/uniswap.js';
import { TelegramBotService } from '../telegram/bot.js';
import { type IntentParseResult, VoiceIntentService } from '../voice/openrouter.js';
import { WhisperSttService } from '../voice/stt.js';

function randomPairCode(): string {
  return String(crypto.randomInt(100000, 999999));
}

export class ChainVisionEngine {
  readonly config: AppConfig;
  readonly aave: AaveSepoliaClient;
  readonly uniswap: UniswapSepoliaClient;
  readonly hyperliquid: HyperliquidTestnetClient;
  readonly exchange: ExchangeTestnetWatcher;
  readonly stt: WhisperSttService;
  readonly intents: VoiceIntentService;
  readonly telegram: TelegramBotService;

  private session: PairingSession;
  private snapshots: ProtocolSnapshots | null = null;
  private pendingAction: PendingAction | null = null;
  private lastReceipt: ExecutionReceipt | null = null;
  private viewMode: LensViewState['mode'] = 'idle';
  private positionPageIndex = 0;
  private errorMessage: string | undefined;
  private snoozedUntil = new Map<string, number>();
  private listeners = new Set<(msg: WsServerMessage) => void>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AppConfig) {
    this.config = config;
    this.aave = new AaveSepoliaClient(config);
    this.uniswap = new UniswapSepoliaClient(config);
    this.hyperliquid = new HyperliquidTestnetClient(config);
    this.exchange = new ExchangeTestnetWatcher(config);
    this.stt = new WhisperSttService(config);
    this.intents = new VoiceIntentService(config);
    this.telegram = new TelegramBotService(config);

    this.session = {
      code: randomPairCode(),
      walletAddress: config.sepoliaAddress,
      telegramChatId: config.telegramChatId,
      thresholds: { ...DEFAULT_THRESHOLDS },
      pairedAt: null,
    };
  }

  subscribe(listener: (msg: WsServerMessage) => void): () => void {
    this.listeners.add(listener);
    listener({ type: 'state', state: this.getLensState(), session: this.session });
    return () => {
      this.listeners.delete(listener);
    };
  }

  private broadcast(msg: WsServerMessage): void {
    for (const l of this.listeners) {
      try {
        l(msg);
      } catch {
        // ignore dropped socket
      }
    }
  }

  getSession(): PairingSession {
    return this.session;
  }

  getSnapshots(): ProtocolSnapshots | null {
    return this.snapshots;
  }

  getPendingAction(): PendingAction | null {
    if (this.pendingAction && Date.now() > this.pendingAction.expiresAt) {
      this.pendingAction = null;
      if (this.viewMode === 'alert' || this.viewMode === 'confirm') {
        this.viewMode = 'idle';
      }
    }
    return this.pendingAction;
  }

  getLastReceipt(): ExecutionReceipt | null {
    return this.lastReceipt;
  }

  getLensState(): LensViewState {
    const pending = this.getPendingAction();
    return {
      mode: this.viewMode,
      paired: Boolean(this.session.pairedAt),
      pairingCode: this.session.code,
      pendingAction: pending,
      lastReceipt: this.lastReceipt,
      snapshots: this.snapshots,
      positionPageIndex: this.positionPageIndex,
      errorMessage: this.errorMessage,
    };
  }

  pairFromMiniApp(params: {
    code?: string;
    walletAddress?: string;
    telegramChatId?: string;
    thresholds?: Partial<UserThresholds>;
  }): { ok: boolean; session: PairingSession; message: string } {
    if (params.code && params.code.trim() !== this.session.code) {
      return {
        ok: false,
        session: this.session,
        message: `Pairing code mismatch. Current glasses code is ${this.session.code}.`,
      };
    }
    if (params.walletAddress && /^0x[0-9a-fA-F]{40}$/.test(params.walletAddress)) {
      this.session.walletAddress = params.walletAddress;
    }
    if (params.telegramChatId) {
      this.session.telegramChatId = params.telegramChatId;
      this.telegram.setChatId(params.telegramChatId);
    }
    if (params.thresholds) {
      this.updateThresholds(params.thresholds);
    }
    this.session.pairedAt = Date.now();
    this.broadcast({ type: 'state', state: this.getLensState(), session: this.session });
    return {
      ok: true,
      session: this.session,
      message: `Paired ChainVision glasses (${this.session.code}) on testnet.`,
    };
  }

  updateThresholds(patch: Partial<UserThresholds>): UserThresholds {
    const t = this.session.thresholds;
    const clamp = (v: number | undefined, min: number, max: number, fallback: number) => {
      if (v === undefined || !Number.isFinite(v)) return fallback;
      return Math.min(max, Math.max(min, v));
    };

    this.session.thresholds = {
      aaveMinHealthFactor: clamp(patch.aaveMinHealthFactor, 1.05, 5.0, t.aaveMinHealthFactor),
      aaveDefaultRepayUsdc: clamp(patch.aaveDefaultRepayUsdc, 1, 500, t.aaveDefaultRepayUsdc),
      uniswapAlertOutOfRange:
        patch.uniswapAlertOutOfRange !== undefined
          ? Boolean(patch.uniswapAlertOutOfRange)
          : t.uniswapAlertOutOfRange,
      hlMinLiqDistancePct: clamp(patch.hlMinLiqDistancePct, 1, 50, t.hlMinLiqDistancePct),
      hlDefaultTrimPct: clamp(patch.hlDefaultTrimPct, 10, 100, t.hlDefaultTrimPct),
      exchangeMinLiqDistancePct: clamp(
        patch.exchangeMinLiqDistancePct,
        1,
        50,
        t.exchangeMinLiqDistancePct,
      ),
      maxSingleActionUsd: clamp(patch.maxSingleActionUsd, 10, 2000, t.maxSingleActionUsd),
      maxEvmSwapEth: clamp(patch.maxEvmSwapEth, 0.001, 0.5, t.maxEvmSwapEth),
      maxUsdcAction: clamp(patch.maxUsdcAction, 1, 1000, t.maxUsdcAction),
    };
    this.broadcast({ type: 'state', state: this.getLensState(), session: this.session });
    return this.session.thresholds;
  }

  start(): void {
    void this.pollNow();
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => {
        void this.pollNow();
      }, this.config.pollIntervalMs);
    }
    this.telegram.startPolling({
      onPairCode: (code, chatId) => {
        const res = this.pairFromMiniApp({ code, telegramChatId: chatId });
        return { ok: res.ok, message: res.message };
      },
      onStatusRequest: async () => this.pollNow(),
      onGetLastReceipt: () => this.lastReceipt,
    });
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.telegram.stopPolling();
  }

  async pollNow(): Promise<ProtocolSnapshots> {
    const watchAddr = (this.session.walletAddress ?? this.config.sepoliaAddress) as `0x${string}`;
    const [aave, uniswap, hyperliquid, exchange] = await Promise.all([
      this.aave.readSnapshot(watchAddr),
      this.uniswap.readSnapshot(watchAddr),
      this.hyperliquid.readSnapshot(),
      this.exchange.readSnapshot(),
    ]);

    this.snapshots = {
      updatedAt: Date.now(),
      aave,
      uniswap,
      hyperliquid,
      exchange,
    };

    // Only auto-raise watcher alerts if no pending confirm/executing card is active
    if (!this.getPendingAction() && this.viewMode !== 'executing' && this.viewMode !== 'voice_listening') {
      const alert = this.evaluateThresholds(this.snapshots);
      if (alert) {
        this.pendingAction = alert;
        this.viewMode = 'alert';
        this.broadcast({ type: 'alert', action: alert });
      }
    }

    this.broadcast({ type: 'state', state: this.getLensState(), session: this.session });
    return this.snapshots;
  }

  evaluateThresholds(s: ProtocolSnapshots): PendingAction | null {
    const now = Date.now();
    const th = this.session.thresholds;

    // 1. Aave health factor below user threshold
    if (
      s.aave.healthFactor !== null &&
      s.aave.totalDebtUsd > 0 &&
      s.aave.healthFactor < th.aaveMinHealthFactor
    ) {
      const snoozeUntil = this.snoozedUntil.get('aave_repay') ?? 0;
      if (now >= snoozeUntil) {
        const repayAmt = Math.min(
          th.aaveDefaultRepayUsdc,
          th.maxUsdcAction,
          Math.max(1, Math.ceil(s.aave.totalDebtUsd * 0.5)),
        );
        return {
          id: `act_${crypto.randomBytes(4).toString('hex')}`,
          source: 'watcher',
          protocol: 'aave',
          actionType: 'aave_repay',
          headline: `AAVE LOAN THRESHOLD · HEALTH ${s.aave.healthFactor.toFixed(2)}`,
          factLine: `LIMIT ${th.aaveMinHealthFactor.toFixed(2)} · DEBT $${s.aave.totalDebtUsd.toFixed(0)} · COLLAT $${s.aave.totalCollateralUsd.toFixed(0)}`,
          actionPrompt: `REPAY ${repayAmt} USDC`,
          params: { tokenIn: 'USDC', amount: repayAmt },
          createdAt: now,
          expiresAt: now + 120_000,
          requiresTap: true,
        };
      }
    }

    // 2. Hyperliquid liquidation distance below user threshold
    for (const pos of s.hyperliquid.positions) {
      if (pos.liqDistancePct !== null && pos.liqDistancePct < th.hlMinLiqDistancePct) {
        const key = `hl_trim_${pos.coin}`;
        if (now >= (this.snoozedUntil.get(key) ?? 0)) {
          return {
            id: `act_${crypto.randomBytes(4).toString('hex')}`,
            source: 'watcher',
            protocol: 'hyperliquid',
            actionType: 'hl_trim',
            headline: `HL ${pos.coin}-PERP ${pos.side} · LIQ ${pos.liqDistancePct.toFixed(1)}% AWAY`,
            factLine: `LIMIT ${th.hlMinLiqDistancePct}% · SZ ${pos.size} · MARK $${pos.markPx.toFixed(1)}`,
            actionPrompt: `TRIM ${th.hlDefaultTrimPct}% ${pos.coin}`,
            params: { coin: pos.coin, amountPct: th.hlDefaultTrimPct },
            createdAt: now,
            expiresAt: now + 120_000,
            requiresTap: true,
          };
        }
      }
    }

    // 3. Uniswap LP out-of-range check
    if (th.uniswapAlertOutOfRange) {
      const oor = s.uniswap.lpPositions.find((p) => !p.inRange);
      if (oor && now >= (this.snoozedUntil.get(`uni_oor_${oor.tokenId}`) ?? 0)) {
        return {
          id: `act_${crypto.randomBytes(4).toString('hex')}`,
          source: 'watcher',
          protocol: 'uniswap',
          actionType: 'uniswap_swap',
          headline: `UNISWAP LP #${oor.tokenId} OUT OF RANGE`,
          factLine: `TICK ${oor.currentTick} OUTSIDE [${oor.tickLower}, ${oor.tickUpper}]`,
          actionPrompt: `SWAP 10 USDC->DAI`,
          params: { tokenIn: 'USDC', tokenOut: 'DAI', amount: 10 },
          createdAt: now,
          expiresAt: now + 120_000,
          requiresTap: true,
        };
      }
    }

    return null;
  }

  async handleVoiceTranscript(
    transcript: string,
  ): Promise<{ parse: IntentParseResult; pendingAction: PendingAction | null }> {
    const parse = await this.intents.parseTranscript(transcript);
    const snap = this.snapshots ?? (await this.pollNow());
    const pendingAction = await this.buildActionFromIntent(parse.intent, snap);

    if (parse.intent.action === 'status') {
      this.viewMode = 'positions';
      this.positionPageIndex =
        parse.intent.protocol === 'hyperliquid'
          ? 1
          : parse.intent.protocol === 'uniswap'
            ? 2
            : parse.intent.protocol === 'exchange'
              ? 3
              : 0;
      this.broadcast({ type: 'state', state: this.getLensState(), session: this.session });
      return { parse, pendingAction: null };
    }

    if (!pendingAction) {
      this.errorMessage =
        parse.intent.action === 'unsupported'
          ? parse.intent.reason
          : 'Could not prepare testnet action from voice command';
      this.viewMode = 'error';
      this.broadcast({ type: 'error', message: this.errorMessage });
      this.broadcast({ type: 'state', state: this.getLensState(), session: this.session });
      return { parse, pendingAction: null };
    }

    this.errorMessage = undefined;
    this.pendingAction = pendingAction;
    this.viewMode = 'confirm';
    this.broadcast({ type: 'confirm', action: pendingAction });
    this.broadcast({ type: 'state', state: this.getLensState(), session: this.session });
    return { parse, pendingAction };
  }

  async buildActionFromIntent(
    intent: VoiceIntent,
    snap: ProtocolSnapshots,
  ): Promise<PendingAction | null> {
    const now = Date.now();
    const th = this.session.thresholds;

    if (intent.action === 'aave_supply') {
      const capped = Math.min(intent.amount, intent.token === 'ETH' ? th.maxEvmSwapEth : th.maxUsdcAction);
      const aaveRate =
        snap.aave.rates.find((r) => r.symbol === (intent.token === 'ETH' ? 'WETH' : intent.token))
          ?.supplyApyPct ?? 0;
      const exFunding = snap.exchange.ethFundingPct;
      return {
        id: `act_${crypto.randomBytes(4).toString('hex')}`,
        source: 'voice',
        protocol: 'aave',
        actionType: 'aave_supply',
        headline: `AAVE SUPPLY ${capped} ${intent.token} (SEPOLIA)`,
        factLine: `AAVE APY ${aaveRate.toFixed(2)}% · UNI FEE 0.05% · EX FUND ${exFunding.toFixed(3)}%`,
        comparisonLine: `CAP ${th.maxUsdcAction} USDC · NON-CUSTODIAL`,
        actionPrompt: `SUPPLY ${capped} ${intent.token}`,
        params: { tokenIn: intent.token, amount: capped },
        createdAt: now,
        expiresAt: now + 90_000,
        requiresTap: true,
      };
    }

    if (intent.action === 'aave_repay') {
      const capped = Math.min(intent.amount, th.maxUsdcAction);
      const hfStr = snap.aave.healthFactor === null ? 'NO DEBT' : snap.aave.healthFactor.toFixed(2);
      return {
        id: `act_${crypto.randomBytes(4).toString('hex')}`,
        source: 'voice',
        protocol: 'aave',
        actionType: 'aave_repay',
        headline: `AAVE REPAY ${capped} ${intent.token} (SEPOLIA)`,
        factLine: `CURRENT HEALTH ${hfStr} · DEBT $${snap.aave.totalDebtUsd.toFixed(1)}`,
        actionPrompt: `REPAY ${capped} ${intent.token}`,
        params: { tokenIn: intent.token, amount: capped },
        createdAt: now,
        expiresAt: now + 90_000,
        requiresTap: true,
      };
    }

    if (intent.action === 'uniswap_swap') {
      let amountIn = intent.amount;
      if (amountIn === undefined && intent.amountPct !== undefined) {
        const bal =
          intent.tokenIn === 'ETH' || intent.tokenIn === 'WETH'
            ? Math.max(0, snap.aave.ethBalance - 0.01) // keep gas reserve
            : intent.tokenIn === 'USDC'
              ? snap.aave.usdcBalance
              : snap.aave.daiBalance;
        amountIn = Number(((bal * intent.amountPct) / 100).toFixed(5));
      }
      if (!amountIn || amountIn <= 0) {
        return null;
      }
      const maxCap = intent.tokenIn === 'ETH' || intent.tokenIn === 'WETH' ? th.maxEvmSwapEth : th.maxUsdcAction;
      const cappedIn = Math.min(amountIn, maxCap);
      let quoteOut = 0;
      try {
        const q = await this.uniswap.quoteSwap(intent.tokenIn, intent.tokenOut, cappedIn);
        quoteOut = q.amountOut;
      } catch {
        quoteOut = 0;
      }
      return {
        id: `act_${crypto.randomBytes(4).toString('hex')}`,
        source: 'voice',
        protocol: 'uniswap',
        actionType: 'uniswap_swap',
        headline: `UNISWAP ${cappedIn} ${intent.tokenIn} -> ${intent.tokenOut}`,
        factLine: `UNI QUOTE: ${quoteOut.toFixed(4)} ${intent.tokenOut} · HL ETH $${snap.hyperliquid.ethMarkPx.toFixed(0)}`,
        comparisonLine: `SLIPPAGE 3% MAX · SEPOLIA ROUTER02`,
        actionPrompt: `SWAP ${cappedIn} ${intent.tokenIn}`,
        params: {
          tokenIn: intent.tokenIn,
          tokenOut: intent.tokenOut,
          amount: cappedIn,
          slippageBps: 300,
        },
        createdAt: now,
        expiresAt: now + 90_000,
        requiresTap: true,
      };
    }

    if (intent.action === 'hl_trim') {
      const pos = snap.hyperliquid.positions.find((p) => p.coin === intent.coin);
      const factLine = pos
        ? `${pos.side} ${pos.size} ${pos.coin} · MARK $${pos.markPx.toFixed(1)} · LIQ ${pos.liqDistancePct !== null ? pos.liqDistancePct.toFixed(1) + '%' : 'N/A'}`
        : `MARK $${snap.hyperliquid.ethMarkPx.toFixed(1)} · REDUCE-ONLY AGENT`;
      return {
        id: `act_${crypto.randomBytes(4).toString('hex')}`,
        source: 'voice',
        protocol: 'hyperliquid',
        actionType: 'hl_trim',
        headline: `HYPERLIQUID TRIM ${intent.amountPct}% ${intent.coin} PERP`,
        factLine,
        comparisonLine: `REDUCE-ONLY IOC · NON-WITHDRAWABLE AGENT`,
        actionPrompt: `TRIM ${intent.amountPct}% ${intent.coin}`,
        params: { coin: intent.coin, amountPct: intent.amountPct },
        createdAt: now,
        expiresAt: now + 90_000,
        requiresTap: true,
      };
    }

    return null;
  }

  /**
   * Executes a pending action ONLY after explicit tap confirmation from the glasses.
   */
  async confirmPendingAction(actionId: string): Promise<ExecutionReceipt> {
    const action = this.getPendingAction();
    if (!action || action.id !== actionId) {
      throw new Error('No matching pending action to confirm (expired or cancelled)');
    }

    this.viewMode = 'executing';
    this.broadcast({ type: 'executing', actionId: action.id, label: action.actionPrompt });
    this.broadcast({ type: 'state', state: this.getLensState(), session: this.session });

    const th = this.session.thresholds;
    let receipt: ExecutionReceipt;

    try {
      if (action.actionType === 'aave_repay') {
        const token = (action.params.tokenIn === 'DAI' ? 'DAI' : 'USDC') as 'USDC' | 'DAI';
        const amount = action.params.amount ?? th.aaveDefaultRepayUsdc;
        const res = await this.aave.repay({ token, amount, thresholds: th });
        const beforeHf = res.before.healthFactor !== null ? `HF ${res.before.healthFactor.toFixed(2)}` : 'NO DEBT';
        const afterHf = res.after.healthFactor !== null ? `HF ${res.after.healthFactor.toFixed(2)}` : 'DEBT CLEARED';
        receipt = {
          id: `rcpt_${crypto.randomBytes(4).toString('hex')}`,
          actionId: action.id,
          protocol: 'aave',
          actionType: 'aave_repay',
          network: 'sepolia',
          summary: `AAVE REPAY ${amount} ${token}`,
          beforeFact: beforeHf,
          afterFact: afterHf,
          txHashOrOrderId: res.txHash,
          explorerUrl: res.explorerUrl,
          telegramPosted: false,
          timestamp: Date.now(),
        };
      } else if (action.actionType === 'aave_supply') {
        const token = (action.params.tokenIn ?? 'USDC') as 'USDC' | 'DAI' | 'ETH';
        const amount = action.params.amount ?? 10;
        const res = await this.aave.supply({ token, amount, thresholds: th });
        receipt = {
          id: `rcpt_${crypto.randomBytes(4).toString('hex')}`,
          actionId: action.id,
          protocol: 'aave',
          actionType: 'aave_supply',
          network: 'sepolia',
          summary: `AAVE SUPPLY ${amount} ${token}`,
          beforeFact: `COLLAT $${res.before.totalCollateralUsd.toFixed(1)}`,
          afterFact: `COLLAT $${res.after.totalCollateralUsd.toFixed(1)}`,
          txHashOrOrderId: res.txHash,
          explorerUrl: res.explorerUrl,
          telegramPosted: false,
          timestamp: Date.now(),
        };
      } else if (action.actionType === 'uniswap_swap') {
        const tokenIn = (action.params.tokenIn ?? 'ETH') as 'ETH' | 'WETH' | 'USDC' | 'DAI';
        const tokenOut = (action.params.tokenOut ?? 'USDC') as 'ETH' | 'WETH' | 'USDC' | 'DAI';
        const amountIn = action.params.amount ?? 0.005;
        const res = await this.uniswap.executeSwap({
          tokenIn,
          tokenOut,
          amountIn,
          slippageBps: action.params.slippageBps ?? 300,
          thresholds: th,
        });
        receipt = {
          id: `rcpt_${crypto.randomBytes(4).toString('hex')}`,
          actionId: action.id,
          protocol: 'uniswap',
          actionType: 'uniswap_swap',
          network: 'sepolia',
          summary: `UNI SWAP ${amountIn} ${tokenIn} -> ${tokenOut}`,
          beforeFact: `IN ${amountIn} ${tokenIn}`,
          afterFact: `EST ${res.quotedOut.toFixed(4)} ${tokenOut}`,
          txHashOrOrderId: res.txHash,
          explorerUrl: res.explorerUrl,
          telegramPosted: false,
          timestamp: Date.now(),
        };
      } else {
        const coin = action.params.coin ?? 'ETH';
        const amountPct = action.params.amountPct ?? th.hlDefaultTrimPct;
        const res = await this.hyperliquid.trimPosition({ coin, amountPct, thresholds: th });
        const bPos = res.before.positions.find((p) => p.coin === coin);
        const aPos = res.after.positions.find((p) => p.coin === coin);
        receipt = {
          id: `rcpt_${crypto.randomBytes(4).toString('hex')}`,
          actionId: action.id,
          protocol: 'hyperliquid',
          actionType: 'hl_trim',
          network: 'hyperliquid-testnet',
          summary: `HL TRIM ${amountPct}% ${coin}`,
          beforeFact: `SZ ${bPos?.size ?? 0}`,
          afterFact: `SZ ${aPos?.size ?? 0}`,
          txHashOrOrderId: res.orderId,
          explorerUrl: res.explorerUrl,
          telegramPosted: false,
          timestamp: Date.now(),
        };
      }

      const tg = await this.telegram.sendReceipt(receipt, this.session.telegramChatId);
      receipt.telegramPosted = tg.sent;

      this.pendingAction = null;
      this.lastReceipt = receipt;
      this.viewMode = 'result';
      await this.pollNow();
      this.broadcast({ type: 'receipt', receipt });
      this.broadcast({ type: 'state', state: this.getLensState(), session: this.session });
      return receipt;
    } catch (err) {
      this.pendingAction = null;
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.viewMode = 'error';
      this.broadcast({ type: 'error', message: this.errorMessage });
      this.broadcast({ type: 'state', state: this.getLensState(), session: this.session });
      throw err;
    }
  }

  dismissToBlank(actionId?: string): void {
    const active = this.pendingAction;
    if (active && (!actionId || active.id === actionId)) {
      if (active.source === 'watcher') {
        const key =
          active.actionType === 'hl_trim'
            ? `hl_trim_${active.params.coin ?? 'ETH'}`
            : active.actionType;
        this.snoozedUntil.set(key, Date.now() + 15 * 60_000);
      }
      this.pendingAction = null;
    }
    this.errorMessage = undefined;
    this.viewMode = 'idle';
    this.broadcast({ type: 'state', state: this.getLensState(), session: this.session });
  }

  cyclePositionView(): void {
    if (this.viewMode === 'positions') {
      this.positionPageIndex = (this.positionPageIndex + 1) % 4;
    } else {
      this.viewMode = 'positions';
      this.positionPageIndex = 0;
    }
    this.broadcast({ type: 'state', state: this.getLensState(), session: this.session });
  }
}
