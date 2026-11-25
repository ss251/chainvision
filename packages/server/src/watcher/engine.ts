import crypto from 'node:crypto';
import {
  BRIEF_EMPTY_TEXT,
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
  describeRule,
  fitSignalLine,
  priceAlertSignal,
  rankSignals,
  ruleCrossed,
  parseTonAmount,
  tonReadOnlyBriefLine,
  tonWalletSignals,
  type AlertAsset,
  type AlertDirection,
  type ExecutionReceipt,
  type LensMode,
  type LensViewState,
  type PairingSession,
  type PendingAction,
  type PriceAlertRule,
  type ProtocolSnapshots,
  type Signal,
  type SignalSeverity,
  type SignalSource,
  type TonWalletSnapshot,
  type UserThresholds,
  type VoiceIntent,
  type WsServerMessage,
} from '@chainvision/shared';
import type { AppConfig } from '../config.js';
import { AaveSepoliaClient } from '../protocols/aave.js';
import { ExchangeTestnetWatcher } from '../protocols/exchange.js';
import { HyperliquidTestnetClient } from '../protocols/hyperliquid.js';
import { UniswapSepoliaClient } from '../protocols/uniswap.js';
import { StateStore } from '../store.js';
import { parseTonAddress, testnetFriendly } from '../ton/address.js';
import { Toncenter } from '../ton/toncenter.js';
import { TonRequestRail, TonTransferError, type TonRequestDesk } from '../ton/requests.js';
import { TonTestnetWallet, readTonBalance } from '../ton/wallet.js';
import { TelegramBotService } from '../telegram/bot.js';
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

type WatcherSource = Exclude<SignalSource, 'price_alert' | 'telegram' | 'ton'>;

export interface TonConnectedWallet {
  /** Testnet, non-bounceable form. */
  address: string;
  balanceNano: string | null;
  connectedAt: number;
}

export type AlertResult = { ok: true; rule: PriceAlertRule } | { ok: false; reason: string };

export interface EngineOptions {
  /** JSON file that keeps alert rules across restarts; omitted means in memory only. */
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
  readonly tonWallet: TonTestnetWallet;
  readonly tonRail: TonRequestRail;
  /** The Telegram money-request model TON requests are paid from; the request flow plugs it in. */
  tonRequests: TonRequestDesk | null = null;
  private readonly tonMainnet: Toncenter;
  private tonSnapshot: TonWalletSnapshot | null = null;
  private tonPrevBalance: bigint | null = null;
  private tonLowSince: number | null = null;
  private tonConnected: TonConnectedWallet | null = null;
  private tonMainnetNano: string | null = null;
  private tonTimer: ReturnType<typeof setInterval> | null = null;

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

  constructor(config: AppConfig, options: EngineOptions = {}) {
    this.config = config;
    this.aave = new AaveSepoliaClient(config);
    this.uniswap = new UniswapSepoliaClient(config);
    this.hyperliquid = new HyperliquidTestnetClient(config);
    this.exchange = new ExchangeTestnetWatcher(config);
    this.stt = new WhisperSttService(config);
    this.intents = new VoiceIntentService(config);
    this.telegram = new TelegramBotService(config);
    this.store = new StateStore(options.stateFile ?? null);
    this.tonWallet = new TonTestnetWallet(config.tonTestnetMnemonic, new Toncenter('testnet', config.toncenterApiKey));
    this.tonMainnet = new Toncenter('mainnet', config.toncenterApiKey);
    this.tonRail = new TonRequestRail(this.tonWallet);
    this.alertRules = this.store.load().alertRules;

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
      maxRequestTon: clamp(patch.maxRequestTon, 0.01, 10, t.maxRequestTon),
      dailyRequestTon: clamp(patch.dailyRequestTon, 0.01, 50, t.dailyRequestTon),
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
    void this.pollTon();
    if (!this.tonTimer) {
      this.tonTimer = setInterval(() => {
        void this.pollTon();
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
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.tonTimer) {
      clearInterval(this.tonTimer);
      this.tonTimer = null;
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

  /**
   * One round of TON reads, all through toncenter and all read-only: the app's test wallet (its
   * incoming payments and a low balance become signals), the wearer's TON Connect wallet on
   * testnet, and the optional mainnet Gram Wallet address.
   */
  async pollTon(now = Date.now()): Promise<TonWalletSnapshot> {
    const snap = await this.tonWallet.read(now);
    this.applyTonSnapshot(snap, now);
    if (this.tonConnected) {
      const connected = this.tonConnected;
      const nano = await readTonBalance(this.tonWallet.api, connected.address).catch(() => null);
      if (this.tonConnected === connected && nano !== null) connected.balanceNano = nano.toString();
    }
    if (this.config.tonMainnetWatchAddress) {
      const nano = await readTonBalance(this.tonMainnet, this.config.tonMainnetWatchAddress).catch(() => null);
      if (nano !== null) this.tonMainnetNano = nano.toString();
    }
    this.tick();
    return snap;
  }

  applyTonSnapshot(snap: TonWalletSnapshot, now = Date.now()): Signal[] {
    this.tonSnapshot = snap;
    if (snap.error || snap.balanceNano === null) return [];
    const balance = BigInt(snap.balanceNano);
    const floor = parseTonAmount(this.config.tonLowBalanceTon);
    if (floor !== null) {
      if (balance >= floor) this.tonLowSince = null;
      else if (this.tonPrevBalance !== null && this.tonPrevBalance >= floor && this.tonLowSince === null) this.tonLowSince = now;
    }
    this.tonPrevBalance = balance;
    const signals = tonWalletSignals(snap, { lowBalanceTon: this.config.tonLowBalanceTon, lowSince: this.tonLowSince }, now);
    this.queue.replaceSource('ton', signals);
    return signals;
  }

  /** The wearer's wallet, connected through TON Connect in the Mini App: testnet only, read-only. */
  async connectTonWallet(input: { address?: string; chain?: string } | null): Promise<TonConnectedWallet | null> {
    if (!input?.address) {
      this.tonConnected = null;
      return null;
    }
    if (input.chain !== '-3') throw new Error('Connect a testnet wallet (TON Connect network -3)');
    const parsed = parseTonAddress(input.address);
    if (!parsed) throw new Error('Not a TON address');
    const connected: TonConnectedWallet = { address: testnetFriendly(parsed.address), balanceNano: null, connectedAt: Date.now() };
    this.tonConnected = connected;
    const nano = await readTonBalance(this.tonWallet.api, connected.address).catch(() => null);
    if (nano !== null) connected.balanceNano = nano.toString();
    return connected;
  }

  getTonStatus() {
    return {
      testWallet: this.tonSnapshot,
      connected: this.tonConnected,
      mainnet: this.config.tonMainnetWatchAddress
        ? { address: this.config.tonMainnetWatchAddress, balanceNano: this.tonMainnetNano, readOnly: true }
        : null,
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
    this.store.save({ alertRules: this.alertRules });
  }

  /** "What matters?": up to three ranked lines from the queue, read-only, then blank again. */
  showBrief(now = Date.now()): string[] {
    const readOnly = tonReadOnlyBriefLine({ connectedTestnetNano: this.tonConnected?.balanceNano ?? null, mainnetNano: this.tonMainnetNano });
    const lines = this.queue.ranked(now).slice(0, readOnly ? BRIEF_MAX_LINES - 1 : BRIEF_MAX_LINES).map((s) => s.line);
    this.briefLines = readOnly ? [...(lines.length ? lines : [BRIEF_EMPTY_TEXT]), readOnly] : lines;
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
      const tg = await this.telegram.sendReceipt(receipt, this.session.telegramChatId);
      receipt.telegramPosted = tg.sent;

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
    if (action.actionType === 'ton_payout') return this.payTonRequest(action);
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

  /** Pay an open TON request from the app's capped test wallet; reached only through a confirmed tap. */
  private async payTonRequest(action: PendingAction, desk = this.tonRequests): Promise<ExecutionReceipt> {
    if (!desk) throw new Error('TON requests arrive through the Telegram money-request flow, which is not connected');
    const th = this.session.thresholds;
    try {
      const paid = await this.tonRail.pay(action, desk, { perRequestTon: th.maxRequestTon, dailyTon: th.dailyRequestTon });
      await desk.settle(paid);
      return paid.receipt;
    } catch (err) {
      if (err instanceof TonTransferError) await desk.failed(action.params.requestId ?? '', err.message);
      throw err;
    }
  }

  /**
   * Swipe down. On a signal: hide it and show the next one, or blank if none.
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
      if (top) {
        this.queue.dismiss(top.id, now);
        this.shown = null;
      }
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
