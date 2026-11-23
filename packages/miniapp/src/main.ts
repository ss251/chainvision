import EthereumProvider from '@walletconnect/ethereum-provider';
import type { PairingSession, ProtocolSnapshots } from '@chainvision/shared';

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready: () => void;
        expand: () => void;
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

document.getElementById('btn-refresh')?.addEventListener('click', async () => {
  await fetch(`${API_BASE}/api/sync`, { method: 'POST' });
  await loadState();
});

void loadState();
