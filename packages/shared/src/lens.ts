import type { LensViewState } from './types.js';
import {
  BRIEF_EMPTY_TEXT,
  BRIEF_MAX_LINES,
  SIGNAL_LENS_LINE_MAX,
  SIGNAL_PROMPT_MAX,
  fitSignalLine,
  type Signal,
} from './signal.js';
import { hasEmoji, sanitizeForG2 } from './text.js';

export { hasEmoji, sanitizeForG2 };

export const G2_DISPLAY_WIDTH = 576;
export const G2_DISPLAY_HEIGHT = 288;
export const G2_MAX_CONTAINERS = 12;
export const G2_MAX_IMAGE_CONTAINERS = 4;
export const G2_MAX_TEXT_CONTAINERS = 8;
export const G2_MAX_CREATE_CHARS = 1000;

export interface LensTextContainerSpec {
  containerID: number;
  containerName: string;
  xPosition: number;
  yPosition: number;
  width: number;
  height: number;
  content: string;
  isEventCapture: 0 | 1;
  borderWidth: number;
  borderColor: number;
  borderRadius: number;
  paddingLength: number;
}

export interface LensPageLayout {
  mode: LensViewState['mode'];
  containerTotalNum: number;
  textObject: LensTextContainerSpec[];
  totalChars: number;
}

export interface LensValidationResult {
  valid: boolean;
  errors: string[];
}

// Disallowed financial-advice phrasing (hackathon Money Safety rule)
const ADVICE_PATTERNS = [
  /\brecommend(?:ed|s|ing)?\b/i,
  /\byou should\b/i,
  /\bguaranteed\b/i,
  /\bfinancial advice\b/i,
  /\bbest investment\b/i,
  /\bbuy now\b/i,
];

export function hasAdviceLanguage(input: string): boolean {
  return ADVICE_PATTERNS.some((re) => re.test(input));
}

/** The single lens line for a signal: its fact, then the tap prompt when it carries an action. */
export function signalLensLine(signal: Pick<Signal, 'line' | 'action'>): string {
  if (!signal.action) return fitSignalLine(signal.line, SIGNAL_LENS_LINE_MAX);
  const fact = fitSignalLine(signal.line);
  const prompt = fitSignalLine(
    signal.action.actionPrompt,
    Math.max(SIGNAL_PROMPT_MAX, SIGNAL_LENS_LINE_MAX - fact.length - ' - TAP: '.length),
  );
  return `${fact} - TAP: ${prompt}`.slice(0, SIGNAL_LENS_LINE_MAX);
}

function singleLine(name: string, content: string): LensTextContainerSpec {
  return {
    containerID: 1,
    containerName: name,
    xPosition: 16,
    yPosition: 112,
    width: 544,
    height: 64,
    content,
    isEventCapture: 1,
    borderWidth: 0,
    borderColor: 0,
    borderRadius: 0,
    paddingLength: 8,
  };
}

export function renderBar(ratio: number, width = 12): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

function truncateLine(text: string, maxLen: number): string {
  const clean = sanitizeForG2(text);
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, Math.max(0, maxLen - 2)) + '..';
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1000) return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

/**
 * Pure renderer turning ChainVision state into an Even Hub G2 page layout.
 * Strictly obeys:
 * - Blank idle screen (empty content = black/transparent pixels)
 * - Max 12 containers, exactly 1 with isEventCapture: 1
 * - Max 1000 chars total
 * - Zero emoji, factual non-advisory wording
 */
export function renderLensPage(state: LensViewState): LensPageLayout {
  const containers: LensTextContainerSpec[] = [];

  if (state.mode === 'idle') {
    // True blank idle screen: black pixels are see-through on Even G2 waveguides.
    // Keep 1 invisible event-capture container so temple tap/long-press/swipe/double-tap still work.
    containers.push({
      containerID: 1,
      containerName: 'cv_idle',
      xPosition: 0,
      yPosition: 0,
      width: G2_DISPLAY_WIDTH,
      height: G2_DISPLAY_HEIGHT,
      content: '',
      isEventCapture: 1,
      borderWidth: 0,
      borderColor: 0,
      borderRadius: 0,
      paddingLength: 0,
    });
  } else if (state.mode === 'signal' && state.signal) {
    containers.push(singleLine('cv_signal', signalLensLine(state.signal)));
  } else if (state.mode === 'notice' && state.noticeText) {
    containers.push(singleLine('cv_notice', fitSignalLine(state.noticeText, SIGNAL_LENS_LINE_MAX)));
  } else if (state.mode === 'brief') {
    const lines = (state.briefLines ?? []).slice(0, BRIEF_MAX_LINES);
    containers.push(
      {
        containerID: 1,
        containerName: 'cv_head',
        xPosition: 16,
        yPosition: 40,
        width: 544,
        height: 40,
        content: 'WHAT MATTERS',
        isEventCapture: 0,
        borderWidth: 0,
        borderColor: 0,
        borderRadius: 0,
        paddingLength: 2,
      },
      {
        containerID: 2,
        containerName: 'cv_main',
        xPosition: 16,
        yPosition: 88,
        width: 544,
        height: 140,
        content: lines.length
          ? lines.map((l, i) => `${i + 1} ${fitSignalLine(l, SIGNAL_LENS_LINE_MAX - 2)}`).join('\n')
          : BRIEF_EMPTY_TEXT,
        isEventCapture: 1,
        borderWidth: 0,
        borderColor: 0,
        borderRadius: 0,
        paddingLength: 8,
      },
    );
  } else if (state.mode === 'voice_listening') {
    containers.push(
      {
        containerID: 1,
        containerName: 'cv_head',
        xPosition: 16,
        yPosition: 20,
        width: 544,
        height: 44,
        content: 'CHAINVISION · VOICE CAPTURE (TESTNET)',
        isEventCapture: 0,
        borderWidth: 0,
        borderColor: 0,
        borderRadius: 0,
        paddingLength: 2,
      },
      {
        containerID: 2,
        containerName: 'cv_main',
        xPosition: 16,
        yPosition: 72,
        width: 544,
        height: 140,
        content: truncateLine(
          state.voiceTranscript
            ? `HEARD: "${state.voiceTranscript}"\nPARSING INTENT...`
            : 'LISTENING · RELEASE TEMPLE WHEN DONE\nEX: "PUT 200 USDC TO WORK"\nEX: "SWAP HALF MY ETH TO USDC"',
          260,
        ),
        isEventCapture: 1,
        borderWidth: 1,
        borderColor: 10,
        borderRadius: 4,
        paddingLength: 8,
      },
      {
        containerID: 3,
        containerName: 'cv_foot',
        xPosition: 16,
        yPosition: 224,
        width: 544,
        height: 44,
        content: 'DN: CANCEL  ·  2xTAP: EXIT',
        isEventCapture: 0,
        borderWidth: 0,
        borderColor: 0,
        borderRadius: 0,
        paddingLength: 2,
      },
    );
  } else if ((state.mode === 'alert' || state.mode === 'confirm') && state.pendingAction) {
    const a = state.pendingAction;
    const tag = state.mode === 'alert' ? 'THRESHOLD ALERT' : 'CONFIRM ACTION';
    const lines = [
      truncateLine(a.headline, 62),
      truncateLine(a.factLine, 62),
      a.comparisonLine ? truncateLine(a.comparisonLine, 62) : '',
    ].filter(Boolean);

    containers.push(
      {
        containerID: 1,
        containerName: 'cv_head',
        xPosition: 16,
        yPosition: 16,
        width: 544,
        height: 40,
        content: truncateLine(`CHAINVISION · ${tag} · TESTNET`, 56),
        isEventCapture: 0,
        borderWidth: 0,
        borderColor: 0,
        borderRadius: 0,
        paddingLength: 2,
      },
      {
        containerID: 2,
        containerName: 'cv_main',
        xPosition: 16,
        yPosition: 64,
        width: 544,
        height: 148,
        content: lines.join('\n'),
        isEventCapture: 1,
        borderWidth: 2,
        borderColor: 12,
        borderRadius: 4,
        paddingLength: 8,
      },
      {
        containerID: 3,
        containerName: 'cv_foot',
        xPosition: 16,
        yPosition: 222,
        width: 544,
        height: 48,
        content: truncateLine(`TAP: ${a.actionPrompt}  |  DN: CANCEL`, 64),
        isEventCapture: 0,
        borderWidth: 1,
        borderColor: 6,
        borderRadius: 2,
        paddingLength: 4,
      },
    );
  } else if (state.mode === 'executing') {
    containers.push({
      containerID: 1,
      containerName: 'cv_exec',
      xPosition: 16,
      yPosition: 76,
      width: 544,
      height: 136,
      content: truncateLine(
        `EXECUTING ON TESTNET...\n${state.pendingAction?.actionPrompt ?? 'SENDING SIGNED TX'}\nWAIT FOR CONFIRMATION`,
        200,
      ),
      isEventCapture: 1,
      borderWidth: 1,
      borderColor: 8,
      borderRadius: 4,
      paddingLength: 8,
    });
  } else if (state.mode === 'result' && state.lastReceipt) {
    const r = state.lastReceipt;
    const shortHash = r.txHashOrOrderId.length > 14
      ? `${r.txHashOrOrderId.slice(0, 8)}..${r.txHashOrOrderId.slice(-4)}`
      : r.txHashOrOrderId;
    const body = [
      truncateLine(`DONE · ${r.summary}`, 62),
      truncateLine(`${r.beforeFact} -> ${r.afterFact}`, 62),
      truncateLine(`ID ${shortHash} · ${r.telegramPosted ? 'TG RECEIPT SENT' : 'LOCAL RECEIPT'}`, 62),
    ].join('\n');

    containers.push(
      {
        containerID: 1,
        containerName: 'cv_head',
        xPosition: 16,
        yPosition: 16,
        width: 544,
        height: 40,
        content: `CHAINVISION · CONFIRMED (${r.network.toUpperCase()})`,
        isEventCapture: 0,
        borderWidth: 0,
        borderColor: 0,
        borderRadius: 0,
        paddingLength: 2,
      },
      {
        containerID: 2,
        containerName: 'cv_main',
        xPosition: 16,
        yPosition: 64,
        width: 544,
        height: 148,
        content: body,
        isEventCapture: 1,
        borderWidth: 1,
        borderColor: 10,
        borderRadius: 4,
        paddingLength: 8,
      },
      {
        containerID: 3,
        containerName: 'cv_foot',
        xPosition: 16,
        yPosition: 222,
        width: 544,
        height: 44,
        content: 'DN: BLANK  ·  UP: POSITIONS  ·  2xTAP: EXIT',
        isEventCapture: 0,
        borderWidth: 0,
        borderColor: 0,
        borderRadius: 0,
        paddingLength: 2,
      },
    );
  } else if (state.mode === 'positions' && state.snapshots) {
    const s = state.snapshots;
    const idx = ((state.positionPageIndex ?? 0) % 4 + 4) % 4;
    let header = 'CHAINVISION · POSITIONS (TESTNET)';
    let body = '';

    if (idx === 0) {
      header = 'AAVE V3 SEPOLIA · 1/4';
      const hf = s.aave.healthFactor === null ? 'NO DEBT' : s.aave.healthFactor.toFixed(2);
      const hfRatio = s.aave.healthFactor === null ? 1 : Math.min(1, s.aave.healthFactor / 3);
      const usdcRate = s.aave.rates.find((r) => r.symbol === 'USDC');
      const eursRate = s.aave.rates.find((r) => r.symbol === 'EURS');
      const displayRate = usdcRate?.supplyCapReached && eursRate ? eursRate : usdcRate;
      body = [
        `HEALTH: ${hf}  ${renderBar(hfRatio, 10)}`,
        `COLLAT: ${fmtUsd(s.aave.totalCollateralUsd)}  DEBT: ${fmtUsd(s.aave.totalDebtUsd)}`,
        `TESTNET ${displayRate?.symbol ?? 'USDC'} APY: ${displayRate ? displayRate.supplyApyPct.toFixed(1) : '0.0'}%  USDC: ${s.aave.usdcBalance.toFixed(0)}`,
      ].join('\n');
    } else if (idx === 1) {
      header = 'HYPERLIQUID TESTNET · 2/4';
      const pos = s.hyperliquid.positions[0];
      if (pos) {
        const dist = pos.liqDistancePct !== null ? `${pos.liqDistancePct.toFixed(1)}%` : 'N/A';
        body = [
          `${pos.coin}-PERP ${pos.side} ${pos.leverage.toFixed(1)}x  SZ ${pos.size}`,
          `MARK ${fmtUsd(pos.markPx)}  LIQ DIST: ${dist}`,
          `UPNL: ${pos.unrealizedPnlUsd >= 0 ? '+' : ''}${fmtUsd(pos.unrealizedPnlUsd)}  EQ: ${fmtUsd(s.hyperliquid.accountValueUsd)}`,
        ].join('\n');
      } else {
        body = [
          `NO OPEN PERP POSITIONS`,
          `ETH MARK: ${fmtUsd(s.hyperliquid.ethMarkPx)}  BTC: ${fmtUsd(s.hyperliquid.btcMarkPx)}`,
          `ACCT EQUITY: ${fmtUsd(s.hyperliquid.accountValueUsd)}`,
        ].join('\n');
      }
    } else if (idx === 2) {
      header = 'UNISWAP V3 SEPOLIA · 3/4';
      const lp = s.uniswap.lpPositions[0];
      body = [
        `POOL ${s.uniswap.pair} (${s.uniswap.feeTier / 10000}% TESTNET)`,
        `TESTNET QUOTE: ${fmtUsd(s.uniswap.ethQuoteUsdc)}  TICK: ${s.uniswap.currentTick}`,
        lp
          ? `LP #${lp.tokenId}: ${lp.inRange ? 'IN RANGE' : 'OUT OF RANGE'} [${lp.tickLower},${lp.tickUpper}]`
          : `LP POSITIONS: 0  USDC/DAI: ${s.uniswap.usdcToDaiRate.toFixed(3)}`,
      ].join('\n');
    } else if (s.exchanges) {
      header = 'EXCHANGES (TESTNET) · 4/4';
      const { bybit, binance, coinbase } = s.exchanges;
      const usdt = binance.balances.find((b) => b.asset === 'USDT');
      const btc = binance.balances.find((b) => b.asset === 'BTC');
      body = [
        bybit.account
          ? `BYBIT TRADING ${fmtUsd(bybit.account.tradingAvailableUsd)} FREE  FUNDING ${bybit.account.fundingUsdt.toFixed(0)} USDT`
          : `BYBIT BTC ${fmtUsd(bybit.marks.BTC ?? 0)}  ACCOUNT: ${bybit.signed === 'skipped' ? 'NO KEY' : 'N/A'}`,
        binance.signed === 'ok'
          ? `BINANCE USDT ${(usdt?.free ?? 0).toFixed(0)}  BTC ${(btc?.free ?? 0).toFixed(4)}  ORD ${binance.openOrders.length}`
          : `BINANCE BTC ${fmtUsd(binance.prices.BTC ?? 0)}  ACCOUNT: ${binance.signed === 'skipped' ? 'NO KEY' : 'N/A'}`,
        `COINBASE BTC ${fmtUsd(coinbase.prices.BTC ?? 0)} (READ-ONLY)`,
      ].join('\n');
    } else {
      header = `${s.exchange.venue.toUpperCase()} · 4/4`;
      const exPos = s.exchange.positions[0];
      body = [
        `MODE: ${s.exchange.mode.toUpperCase()}  ETH: ${fmtUsd(s.exchange.ethMarkPx)}`,
        `FUNDING: ${s.exchange.ethFundingPct.toFixed(4)}%`,
        exPos
          ? `${exPos.symbol} ${exPos.side} ${exPos.size} UPNL ${fmtUsd(exPos.unrealizedPnlUsd)}`
          : `EQUITY: ${s.exchange.equityUsd !== null ? fmtUsd(s.exchange.equityUsd) : 'PUBLIC FEED'}`,
      ].join('\n');
    }

    containers.push(
      {
        containerID: 1,
        containerName: 'cv_head',
        xPosition: 16,
        yPosition: 16,
        width: 544,
        height: 40,
        content: truncateLine(header, 56),
        isEventCapture: 0,
        borderWidth: 0,
        borderColor: 0,
        borderRadius: 0,
        paddingLength: 2,
      },
      {
        containerID: 2,
        containerName: 'cv_main',
        xPosition: 16,
        yPosition: 64,
        width: 544,
        height: 148,
        content: sanitizeForG2(body),
        isEventCapture: 1,
        borderWidth: 1,
        borderColor: 8,
        borderRadius: 4,
        paddingLength: 8,
      },
      {
        containerID: 3,
        containerName: 'cv_foot',
        xPosition: 16,
        yPosition: 222,
        width: 544,
        height: 44,
        content: 'UP: NEXT  ·  HOLD: VOICE  ·  DN: BLANK',
        isEventCapture: 0,
        borderWidth: 0,
        borderColor: 0,
        borderRadius: 0,
        paddingLength: 2,
      },
    );
  } else {
    // Error or fallback card
    containers.push(
      {
        containerID: 1,
        containerName: 'cv_main',
        xPosition: 16,
        yPosition: 56,
        width: 544,
        height: 160,
        content: truncateLine(
          `CHAINVISION NOTICE\n${state.errorMessage ?? 'NO DATA YET · CHECK CONNECTION'}\nDN: BLANK  ·  UP: POSITIONS`,
          240,
        ),
        isEventCapture: 1,
        borderWidth: 1,
        borderColor: 8,
        borderRadius: 4,
        paddingLength: 8,
      },
    );
  }

  const totalChars = containers.reduce((sum, c) => sum + c.content.length, 0);
  return {
    mode: state.mode,
    containerTotalNum: containers.length,
    textObject: containers,
    totalChars,
  };
}

export function validateLensLayout(layout: LensPageLayout): LensValidationResult {
  const errors: string[] = [];

  if (layout.containerTotalNum !== layout.textObject.length) {
    errors.push(`containerTotalNum (${layout.containerTotalNum}) != textObject.length (${layout.textObject.length})`);
  }
  if (layout.containerTotalNum < 1 || layout.containerTotalNum > G2_MAX_CONTAINERS) {
    errors.push(`containerTotalNum (${layout.containerTotalNum}) must be 1..${G2_MAX_CONTAINERS}`);
  }
  if (layout.textObject.length > G2_MAX_TEXT_CONTAINERS) {
    errors.push(`text containers (${layout.textObject.length}) exceeds max ${G2_MAX_TEXT_CONTAINERS}`);
  }

  const eventCapturers = layout.textObject.filter((c) => c.isEventCapture === 1);
  if (eventCapturers.length !== 1) {
    errors.push(`Expected exactly 1 isEventCapture container, got ${eventCapturers.length}`);
  }

  let charCount = 0;
  for (const c of layout.textObject) {
    charCount += c.content.length;
    if (c.xPosition < 0 || c.yPosition < 0 || c.xPosition + c.width > G2_DISPLAY_WIDTH || c.yPosition + c.height > G2_DISPLAY_HEIGHT) {
      errors.push(`Container ${c.containerName} exceeds 576x288 bounds`);
    }
    if (hasEmoji(c.content)) {
      errors.push(`Container ${c.containerName} contains unsupported emoji`);
    }
    if (hasAdviceLanguage(c.content)) {
      errors.push(`Container ${c.containerName} contains prohibited financial-advice phrasing`);
    }
  }

  if (charCount > G2_MAX_CREATE_CHARS) {
    errors.push(`Total character count (${charCount}) exceeds ${G2_MAX_CREATE_CHARS}`);
  }

  if (layout.mode === 'idle' && charCount !== 0) {
    errors.push(`Idle screen must be blank (0 chars), got ${charCount}`);
  }

  return { valid: errors.length === 0, errors };
}
