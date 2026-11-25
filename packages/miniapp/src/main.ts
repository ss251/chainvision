import EthereumProvider from '@walletconnect/ethereum-provider';
import {
  describeRule,
  formatUsdc,
  type MoneyRequest,
  type PairingSession,
  type PriceAlertRule,
  type ProtocolSnapshots,
  type Requester,
} from '@chainvision/shared';
import './ton.js';

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready: () => void;
        expand: () => void;
        initData?: string;
        initDataUnsafe?: { user?: { id?: number; username?: string } };
      };
    };
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      isTrust?: boolean;
    };
    trustwallet?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

const API_BASE = window.location.origin.startsWith('http')
  ? window.location.origin
  : 'http://127.0.0.1:8787';

const walletAddrInput = document.getElementById('wallet-addr') as HTMLInputElement;
const pairCodeInput = document.getElementById('pair-code') as HTMLInputElement;
const tgChatInput = document.getElementById('tg-chat-id') as HTMLInputElement;
const walletStatusEl = document.getElementById('wallet-status')!;
const wcDeepLinkEl = document.getElementById('wc-deeplink')!;
const saveStatusEl = document.getElementById('save-status')!;
const liveSnapEl = document.getElementById('live-snap')!;

const thAaveHf = document.getElementById('th-aave-hf') as HTMLInputElement;
const thAaveRepay = document.getElementById('th-aave-repay') as HTMLInputElement;
const thHlLiq = document.getElementById('th-hl-liq') as HTMLInputElement;
const thHlTrim = document.getElementById('th-hl-trim') as HTMLInputElement;
const thCapUsd = document.getElementById('th-cap-usd') as HTMLInputElement;
const thCapEth = document.getElementById('th-cap-eth') as HTMLInputElement;
const thReqCap = document.getElementById('th-req-cap') as HTMLInputElement;
const thReqDaily = document.getElementById('th-req-daily') as HTMLInputElement;

let walletConnectProjectId: string | null = null;

// Initialize Telegram WebApp SDK if launched inside Telegram
if (window.Telegram?.WebApp) {
  window.Telegram.WebApp.ready();
  window.Telegram.WebApp.expand();
  const uid = window.Telegram.WebApp.initDataUnsafe?.user?.id;
  if (uid) {
    tgChatInput.value = String(uid);
  }
}

async function loadState(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/state`);
    const data = (await res.json()) as {
      session: PairingSession;
      state: { snapshots?: ProtocolSnapshots | null };
      walletConnectProjectId?: string | null;
    };
    walletConnectProjectId = data.walletConnectProjectId ?? null;
    if (data.session.walletAddress && !walletAddrInput.value) {
      walletAddrInput.value = data.session.walletAddress;
    }
    if (data.session.telegramChatId && !tgChatInput.value) {
      tgChatInput.value = data.session.telegramChatId;
    }
    thAaveHf.value = String(data.session.thresholds.aaveMinHealthFactor);
    thAaveRepay.value = String(data.session.thresholds.aaveDefaultRepayUsdc);
    thHlLiq.value = String(data.session.thresholds.hlMinLiqDistancePct);
    thHlTrim.value = String(data.session.thresholds.hlDefaultTrimPct);
    thCapUsd.value = String(data.session.thresholds.maxSingleActionUsd);
    thCapEth.value = String(data.session.thresholds.maxEvmSwapEth);
    thReqCap.value = String(data.session.thresholds.maxRequestUsdc);
    thReqDaily.value = String(data.session.thresholds.dailyRequestUsdc);

    const s = data.state.snapshots;
    if (s) {
      const hf = s.aave.healthFactor === null ? 'No debt' : s.aave.healthFactor.toFixed(2);
      const hlPos = s.hyperliquid.positions[0];
      liveSnapEl.innerHTML = [
        `<strong>Aave v3 Sepolia:</strong> Health ${hf} · Collat $${s.aave.totalCollateralUsd.toFixed(2)} · Debt $${s.aave.totalDebtUsd.toFixed(2)}`,
        `<strong>Uniswap v3 Sepolia:</strong> WETH/USDC quote $${s.uniswap.ethQuoteUsdc.toFixed(2)} · LP positions: ${s.uniswap.lpPositions.length}`,
        `<strong>Hyperliquid Testnet:</strong> ETH $${s.hyperliquid.ethMarkPx.toFixed(2)} · ${hlPos ? `${hlPos.coin} ${hlPos.side} ${hlPos.size}` : '0 open perps'}`,
        `<strong>Exchange (${s.exchange.venue}):</strong> ETH $${s.exchange.ethMarkPx.toFixed(2)} · Mode ${s.exchange.mode}`,
      ].join('<br/>');
    } else {
      liveSnapEl.textContent = 'Waiting for initial testnet poll...';
    }
  } catch (err) {
    liveSnapEl.textContent = `Server unreachable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

document.getElementById('btn-wc')?.addEventListener('click', async () => {
  if (!walletConnectProjectId) {
    walletStatusEl.textContent =
      'Set WALLETCONNECT_PROJECT_ID on server for WalletConnect QR, or use Browser/Trust Wallet Extension below.';
    return;
  }
  try {
    walletStatusEl.textContent = 'Initializing WalletConnect v2 (Sepolia 11155111)...';
    const provider = await EthereumProvider.init({
      projectId: walletConnectProjectId,
      chains: [11155111],
      showQrModal: true,
      metadata: {
        name: 'ChainVision G2 (Testnet)',
        description: 'Non-custodial testnet crypto HUD for Even Realities G2',
        url: API_BASE,
        icons: [],
      },
    });
    provider.on('display_uri', (uri: string) => {
      const deep = `trust://wc?uri=${encodeURIComponent(uri)}`;
      wcDeepLinkEl.innerHTML = `<a class="deep" href="${deep}">Open directly in Trust Wallet mobile</a>`;
    });
    const accounts = (await provider.enable()) as string[];
    if (accounts[0]) {
      walletAddrInput.value = accounts[0];
      walletStatusEl.textContent = `Connected via WalletConnect (Sepolia): ${accounts[0]}`;
    }
  } catch (err) {
    walletStatusEl.textContent = `WalletConnect cancelled/error: ${err instanceof Error ? err.message : String(err)}`;
  }
});

document.getElementById('btn-injected')?.addEventListener('click', async () => {
  const eth = window.trustwallet ?? window.ethereum;
  if (!eth) {
    walletStatusEl.textContent = 'No injected Trust Wallet / EVM extension detected. Paste a Sepolia 0x address above.';
    return;
  }
  try {
    // Switch to Sepolia (0xaa36a7)
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] });
    } catch {
      // ignore if wallet does not support switch
    }
    const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
    if (accounts[0]) {
      walletAddrInput.value = accounts[0];
      walletStatusEl.textContent = `Connected (${eth === window.trustwallet || window.ethereum?.isTrust ? 'Trust Wallet' : 'EVM'} · Sepolia): ${accounts[0]}`;
    }
  } catch (err) {
    walletStatusEl.textContent = `Wallet connect error: ${err instanceof Error ? err.message : String(err)}`;
  }
});

document.getElementById('btn-save')?.addEventListener('click', async () => {
  saveStatusEl.textContent = 'Saving and pairing...';
  try {
    const res = await fetch(`${API_BASE}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: pairCodeInput.value.trim() || undefined,
        walletAddress: walletAddrInput.value.trim() || undefined,
        telegramChatId: tgChatInput.value.trim() || undefined,
        thresholds: {
          aaveMinHealthFactor: Number(thAaveHf.value),
          aaveDefaultRepayUsdc: Number(thAaveRepay.value),
          hlMinLiqDistancePct: Number(thHlLiq.value),
          hlDefaultTrimPct: Number(thHlTrim.value),
          maxSingleActionUsd: Number(thCapUsd.value),
          maxEvmSwapEth: Number(thCapEth.value),
          maxRequestUsdc: Number(thReqCap.value),
          dailyRequestUsdc: Number(thReqDaily.value),
        },
      }),
    });
    const data = (await res.json()) as { ok: boolean; message?: string; error?: string };
    saveStatusEl.textContent = data.ok
      ? data.message ?? 'Paired and saved!'
      : data.message ?? data.error ?? 'Pairing failed';
    await loadState();
  } catch (err) {
    saveStatusEl.textContent = `Save error: ${err instanceof Error ? err.message : String(err)}`;
  }
});

const alertListEl = document.getElementById('alert-list')!;
const alertStatusEl = document.getElementById('alert-status')!;

async function loadAlerts(): Promise<void> {
  try {
    const data = (await fetch(`${API_BASE}/api/alerts`).then((r) => r.json())) as { rules: PriceAlertRule[] };
    alertListEl.replaceChildren();
    if (data.rules.length === 0) {
      alertListEl.textContent = 'No alerts set.';
      return;
    }
    for (const rule of data.rules) {
      const row = document.createElement('div');
      row.className = 'rule';
      const label = document.createElement('span');
      label.textContent = `${describeRule(rule)} (set by ${rule.createdVia}, price then ${rule.referencePrice})`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'secondary';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        await fetch(`${API_BASE}/api/alerts/remove`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: rule.id }),
        });
        await loadAlerts();
      });
      row.append(label, remove);
      alertListEl.append(row);
    }
  } catch (err) {
    alertListEl.textContent = `Alerts unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

document.getElementById('btn-alert-add')?.addEventListener('click', async () => {
  const asset = (document.getElementById('alert-asset') as HTMLSelectElement).value;
  const direction = (document.getElementById('alert-direction') as HTMLSelectElement).value;
  const price = Number((document.getElementById('alert-price') as HTMLInputElement).value);
  const data = (await fetch(`${API_BASE}/api/alerts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ asset, direction, price }),
  }).then((r) => r.json())) as { ok: boolean; reason?: string; rule?: PriceAlertRule };
  alertStatusEl.textContent = data.ok && data.rule ? `Alert set: ${describeRule(data.rule)}` : (data.reason ?? 'Could not set alert');
  await loadAlerts();
});

const requesterListEl = document.getElementById('requester-list')!;
const requestLogEl = document.getElementById('request-log')!;

function wearerHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = json ? { 'content-type': 'application/json' } : {};
  const initData = window.Telegram?.WebApp?.initData;
  if (initData) headers['x-telegram-init-data'] = initData;
  return headers;
}

async function loadRequesters(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/requesters`, { headers: wearerHeaders() });
    const data = (await res.json()) as {
      ok: boolean;
      error?: string;
      requesters?: Requester[];
      requests?: MoneyRequest[];
      paidLast24hUsdc?: number;
    };
    if (!data.ok || !data.requesters) {
      requesterListEl.textContent = data.error ?? 'Requesters unavailable';
      return;
    }
    requesterListEl.replaceChildren();
    if (data.requesters.length === 0) requesterListEl.textContent = 'Nobody has registered yet.';
    for (const r of data.requesters) {
      const row = document.createElement('div');
      row.className = 'rule';
      const label = document.createElement('span');
      label.textContent = `${r.name}${r.username ? ` @${r.username}` : ''} · ${r.address} · ${r.status}`;
      row.append(label);
      const actions: Array<[string, string]> = r.status === 'approved' ? [['Remove', 'remove']] : [['Approve', 'approve'], ['Remove', 'remove']];
      for (const [text, verb] of actions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = verb === 'approve' ? '' : 'secondary';
        btn.textContent = text;
        btn.addEventListener('click', async () => {
          await fetch(`${API_BASE}/api/requesters/${verb}`, {
            method: 'POST',
            headers: wearerHeaders(true),
            body: JSON.stringify({ telegramUserId: r.telegramUserId }),
          });
          await loadRequesters();
        });
        row.append(btn);
      }
      requesterListEl.append(row);
    }
    const names = new Map(data.requesters.map((r) => [r.telegramUserId, r.name]));
    requestLogEl.textContent = [
      `Paid in the last 24 h: ${formatUsdc(data.paidLast24hUsdc ?? 0)} USDC`,
      ...(data.requests ?? []).slice(0, 5).map(
        (q) => `${names.get(q.requesterId) ?? q.requesterId}: ${formatUsdc(q.amount)} USDC · ${q.status}${q.txHash ? ` · ${q.txHash.slice(0, 10)}..` : ''}`,
      ),
    ].join(' | ');
  } catch (err) {
    requesterListEl.textContent = `Requesters unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

document.getElementById('btn-refresh')?.addEventListener('click', async () => {
  await fetch(`${API_BASE}/api/sync`, { method: 'POST' });
  await loadState();
});

void loadState();
void loadAlerts();
void loadRequesters();
