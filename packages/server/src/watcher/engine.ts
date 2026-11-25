import crypto from 'node:crypto';
import {
  BRIEF_MAX_LINES,
  BRIEF_SHOW_MS,
  DEFAULT_THRESHOLDS,
  NOTICE_SHOW_MS,
  SIGNAL_LENS_LINE_MAX,
  SIGNAL_LINE_MAX,
  SIGNAL_RESHOW_MS,
  SIGNAL_SHOW_MS,
  SignalQueue,
  checkNewRule,
  checkPayout,
  formatUsdc,
  isOpen,
  parseAskAmount,
  requestSignal,
  shortAddress,
  describeRule,
  fitSignalLine,
  priceAlertSignal,
  rankSignals,
  ruleCrossed,
  type AlertAsset,
  type AlertDirection,
  type ExecutionReceipt,
  type LensMode,
  type LensViewState,
  type MoneyRequest,
  type RequestResolution,
  type PairingSession,
  type PendingAction,
  type PriceAlertRule,
  type ProtocolSnapshots,
  type Signal,
  type SignalSeverity,
  type SignalSource,
  type UserThresholds,
  type VoiceIntent,
  type WsServerMessage,
} from '@chainvision/shared';
import type { AppConfig } from '../config.js';
import { AaveSepoliaClient } from '../protocols/aave.js';
import { ExchangeTestnetWatcher } from '../protocols/exchange.js';
import { HyperliquidTestnetClient } from '../protocols/hyperliquid.js';
import { UniswapSepoliaClient } from '../protocols/uniswap.js';
import { SepoliaPayoutClient } from '../protocols/payout.js';
import { RequestBook } from '../requests/book.js';
import { StateStore } from '../store.js';
import {
  TelegramBotService,
  formatReceiptText,
  type BotReply,
  type CallbackContext,
  type CallbackReply,
  type CommandContext,
  type TelegramBotHandlers,
} from '../telegram/bot.js';
import { type IntentParseResult, VoiceIntentService } from '../voice/openrouter.js';
import { WhisperSttService } from '../voice/stt.js';

function randomPairCode(): string {
  return String(crypto.randomInt(100000, 999999));
}

function newActionId(): string {
  return `act_${crypto.randomBytes(4).toString('hex')}`;
}

type Overlay = Exclude<LensMode, 'idle' | 'signal' | 'alert'>;

const OVERLAY_AUTO_BLANK_MS: Partial<Record<Overlay, number>> = {
  brief: BRIEF_SHOW_MS,
  notice: NOTICE_SHOW_MS,
  result: SIGNAL_SHOW_MS,
  error: SIGNAL_SHOW_MS,
};

type WatcherSource = Exclude<SignalSource, 'price_alert' | 'telegram'>;

export type AlertResult = { ok: true; rule: PriceAlertRule } | { ok: false; reason: string };

export interface EngineOptions {
  /** JSON file that keeps alert rules, requesters, requests and payouts across restarts; omitted means memory only. */
  stateFile?: string | null;
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
  readonly queue = new SignalQueue();
  readonly payout: SepoliaPayoutClient;
  readonly requests: RequestBook;

  private readonly store: StateStore;
  private session: PairingSession;
  private snapshots: ProtocolSnapshots | null = null;
  private latestPrices: Record<string, number> = {};
  private alertRules: PriceAlertRule[];
  private pendingAction: PendingAction | null = null;
  private lastReceipt: ExecutionReceipt | null = null;
  private overlay: Overlay | null = null;
  private overlaySince = 0;
  private shown: { id: string; since: number } | null = null;
  private briefLines: string[] = [];
  private noticeText: string | undefined;
  private positionPageIndex = 0;
  private errorMessage: string | undefined;
  private lastPublishedKey = '';
  private listeners = new Set<(msg: WsServerMessage) => void>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private glassesOnline = 0;
  private readonly paying = new Set<string>();

  constructor(config: AppConfig, options: EngineOptions = {}) {
    this.config = config;
    this.aave = new AaveSepoliaClient(config);
    this.uniswap = new UniswapSepoliaClient(config);
    this.hyperliquid = new HyperliquidTestnetClient(config);
    this.exchange = new ExchangeTestnetWatcher(config);
    this.stt = new WhisperSttService(config);
    this.intents = new VoiceIntentService(config);
    this.telegram = new TelegramBotService(config);
    this.payout = new SepoliaPayoutClient(config);
    this.store = new StateStore(options.stateFile ?? null);
    const stored = this.store.load();
    this.alertRules = stored.alertRules;
    this.requests = new RequestBook(
      { requesters: stored.requesters, requests: stored.requests, payouts: stored.payouts },
      () => this.saveState(),
    );

    this.session = {
      code: randomPairCode(),
      walletAddress: config.sepoliaAddress,
      telegramChatId: config.telegramChatId,
      thresholds: { ...DEFAULT_THRESHOLDS },
      pairedAt: null,
    };

    const now = Date.now();
    for (const request of this.requests.open(now)) {
      const requester = this.requests.requester(request.requesterId);
      if (requester) this.queue.upsert(requestSignal(request, requester, newActionId(), now));
    }
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

  private publish(now = Date.now()): void {
    const state = this.getLensState(now);
    this.lastPublishedKey = this.lensKey(state);
    this.broadcast({ type: 'state', state, session: this.session });
  }

  private lensKey(state: LensViewState): string {
    return JSON.stringify([
      state.mode,
      state.signal?.id,
      state.signal?.line,
      state.signal?.action?.actionPrompt,
      state.briefLines,
      state.noticeText,
      state.pendingAction?.id,
      state.lastReceipt?.id,
      state.errorMessage,
      state.positionPageIndex,
    ]);
  }

  private setOverlay(mode: Overlay | null, now = Date.now()): void {
    this.overlay = mode;
    this.overlaySince = now;
    if (mode !== null) this.shown = null;
  }

  getSession(): PairingSession {
    return this.session;
  }

  getSnapshots(): ProtocolSnapshots | null {
    return this.snapshots;
  }

  getPendingAction(now = Date.now()): PendingAction | null {
    if (this.pendingAction && now > this.pendingAction.expiresAt) {
      this.pendingAction = null;
      if (this.overlay === 'confirm') this.setOverlay(null, now);
    }
    return this.pendingAction;
  }

  getLastReceipt(): ExecutionReceipt | null {
    return this.lastReceipt;
  }

  getLensState(now = Date.now()): LensViewState {
    const pending = this.getPendingAction(now);
    const top = this.overlay ? null : this.queue.top(now);
    return {
      mode: this.overlay ?? (top ? 'signal' : 'idle'),
      paired: Boolean(this.session.pairedAt),
      pairingCode: this.session.code,
      pendingAction: pending,
      signal: top,
      queueSize: this.queue.ranked(now).length,
      briefLines: this.overlay === 'brief' ? this.briefLines : undefined,
      noticeText: this.overlay === 'notice' ? this.noticeText : undefined,
      lastReceipt: this.lastReceipt,
      snapshots: this.snapshots,
      positionPageIndex: this.positionPageIndex,
      errorMessage: this.errorMessage,
    };
  }

  /**
   * Housekeeping run every second: expire signals and cards, blank a line that has been
   * shown untouched for SIGNAL_SHOW_MS, and publish only when the lens actually changes.
   */
  tick(now = Date.now()): void {
    this.queue.prune(now);
    this.getPendingAction(now);
    for (const expired of this.requests.expire(now)) {
      this.queue.remove(`request:${expired.id}`);
      void this.tellRequester(expired, 'expired', `Your request for ${formatUsdc(expired.amount)} USDC expired before the wearer answered. No funds moved.`);
    }
    const limit = this.overlay ? OVERLAY_AUTO_BLANK_MS[this.overlay] : undefined;
    if (this.overlay && limit !== undefined && now - this.overlaySince >= limit) {
      this.setOverlay(null, now);
      this.errorMessage = undefined;
    }
    if (!this.overlay) {
      const top = this.queue.top(now);
      if (!top) {
        this.shown = null;
      } else if (this.shown?.id !== top.id) {
        this.shown = { id: top.id, since: now };
      } else if (now - this.shown.since >= SIGNAL_SHOW_MS) {
        this.queue.hide(this.queue.visible(now).map((s) => s.id), now + SIGNAL_RESHOW_MS);
        this.shown = null;
      }
    }
    const state = this.getLensState(now);
    if (this.lensKey(state) !== this.lastPublishedKey) {
      this.lastPublishedKey = this.lensKey(state);
      this.broadcast({ type: 'state', state, session: this.session });
    }
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
      maxRequestUsdc: clamp(patch.maxRequestUsdc, 1, 100, t.maxRequestUsdc),
      dailyRequestUsdc: clamp(patch.dailyRequestUsdc, 1, 200, t.dailyRequestUsdc),
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
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => this.tick(), 1000);
    }
    this.telegram.startPolling(this.botHandlers());
  }

  botHandlers(): TelegramBotHandlers {
    return {
      onPairCode: (code, chatId) => {
        const res = this.pairFromMiniApp({ code, telegramChatId: chatId });
        return { ok: res.ok, message: res.message };
      },
      onStatusRequest: async () => this.pollNow(),
      onGetLastReceipt: () => this.lastReceipt,
      onRegister: (ctx) => this.handleRegister(ctx),
      onAsk: (ctx) => this.handleAsk(ctx),
      onCallback: (ctx) => this.handleRequestCallback(ctx),
    };
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
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
    this.applySnapshots(this.snapshots, Date.now());
    this.tick();
    this.publish();
    return this.snapshots;
  }

  /** Feed one round of watcher reads into the queue and check price alerts. */
  applySnapshots(s: ProtocolSnapshots, now = Date.now()): Signal[] {
    const bySource = this.watcherSignals(s, now);
    for (const source of Object.keys(bySource) as WatcherSource[]) {
      const signals = bySource[source];
      if (signals) this.queue.replaceSource(source, signals);
    }
    const prices: Record<string, number> = { ...(s.hyperliquid.markPrices ?? {}) };
    if (!prices.ETH && !s.exchange.error && s.exchange.ethMarkPx > 0) prices.ETH = s.exchange.ethMarkPx;
    this.evaluateAlerts(prices, now);
    return this.queue.ranked(now);
  }

  /** Every signal the watchers raise for one round of reads, in no particular order. */
  collectSignals(s: ProtocolSnapshots, now = Date.now()): Signal[] {
    return Object.values(this.watcherSignals(s, now)).flatMap((list) => list ?? []);
  }

  /** The fix proposed by the highest-ranked watcher signal that carries one. */
  evaluateThresholds(s: ProtocolSnapshots): PendingAction | null {
    return rankSignals(this.collectSignals(s)).find((sig) => sig.action)?.action ?? null;
  }

  /** Signals per source; null for a source whose read failed, so its last signals stand until they expire. */
  private watcherSignals(s: ProtocolSnapshots, now: number): Record<WatcherSource, Signal[] | null> {
    const th = this.session.thresholds;
    const expiresAt = now + Math.max(60_000, 3 * this.config.pollIntervalMs);
    const make = (
      base: Pick<Signal, 'id' | 'source' | 'kind' | 'severity' | 'line' | 'lossDistancePct' | 'usdAtRisk'>,
      action: Omit<PendingAction, 'id' | 'source' | 'createdAt' | 'expiresAt' | 'requiresTap'> | null,
    ): Signal => ({
      ...base,
      line: fitSignalLine(base.line, action ? SIGNAL_LINE_MAX : SIGNAL_LENS_LINE_MAX),
      action: action
        ? { ...action, id: newActionId(), source: 'watcher', createdAt: now, expiresAt, requiresTap: true }
        : null,
      createdAt: now,
      updatedAt: now,
      expiresAt,
    });
    const severityFor = (value: number, limit: number): SignalSeverity => (value < limit / 2 ? 'critical' : 'warning');

    const aave: Signal[] = [];
    const hf = s.aave.healthFactor;
    if (hf !== null && s.aave.totalDebtUsd > 0 && hf < th.aaveMinHealthFactor) {
      const repayAmt = Math.min(
        th.aaveDefaultRepayUsdc,
        th.maxUsdcAction,
        Math.max(1, Math.ceil(s.aave.totalDebtUsd * 0.5)),
      );
      aave.push(
        make(
          {
            id: 'aave:health',
            source: 'aave',
            kind: 'loan_health',
            severity: severityFor(hf - 1, th.aaveMinHealthFactor - 1),
            line: `AAVE HEALTH ${(Math.floor(hf * 100) / 100).toFixed(2)} (LIMIT ${th.aaveMinHealthFactor.toFixed(2)})`,
            lossDistancePct: Math.max(0, (1 - 1 / hf) * 100),
            usdAtRisk: s.aave.totalCollateralUsd,
          },
          {
            protocol: 'aave',
            actionType: 'aave_repay',
            headline: `AAVE LOAN THRESHOLD · HEALTH ${hf.toFixed(2)}`,
            factLine: `LIMIT ${th.aaveMinHealthFactor.toFixed(2)} · DEBT $${s.aave.totalDebtUsd.toFixed(0)} · COLLAT $${s.aave.totalCollateralUsd.toFixed(0)}`,
            actionPrompt: `REPAY ${repayAmt} USDC`,
            params: { tokenIn: 'USDC', amount: repayAmt },
          },
        ),
      );
    }

    const hyperliquid: Signal[] = [];
    for (const pos of s.hyperliquid.positions) {
      if (pos.liqDistancePct === null || pos.liqDistancePct >= th.hlMinLiqDistancePct) continue;
      hyperliquid.push(
        make(
          {
            id: `hyperliquid:liq:${pos.coin}`,
            source: 'hyperliquid',
            kind: 'liquidation_distance',
            severity: severityFor(pos.liqDistancePct, th.hlMinLiqDistancePct),
            line: `HL ${pos.coin} ${pos.side} LIQ ${pos.liqDistancePct.toFixed(1)}% AWAY`,
            lossDistancePct: pos.liqDistancePct,
            usdAtRisk: pos.notionalUsd / Math.max(1, pos.leverage),
          },
          {
            protocol: 'hyperliquid',
            actionType: 'hl_trim',
            headline: `HL ${pos.coin}-PERP ${pos.side} · LIQ ${pos.liqDistancePct.toFixed(1)}% AWAY`,
            factLine: `LIMIT ${th.hlMinLiqDistancePct}% · SZ ${pos.size} · MARK $${pos.markPx.toFixed(1)}`,
            actionPrompt: `TRIM ${th.hlDefaultTrimPct}% ${pos.coin}`,
            params: { coin: pos.coin, amountPct: th.hlDefaultTrimPct },
          },
        ),
      );
    }

    const uniswap: Signal[] = [];
    if (th.uniswapAlertOutOfRange) {
      for (const lp of s.uniswap.lpPositions.filter((p) => !p.inRange)) {
        uniswap.push(
          make(
            {
              id: `uniswap:range:${lp.tokenId}`,
              source: 'uniswap',
              kind: 'lp_range',
              severity: 'warning',
              line: `UNI LP #${lp.tokenId} OUT OF RANGE`,
              lossDistancePct: null,
              usdAtRisk: 0,
            },
            {
              protocol: 'uniswap',
              actionType: 'uniswap_swap',
              headline: `UNISWAP LP #${lp.tokenId} OUT OF RANGE`,
              factLine: `TICK ${lp.currentTick} OUTSIDE [${lp.tickLower}, ${lp.tickUpper}]`,
              actionPrompt: 'SWAP 10 USDC->DAI',
              params: { tokenIn: 'USDC', tokenOut: 'DAI', amount: 10 },
            },
          ),
        );
      }
    }

    const exchange: Signal[] = [];
    const venue = s.exchange.venue === 'bybit-testnet' ? 'BYBIT' : 'BINANCE';
    for (const pos of s.exchange.positions) {
      if (pos.liqDistancePct === null || pos.liqDistancePct >= th.exchangeMinLiqDistancePct) continue;
      exchange.push(
        make(
          {
            id: `exchange:liq:${s.exchange.venue}:${pos.symbol}`,
            source: 'exchange',
            kind: 'liquidation_distance',
            severity: severityFor(pos.liqDistancePct, th.exchangeMinLiqDistancePct),
            line: `${venue} ${pos.symbol} ${pos.side} LIQ ${pos.liqDistancePct.toFixed(1)}% AWAY`,
            lossDistancePct: pos.liqDistancePct,
            usdAtRisk: pos.size * pos.markPx,
          },
          null,
        ),
      );
    }

    return {
      aave: s.aave.error ? null : aave,
      hyperliquid: s.hyperliquid.error ? null : hyperliquid,
      uniswap: s.uniswap.error ? null : uniswap,
      exchange: s.exchange.error ? null : exchange,
    };
  }

  listAlerts(): PriceAlertRule[] {
    return [...this.alertRules];
  }

  /** Read only the testnet mark prices and check alert rules against them. */
  async pollPrices(): Promise<Record<string, number>> {
    const prices = await this.hyperliquid.readMarkPrices();
    this.evaluateAlerts(prices, Date.now());
    this.tick();
    return prices;
  }

  async addAlert(
    input: { asset: string; direction: string; price: number },
    via: PriceAlertRule['createdVia'],
  ): Promise<AlertResult> {
    let live = this.latestPrices[input.asset];
    if (live === undefined) {
      const prices = await this.hyperliquid.readMarkPrices().catch(() => ({}) as Record<string, number>);
      this.latestPrices = { ...this.latestPrices, ...prices };
      live = this.latestPrices[input.asset];
    }
    const check = checkNewRule(input, live, this.alertRules.length);
    if (!check.ok) return check;
    const rule: PriceAlertRule = {
      id: `al_${crypto.randomBytes(4).toString('hex')}`,
      asset: input.asset as AlertAsset,
      direction: input.direction as AlertDirection,
      price: input.price,
      referencePrice: live as number,
      createdAt: Date.now(),
      createdVia: via,
    };
    this.alertRules.push(rule);
    this.saveState();
    return { ok: true, rule };
  }

  removeAlert(id: string): boolean {
    const before = this.alertRules.length;
    this.alertRules = this.alertRules.filter((r) => r.id !== id);
    if (this.alertRules.length === before) return false;
    this.saveState();
    return true;
  }

  /** Raise a signal for every rule the live price has crossed; a rule fires once and is then removed. */
  evaluateAlerts(prices: Record<string, number>, now = Date.now()): PriceAlertRule[] {
    this.latestPrices = { ...this.latestPrices, ...prices };
    const fired = this.alertRules.filter((r) => ruleCrossed(r, prices[r.asset]));
    if (fired.length === 0) return [];
    for (const rule of fired) {
      this.queue.upsert(priceAlertSignal(rule, prices[rule.asset] as number, now));
    }
    const firedIds = new Set(fired.map((r) => r.id));
    this.alertRules = this.alertRules.filter((r) => !firedIds.has(r.id));
    this.saveState();
    return fired;
  }

  private saveState(): void {
    this.store.save({
      alertRules: this.alertRules,
      requesters: this.requests.requesters,
      requests: this.requests.requests,
      payouts: this.requests.payouts,
    });
  }

  setGlassesConnected(delta: 1 | -1): void {
    this.glassesOnline = Math.max(0, this.glassesOnline + delta);
  }

  get glassesConnected(): boolean {
    return this.glassesOnline > 0;
  }

  private caps() {
    const th = this.session.thresholds;
    return { perRequestUsdc: th.maxRequestUsdc, dailyUsdc: th.dailyRequestUsdc };
  }

  private async notify(chatId: string | null, text: string, keyboard?: Record<string, unknown>): Promise<number | null> {
    if (!chatId || !this.telegram.isConfigured) return null;
    try {
      return (await this.telegram.sendMessage(chatId, text, keyboard)).message_id;
    } catch (err) {
      console.error('[ChainVision] Telegram send failed:', err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /** Tell the requester in their private chat, and the group the request came from, if any. */
  private async tellRequester(request: MoneyRequest, kind: string, text: string, keyboard?: Record<string, unknown>): Promise<void> {
    const dm = await this.notify(request.requesterId, text, keyboard);
    if (dm !== null) this.requests.noteMessage(request, { role: 'requester', kind, messageId: dm });
    if (request.askedInGroup) {
      const group = await this.notify(request.askedInChatId, text);
      if (group !== null) this.requests.noteMessage(request, { role: 'group', kind, messageId: group });
    }
  }

  async handleRegister(ctx: CommandContext): Promise<BotReply> {
    if (ctx.isGroup) {
      return { text: 'Register in a private chat with me, so your address stays out of the group.' };
    }
    const res = this.requests.register(ctx.from, ctx.args[0] ?? '', ctx.args.slice(1).join(' '), Date.now());
    if (!res.ok) return { text: res.reason };
    const r = res.requester;
    if (res.needsApproval) {
      const handle = r.username ? ` (@${r.username})` : '';
      const keyboard = this.config.telegramMiniAppUrl
        ? { inline_keyboard: [[{ text: 'Open ChainVision Setup', web_app: { url: this.config.telegramMiniAppUrl } }]] }
        : undefined;
      await this.notify(
        this.session.telegramChatId,
        `New requester: ${r.name}${handle} registered ${r.address}. Approve them once in the ChainVision Mini App before their requests reach your glasses.`,
        keyboard,
      );
    }
    return {
      text: `Registered as ${r.name} with ${shortAddress(r.address)} (Sepolia). ${
        res.needsApproval ? 'The wearer approves new requesters once; after that you can /ask.' : 'You can /ask now.'
      }`,
    };
  }

  async handleAsk(ctx: CommandContext): Promise<BotReply> {
    const amount = parseAskAmount(ctx.text);
    if (amount === null) {
      return { text: 'Use /ask <amount> USDC, for example /ask 20 USDC. Only Sepolia testnet USDC.' };
    }
    if (!this.session.telegramChatId) return { text: 'No wearer is paired with this bot yet.' };
    const now = Date.now();
    const res = this.requests.ask(ctx.from.id, amount, { id: ctx.chatId, isGroup: ctx.isGroup }, this.caps(), now);
    if (!res.ok) return { text: res.reason };
    const { request, requester } = res;
    this.queue.upsert(requestSignal(request, requester, newActionId(), now));
    this.tick(now);
    const amountText = formatUsdc(amount);
    const wearerMsg = await this.notify(
      this.session.telegramChatId,
      [
        `${requester.name} asks for ${amountText} USDC (Sepolia testnet) to ${requester.address}.`,
        'Tap PAY on your glasses, or swipe down to decline.',
        'If your glasses are not connected, you can approve here in two steps.',
        'Expires in 5 minutes.',
      ].join('\n'),
      {
        inline_keyboard: [
          [{ text: 'Approve here', callback_data: `rq:approve:${request.id}` }],
          [{ text: 'Decline', callback_data: `rq:decline:${request.id}` }],
        ],
      },
    );
    if (wearerMsg !== null) this.requests.noteMessage(request, { role: 'wearer', kind: 'request', messageId: wearerMsg });
    return {
      text: `Sent to the wearer: ${amountText} USDC to ${shortAddress(requester.address)}. They answer on their glasses; this request expires in 5 minutes.`,
    };
  }

  async handleRequestCallback(ctx: CallbackContext): Promise<CallbackReply> {
    const m = ctx.data.match(/^rq:(approve|pay|decline):(rq_[0-9a-f]+)$/);
    if (!m) return {};
    const [, verb, id] = m;
    if (!this.session.telegramChatId || ctx.from.id !== this.session.telegramChatId) {
      return { answer: 'Only the paired wearer can answer requests.' };
    }
    const request = this.requests.request(id as string);
    const requester = request ? this.requests.requester(request.requesterId) : null;
    if (!request || !requester || !isOpen(request, Date.now())) {
      return { answer: 'No longer open', editText: 'This request is no longer open.' };
    }
    const amountText = formatUsdc(request.amount);
    if (verb === 'decline') {
      await this.declineRequest(request, 'telegram_decline');
      return { answer: 'Declined', editText: `Declined ${requester.name}'s request for ${amountText} USDC. They were told.` };
    }
    if (this.glassesConnected) {
      return { answer: 'Your glasses are connected: tap PAY on the lens.' };
    }
    if (verb === 'approve') {
      return {
        answer: 'Confirm to pay',
        editText: `Pay ${amountText} USDC to ${requester.name} (${requester.address}) on Sepolia testnet?\nSecond confirmation: this sends testnet USDC from your test wallet.`,
        keyboard: {
          inline_keyboard: [
            [{ text: `Yes, pay ${amountText} USDC`, callback_data: `rq:pay:${request.id}` }],
            [{ text: 'Decline', callback_data: `rq:decline:${request.id}` }],
          ],
        },
      };
    }
    const action =
      this.queue.get(`request:${request.id}`)?.action ?? requestSignal(request, requester, newActionId(), Date.now()).action;
    try {
      const receipt = await this.payRequest(action as PendingAction, 'telegram_confirm');
      this.lastReceipt = receipt;
      this.publish();
      return { answer: 'Paid', editText: formatReceiptText(receipt) };
    } catch (err) {
      return { answer: 'Not paid', editText: `Not paid: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async declineRequest(request: MoneyRequest, via: RequestResolution): Promise<void> {
    this.requests.resolve(request, 'declined', via, Date.now());
    this.queue.remove(`request:${request.id}`);
    this.publish();
    await this.tellRequester(
      request,
      'declined',
      `The wearer declined your request for ${formatUsdc(request.amount)} USDC this time. No funds moved.`,
    );
  }

  /**
   * Pay an open request from the app's capped test wallet. Reached only from a tap on the lens
   * (glasses_tap) or, with the glasses offline, the wearer's two Telegram confirmations.
   */
  private async payRequest(action: PendingAction, via: RequestResolution): Promise<ExecutionReceipt> {
    const id = action.params.requestId ?? '';
    const request = this.requests.request(id);
    const requester = request ? this.requests.requester(request.requesterId) : null;
    if (this.paying.has(id)) throw new Error('This request is already being paid');
    const check = checkPayout({ request, requester, payouts: this.requests.payouts, caps: this.caps(), now: Date.now() });
    if (!check.ok || !request || !requester) throw new Error(check.ok ? 'Request not found' : check.reason);

    this.paying.add(id);
    try {
      const caps = this.caps();
      let res: Awaited<ReturnType<SepoliaPayoutClient['transferUsdc']>>;
      try {
        res = await this.payout.transferUsdc({
          to: requester.address,
          amount: request.amount,
          approvedRecipients: this.requests.approvedAddresses(),
          perRequestCapUsdc: caps.perRequestUsdc,
          dailyCapUsdc: caps.dailyUsdc,
          paidLastDayUsdc: this.requests.paidLastDay(Date.now()),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.requests.resolve(request, 'failed', via, Date.now(), { error: message });
        this.queue.remove(`request:${request.id}`);
        await this.tellRequester(request, 'failed', `Your request for ${formatUsdc(request.amount)} USDC could not be paid. No funds moved.`);
        throw err;
      }
      this.requests.resolve(request, 'paid', via, Date.now(), { txHash: res.txHash });
      this.queue.remove(`request:${request.id}`);
      const amountText = formatUsdc(request.amount);
      const receipt: ExecutionReceipt = {
        id: `rcpt_${crypto.randomBytes(4).toString('hex')}`,
        actionId: action.id,
        protocol: 'sepolia',
        actionType: 'usdc_payout',
        network: 'sepolia',
        summary: `PAID ${amountText} USDC TO ${requester.name}`,
        beforeFact: `WALLET ${res.before.toFixed(2)} USDC`,
        afterFact: `WALLET ${res.after.toFixed(2)} USDC`,
        txHashOrOrderId: res.txHash,
        explorerUrl: res.explorerUrl,
        telegramPosted: false,
        timestamp: Date.now(),
      };
      const tg = await this.telegram.sendReceipt(receipt, this.session.telegramChatId);
      receipt.telegramPosted = tg.sent;
      if (tg.messageId) this.requests.noteMessage(request, { role: 'wearer', kind: 'receipt', messageId: tg.messageId });
      await this.tellRequester(
        request,
        'receipt',
        [
          'ChainVision Testnet Receipt',
          `The wearer paid your request: ${amountText} USDC (${this.payout.token.address}) on Sepolia testnet`,
          `To: ${requester.address}`,
          `Tx: ${res.txHash}`,
          `Explorer: ${res.explorerUrl}`,
          'Testnet only · Not financial advice',
        ].join('\n'),
        { inline_keyboard: [[{ text: 'View on Explorer', url: res.explorerUrl }]] },
      );
      return receipt;
    } finally {
      this.paying.delete(id);
    }
  }

  /** "What matters?": up to three ranked lines from the queue, read-only, then blank again. */
  showBrief(now = Date.now()): string[] {
    this.briefLines = this.queue.ranked(now).slice(0, BRIEF_MAX_LINES).map((s) => s.line);
    this.setOverlay('brief', now);
    this.publish(now);
    return this.briefLines;
  }

  showNotice(text: string, now = Date.now()): void {
    this.noticeText = text;
    this.setOverlay('notice', now);
    this.publish(now);
  }

  async handleVoiceTranscript(
    transcript: string,
  ): Promise<{ parse: IntentParseResult; pendingAction: PendingAction | null; alert?: AlertResult }> {
    const parse = await this.intents.parseTranscript(transcript);

    if (parse.intent.action === 'brief') {
      this.showBrief();
      return { parse, pendingAction: null };
    }

    if (parse.intent.action === 'price_alert') {
      const alert = await this.addAlert(parse.intent, 'voice');
      this.showNotice(alert.ok ? `ALERT SET: ${describeRule(alert.rule)}` : alert.reason);
      return { parse, pendingAction: null, alert };
    }

    const snap = this.snapshots ?? (await this.pollNow());
    const pendingAction = await this.buildActionFromIntent(parse.intent, snap);

    if (parse.intent.action === 'status') {
      this.setOverlay('positions');
      this.positionPageIndex =
        parse.intent.protocol === 'hyperliquid'
          ? 1
          : parse.intent.protocol === 'uniswap'
            ? 2
            : parse.intent.protocol === 'exchange'
              ? 3
              : 0;
      this.publish();
      return { parse, pendingAction: null };
    }

    if (!pendingAction) {
      this.errorMessage =
        parse.intent.action === 'unsupported'
          ? parse.intent.reason
          : 'Could not prepare testnet action from voice command';
      this.setOverlay('error');
      this.broadcast({ type: 'error', message: this.errorMessage });
      this.publish();
      return { parse, pendingAction: null };
    }

    this.errorMessage = undefined;
    this.pendingAction = pendingAction;
    this.setOverlay('confirm');
    this.broadcast({ type: 'confirm', action: pendingAction });
    this.publish();
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
      const requestedRate = snap.aave.rates.find(
        (r) => r.symbol === (intent.token === 'ETH' ? 'WETH' : intent.token),
      );
      // On Sepolia, USDC/DAI pools can reach their testnet supply cap (Aave error 51).
      // Detect that live on-chain and route stablecoin supply to open-cap EURS transparently.
      const capFull = Boolean(requestedRate?.supplyCapReached && (intent.token === 'USDC' || intent.token === 'DAI'));
      const effectiveToken = capFull ? 'EURS' : intent.token;
      const effectiveRate =
        snap.aave.rates.find((r) => r.symbol === (effectiveToken === 'ETH' ? 'WETH' : effectiveToken))
          ?.supplyApyPct ?? requestedRate?.supplyApyPct ?? 0;

      // Compare like with like: all annualized yields on testnets
      // Exchange perp funding settles 3x/day (every 8h); Hyperliquid settles hourly (24x/day)
      const exAnnualApr = snap.exchange.ethFundingPct * 3 * 365;
      const hlAnnualApr = snap.hyperliquid.ethFundingPctHr * 24 * 365;
      return {
        id: `act_${crypto.randomBytes(4).toString('hex')}`,
        source: 'voice',
        protocol: 'aave',
        actionType: 'aave_supply',
        headline: capFull
          ? `AAVE SUPPLY ${capped} EURS (SEPOLIA ${intent.token} CAP FULL)`
          : `AAVE SUPPLY ${capped} ${effectiveToken} (SEPOLIA TESTNET)`,
        factLine: `AAVE ${effectiveRate.toFixed(1)}% APY · HL ${hlAnnualApr.toFixed(1)}% APR · EX ${exAnnualApr.toFixed(1)}% APR`,
        comparisonLine: `TESTNET RATES (ANNUAL) · CAP ${th.maxUsdcAction} STABLES`,
        actionPrompt: `SUPPLY ${capped} ${effectiveToken}`,
        params: { tokenIn: effectiveToken, amount: capped },
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
        headline: `UNISWAP ${cappedIn} ${intent.tokenIn} -> ${intent.tokenOut} (TESTNET)`,
        factLine: `UNI TESTNET OUT: ${quoteOut.toFixed(4)} ${intent.tokenOut} (3% MAX SLIP)`,
        comparisonLine: `HL MARK $${snap.hyperliquid.ethMarkPx.toFixed(0)} · EX MARK $${snap.exchange.ethMarkPx.toFixed(0)}`,
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
   * Executes an action ONLY after an explicit tap on the glasses: either the voice confirm card
   * on screen, or the fix carried by the signal the lens is showing right now.
   */
  async confirmPendingAction(actionId: string): Promise<ExecutionReceipt> {
    const now = Date.now();
    const voice = this.overlay === 'confirm' ? this.getPendingAction(now) : null;
    const top = this.overlay ? null : this.queue.top(now);
    const action = voice?.id === actionId ? voice : top?.action?.id === actionId ? top.action : null;
    if (!action) {
      throw new Error('No matching pending action to confirm (expired, replaced or not on the lens)');
    }
    const signalId = action === voice ? null : (top?.id ?? null);

    this.pendingAction = action;
    this.setOverlay('executing', now);
    this.broadcast({ type: 'executing', actionId: action.id, label: action.actionPrompt });
    this.publish(now);

    try {
      const receipt = await this.executeAction(action);
      if (!receipt.telegramPosted) {
        const tg = await this.telegram.sendReceipt(receipt, this.session.telegramChatId);
        receipt.telegramPosted = tg.sent;
      }

      if (signalId) this.queue.remove(signalId);
      this.pendingAction = null;
      this.lastReceipt = receipt;
      this.setOverlay('result');
      await this.pollNow();
      this.broadcast({ type: 'receipt', receipt });
      this.publish();
      return receipt;
    } catch (err) {
      this.pendingAction = null;
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.setOverlay('error');
      this.broadcast({ type: 'error', message: this.errorMessage });
      this.publish();
      throw err;
    }
  }

  async executeAction(action: PendingAction): Promise<ExecutionReceipt> {
    if (action.actionType === 'usdc_payout') return this.payRequest(action, 'glasses_tap');
    const th = this.session.thresholds;
    let receipt: ExecutionReceipt;
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
      const token = (action.params.tokenIn ?? 'EURS') as 'USDC' | 'DAI' | 'ETH' | 'EURS';
      const amount = action.params.amount ?? 10;
      const res = await this.aave.supply({ token, amount, thresholds: th });
      const beforeFact =
        token === 'EURS'
          ? `WALLET ${(res.before.eursBalance ?? 0).toFixed(1)} EURS`
          : `COLLAT $${res.before.totalCollateralUsd.toFixed(1)}`;
      const afterFact =
        token === 'EURS'
          ? `WALLET ${(res.after.eursBalance ?? 0).toFixed(1)} EURS`
          : `COLLAT $${res.after.totalCollateralUsd.toFixed(1)}`;
      receipt = {
        id: `rcpt_${crypto.randomBytes(4).toString('hex')}`,
        actionId: action.id,
        protocol: 'aave',
        actionType: 'aave_supply',
        network: 'sepolia',
        summary: `AAVE SUPPLY ${amount} ${token}`,
        beforeFact,
        afterFact,
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
    return receipt;
  }

  /**
   * Swipe down. On a signal: hide it and show the next one, or blank if none; a money request is declined.
   * On any card (confirm, brief, result, positions...): close it.
   */
  dismissToBlank(now = Date.now()): void {
    if (this.overlay) {
      if (this.overlay === 'confirm') this.pendingAction = null;
      this.setOverlay(null, now);
      this.errorMessage = undefined;
      this.noticeText = undefined;
    } else {
      const top = this.queue.top(now);
      const request = top?.source === 'telegram' ? this.requests.request(top.action?.params.requestId ?? '') : null;
      if (request && isOpen(request, now)) {
        void this.declineRequest(request, 'lens_swipe');
      } else if (top) {
        this.queue.dismiss(top.id, now);
      }
      this.shown = null;
    }
    this.publish(now);
  }

  cyclePositionView(): void {
    if (this.overlay === 'positions') {
      this.positionPageIndex = (this.positionPageIndex + 1) % 4;
    } else {
      this.setOverlay('positions');
      this.positionPageIndex = 0;
    }
    this.publish();
  }
}
