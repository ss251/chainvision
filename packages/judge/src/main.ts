import './style.css';
import { G2_DISPLAY_HEIGHT, G2_DISPLAY_WIDTH } from '@chainvision/shared';
import { fetchLivePublicPrices } from './feeds.js';
import {
  JUDGE_STEPS,
  JudgeWalkthrough,
  PROVENANCE_DEFINITIONS,
  VERIFIED_PROOFS,
  formatUtcTime,
  type JudgeSnapshot,
  type JudgeStepId,
  type ProvenanceKind,
} from './scenarios.js';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');

const walkthrough = new JudgeWalkthrough();

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtUsd(value: number): string {
  return value >= 1000 ? `$${value.toFixed(0)}` : `$${value.toFixed(2)}`;
}

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 10)}..${id.slice(-6)}` : id;
}

function badgeClass(kind: ProvenanceKind): string {
  if (kind === 'recorded') return 'badge badge-recorded';
  if (kind === 'live') return 'badge badge-live';
  return 'badge badge-sandbox';
}

function greenFor4Bit(level: number): string {
  const clamped = Math.max(0, Math.min(15, level));
  const alpha = (clamped / 15).toFixed(2);
  return `rgba(74, 222, 128, ${alpha})`;
}

function renderLensContainers(snap: JudgeSnapshot): string {
  const containersHtml = snap.layout.textObject
    .map((c) => {
      const border =
        c.borderWidth > 0 ? `${c.borderWidth}px solid ${greenFor4Bit(c.borderColor || 10)}` : 'none';
      const style = [
        `left:${c.xPosition}px`,
        `top:${c.yPosition}px`,
        `width:${c.width}px`,
        `height:${c.height}px`,
        `padding:${c.paddingLength}px`,
        `border:${border}`,
        `border-radius:${c.borderRadius}px`,
      ].join(';');
      return `<div class="g2-container" data-container="${escapeHtml(c.containerName)}" style="${style}">${escapeHtml(c.content)}</div>`;
    })
    .join('');

  const idleHint =
    snap.lensState.mode === 'idle'
      ? '<span class="g2-idle-hint">576x288 G2 WAVEGUIDE · 0 LIT PIXELS</span>'
      : '';

  return `<div class="g2-lens" role="region" aria-label="Even G2 576 by 288 monochrome lens">${containersHtml}${idleHint}</div>`;
}

function render(snap: JudgeSnapshot): void {
  const prices = walkthrough.getPrices();
  const isLive = prices.feedState === 'live' && prices.liveSources.length > 0 && prices.updatedAt !== null;
  const dotClass = isLive ? 'dot live' : prices.feedState === 'unavailable' ? 'dot stale' : 'dot';
  const feedLabel = isLive
    ? `${PROVENANCE_DEFINITIONS.live.label} · ${formatUtcTime(prices.updatedAt!)} (${prices.liveSources.join(', ')})`
    : prices.feedState === 'unavailable'
      ? `Last recorded public prices (${prices.fallbackRecordedAt}) · live feeds unavailable`
      : `Last recorded public prices (${prices.fallbackRecordedAt}) · loading live feeds...`;

  const legendHtml = (['recorded', 'live', 'example'] as const)
    .map(
      (kind) => `
      <div class="legend-item">
        <span class="${badgeClass(kind)}">${escapeHtml(PROVENANCE_DEFINITIONS[kind].label)}</span>
        <p>${escapeHtml(PROVENANCE_DEFINITIONS[kind].description)}</p>
      </div>
    `,
    )
    .join('');

  const stepsHtml = JUDGE_STEPS.map((s) => {
    const active = s.id === snap.step.id ? ' active' : '';
    const done = snap.resolvedSteps.includes(s.id)
      ? '<span class="step-done-mark">DONE</span>'
      : '';
    return `
      <button type="button" class="step-btn${active}" data-step="${s.id}">
        <div class="step-top"><span>${escapeHtml(s.label)}</span>${done}</div>
        <div class="step-track">${escapeHtml(s.track)}</div>
      </button>
    `;
  }).join('');

  const telegramHtml = snap.telegramMessages.length
    ? snap.telegramMessages
        .map(
          (m) => `
        <div class="tg-bubble">
          <div class="tg-meta">@evenchainvisionbot -> ${escapeHtml(m.recipient)} · ${escapeHtml(m.title)}</div>
          ${m.lines.map((l) => `<div class="tg-line">${escapeHtml(l)}</div>`).join('')}
          ${
            m.explorerUrl
              ? `<div style="margin-top:6px"><a href="${escapeHtml(m.explorerUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(m.explorerLabel ?? 'View Explorer')} -></a></div>`
              : ''
          }
        </div>
      `,
        )
        .join('')
    : '<p class="tg-empty">No Telegram message sent on this step. Recorded testnet steps show their recorded receipt after tapping.</p>';

  const proofsRows = VERIFIED_PROOFS.map(
    (p) => `
      <tr>
        <td><strong>${escapeHtml(p.action)}</strong><br /><span style="color:var(--muted);font-size:12px">${escapeHtml(p.details)}</span></td>
        <td class="mono">${escapeHtml(p.network)}</td>
        <td class="mono">${escapeHtml(p.recordedAt)}</td>
        <td class="mono"><a href="${escapeHtml(p.explorerUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shortId(p.txOrOrderId))} (${escapeHtml(p.explorerLabel)})</a></td>
      </tr>
    `,
  ).join('');

  const nextIdx = (JUDGE_STEPS.findIndex((s) => s.id === snap.step.id) + 1) % JUDGE_STEPS.length;
  const nextLabel = JUDGE_STEPS[nextIdx]!.label;

  root!.innerHTML = `
    <main class="page">
      <header class="header">
        <div>
          <p class="eyebrow">Even Realities G2 · No-Key 60-Second Judge Walkthrough</p>
          <h1>ChainVision</h1>
          <p class="subtitle">
            Blank until real risk breaches or a contact asks to be paid, then one ranked line resolved in one tap.
            Runs from the repository with one command — no API keys required.
          </p>
        </div>
        <div class="safety-pill">
          <strong>Testnet only · Non-custodial · No secrets</strong>
          No mainnet keys or financial advice. Every lens frame below is rendered by <code>@chainvision/shared</code> and checked against G2 limits and the 60-character line ceiling.
        </div>
      </header>

      <section class="legend-strip" aria-label="Provenance label definitions">
        ${legendHtml}
      </section>

      <section class="feed-strip" aria-label="Public market feeds">
        <span class="feed-status"><span class="${dotClass}"></span>${escapeHtml(feedLabel)}</span>
        <span class="feed-item">HL ETH <b>${fmtUsd(prices.hlEth)}</b></span>
        <span class="feed-item">Bybit BTC <b>${fmtUsd(prices.bybitBtc)}</b></span>
        <span class="feed-item">Binance Testnet BTC <b>${fmtUsd(prices.binanceBtc)}</b></span>
        <span class="feed-item">Coinbase BTC <b>${fmtUsd(prices.coinbaseBtc)}</b></span>
        <button type="button" class="btn btn-secondary" id="btn-refresh-feeds">Refresh Feeds</button>
      </section>

      <nav class="step-nav" aria-label="60-second walkthrough steps">
        ${stepsHtml}
      </nav>

      <section class="stage">
        <div class="lens-card">
          <div class="lens-header">
            <span>EXACT G2 DISPLAY (${G2_DISPLAY_WIDTH} x ${G2_DISPLAY_HEIGHT} MONOCHROME GREEN)</span>
            <span>MODE: ${escapeHtml(snap.lensState.mode.toUpperCase())}</span>
          </div>

          <div class="lens-viewport-wrap">
            <div class="lens-bezel">
              ${renderLensContainers(snap)}
            </div>
          </div>

          <div class="validator-bar">
            <span class="${snap.validation.valid ? 'validator-ok' : 'validator-err'}">
              ${snap.validation.valid ? 'LAYOUT VALID' : 'LAYOUT INVALID: ' + escapeHtml(snap.validation.errors.join('; '))}
            </span>
            <span>${snap.litChars}/1000 chars · ${snap.layout.containerTotalNum}/12 containers · max line ${snap.lensLineLength}/60</span>
          </div>

          <div class="controls" aria-label="G2 temple gesture controls">
            <button type="button" class="btn btn-primary" id="btn-tap">Single Tap · Confirm / Act</button>
            <button type="button" class="btn" id="btn-next">Next Step -> ${escapeHtml(nextLabel)}</button>
            <button type="button" class="btn" id="btn-down">Swipe Down · Dismiss / Decline</button>
            <button type="button" class="btn" id="btn-up">Swipe Up · Cycle Positions</button>
          </div>

          <div class="btn-row">
            <button type="button" class="btn btn-secondary" id="btn-brief">Hold Temple: "What matters?"</button>
            <button type="button" class="btn btn-secondary" id="btn-voice-order">Voice: "Buy 0.001 BTC" (2-venue card)</button>
            <button type="button" class="btn btn-secondary" id="btn-reset">Reset Queue</button>
          </div>

          <p class="action-note">${escapeHtml(snap.lastActionNote)}</p>
        </div>

        <aside class="info-card">
          <span class="${badgeClass(snap.provenance.kind)}" data-provenance="${snap.provenance.kind}">${escapeHtml(snap.provenance.badgeText)}</span>
          <h2>${escapeHtml(snap.step.shortTitle)}</h2>
          <p>${escapeHtml(snap.provenance.detail)}</p>

          <div class="try-box">
            <strong>Try on this step</strong>
            ${escapeHtml(snap.step.whatToTry)}
          </div>

          ${
            snap.provenance.proofUrl
              ? `<div class="proof-link-box">
                  <span>Explorer Proof</span>
                  <a href="${escapeHtml(snap.provenance.proofUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(snap.provenance.proofLabel ?? 'Open Explorer')} -></a>
                </div>`
              : ''
          }

          <div class="tg-section">
            <h3 class="tg-heading">Telegram Bot Receipt</h3>
            ${telegramHtml}
          </div>
        </aside>
      </section>

      <section class="proofs-panel" aria-label="Recorded testnet proofs">
        <h3>Recorded Testnet Proofs (PR #6, commit <code>12871f3</code>)</h3>
        <p class="sub">
          Sepolia transactions were checked against Sepolia on-chain data (block, timestamp, method, and token transfers match).
          The Hyperliquid fill matches order <code>65942782652</code> (reduce-only IOC sell of <code>0.0181 ETH</code> at <code>$1,653.7</code>, <code>2026-11-25 06:31:07 UTC</code>, position <code>0.0363 -> 0.0182</code>) and links directly to the fill transaction in the Hyperliquid Testnet Explorer SPA.
          Signed Bybit/Binance writes and TON payouts await testnet keys and faucet coins from the owner.
        </p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Network</th>
                <th>Recorded</th>
                <th>Explorer Link</th>
              </tr>
            </thead>
            <tbody>
              ${proofsRows}
            </tbody>
          </table>
        </div>
      </section>

      <footer class="footer">
        <span>Keyboard: Enter = Single Tap · ArrowDown = Swipe Down · ArrowUp = Swipe Up · V = Voice Brief</span>
        <span>ChainVision · Track 03 Exchanges &amp; Stocks · Track 02 Crypto &amp; DeFi · Best Telegram Integration</span>
      </footer>
    </main>
  `;

  root!.querySelectorAll<HTMLButtonElement>('[data-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.step as JudgeStepId;
      render(walkthrough.selectStep(id));
    });
  });

  document.getElementById('btn-tap')?.addEventListener('click', () => render(walkthrough.tap()));
  document.getElementById('btn-next')?.addEventListener('click', () => render(walkthrough.nextStep()));
  document.getElementById('btn-down')?.addEventListener('click', () => render(walkthrough.swipeDown()));
  document.getElementById('btn-up')?.addEventListener('click', () => render(walkthrough.swipeUp()));
  document.getElementById('btn-brief')?.addEventListener('click', () => render(walkthrough.triggerVoiceBrief()));
  document
    .getElementById('btn-voice-order')
    ?.addEventListener('click', () => render(walkthrough.triggerVoiceBinanceCard()));
  document.getElementById('btn-reset')?.addEventListener('click', () => render(walkthrough.resetQueue()));
  document.getElementById('btn-refresh-feeds')?.addEventListener('click', () => {
    void refreshFeeds();
  });
}

async function refreshFeeds(): Promise<void> {
  const next = await fetchLivePublicPrices(walkthrough.getPrices());
  render(walkthrough.updatePrices(next));
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.key === 'Enter' || e.key === ' ') {
    if (document.activeElement instanceof HTMLButtonElement) return;
    e.preventDefault();
    render(walkthrough.tap());
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    render(walkthrough.swipeDown());
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    render(walkthrough.swipeUp());
  } else if (e.key.toLowerCase() === 'v') {
    render(walkthrough.triggerVoiceBrief());
  }
});

render(walkthrough.snapshot());
void refreshFeeds();
setInterval(() => {
  void refreshFeeds();
}, 30_000);
