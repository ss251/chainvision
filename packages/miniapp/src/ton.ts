import { CHAIN, THEME, TonConnectUI, toUserFriendlyAddress, type ConnectedWallet } from '@tonconnect/ui';
import { formatTon } from '@chainvision/shared';

const API_BASE = window.location.origin.startsWith('http') ? window.location.origin : 'http://127.0.0.1:8787';

interface TonStatus {
  testWallet: { address: string | null; balanceNano: string | null; state: string | null; error?: string } | null;
  connected: { address: string; balanceNano: string | null } | null;
  mainnet: { address: string; balanceNano: string | null; readOnly: true } | null;
}

const card = document.createElement('div');
card.className = 'card';
card.innerHTML = `
  <h2>TON Testnet · TON Connect</h2>
  <div class="status">Connect a TON wallet that is in testnet mode, for example Tonkeeper with its testnet switched on. ChainVision only reads this wallet's balance for the brief on your glasses; it never asks it to sign anything. Telegram's built-in wallet runs on mainnet only, so it cannot connect here.</div>
  <div id="ton-connect" style="margin-top:10px"></div>
  <div id="ton-status" class="status">Not connected</div>
  <div id="ton-app-wallet" class="status"></div>`;
const anchor = document.getElementById('live-snap')?.closest('.card');
if (anchor?.parentElement) anchor.parentElement.insertBefore(card, anchor);
else document.body.appendChild(card);

const statusEl = card.querySelector('#ton-status') as HTMLElement;
const appWalletEl = card.querySelector('#ton-app-wallet') as HTMLElement;

function balanceText(nano: string | null | undefined): string {
  return nano === null || nano === undefined ? 'balance unavailable' : `${formatTon(nano)} TON`;
}

async function loadTonStatus(): Promise<void> {
  try {
    const s = (await fetch(`${API_BASE}/api/ton`).then((r) => r.json())) as TonStatus;
    const w = s.testWallet;
    appWalletEl.textContent = w?.address
      ? `App's own test wallet (pays TON requests you approve with a tap): ${w.address} · ${balanceText(w.balanceNano)}`
      : "App's own test wallet: not configured on the server";
    if (s.connected) statusEl.textContent = `Connected (testnet, read-only): ${s.connected.address} · ${balanceText(s.connected.balanceNano)}`;
  } catch (err) {
    appWalletEl.textContent = `Server unreachable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function report(wallet: ConnectedWallet | null): Promise<void> {
  const body = wallet ? { address: wallet.account.address, chain: wallet.account.chain } : {};
  const res = await fetch(`${API_BASE}/api/ton/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; connected?: { address: string; balanceNano: string | null } | null; error?: string };
  if (!wallet) statusEl.textContent = 'Not connected';
  else if (!data.ok) statusEl.textContent = data.error ?? 'Could not connect';
  else if (data.connected) statusEl.textContent = `Connected (testnet, read-only): ${data.connected.address} · ${balanceText(data.connected.balanceNano)}`;
}

try {
  const ui = new TonConnectUI({
    manifestUrl: `${API_BASE}/miniapp/tonconnect-manifest.json`,
    buttonRootId: 'ton-connect',
    uiPreferences: { theme: THEME.DARK },
  });
  ui.setConnectionNetwork(CHAIN.TESTNET);
  ui.onStatusChange(
    (wallet) => {
      if (wallet) statusEl.textContent = `Connected: ${toUserFriendlyAddress(wallet.account.address, true)}, reading balance...`;
      void report(wallet).catch((err: unknown) => {
        statusEl.textContent = `Server unreachable: ${err instanceof Error ? err.message : String(err)}`;
      });
    },
    (err) => {
      statusEl.textContent = /network/i.test(err.message)
        ? 'That wallet is on mainnet. Switch it to testnet and connect again.'
        : `TON Connect: ${err.message}`;
    },
  );
} catch (err) {
  statusEl.textContent = `TON Connect unavailable: ${err instanceof Error ? err.message : String(err)}`;
}

void loadTonStatus();
