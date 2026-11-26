# ChainVision — Judge Guide (60-Second Evaluation)

**Quiet, non-custodial crypto, exchange, and Telegram action HUD for Even Realities G2**  
**Tracks:** Track 03 · Exchanges & Stocks · Track 02 · Crypto & DeFi · Best Telegram Integration

---

## 1. Try It in 60 Seconds (Zero Keys, Zero Install)

ChainVision ships a standalone zero-key `/judge` web walkthrough (`packages/judge`) that runs the real `@chainvision/shared` `renderLensPage()` and `validateLensLayout()` against an exact `576 × 288` Even G2 monochrome lens, live public read-only price feeds (Hyperliquid Testnet, Bybit Testnet, Binance Spot Testnet, Coinbase Public), and recorded real testnet proofs.

1. **Blank lens (`0` lit pixels):** confirms G2 waveguides stay completely clear (`0/1000` chars) when nothing needs attention.
2. **Exchange margin line -> one-tap move:** `BYBIT MARGIN LOW - TAP: MOVE 500 USDT FUNDING TO TRADING` (live Bybit/Coinbase public prices + clearly labeled sandbox transfer replay, since no API keys live in a static page).
3. **Hyperliquid liquidation line -> one-tap trim:** `HL ETH LONG LIQ ~4m (6.0%) - TAP: TRIM 50% ETH` (live HL testnet mark + time-to-liquidation ETA + recorded real `sim:demo` reduce-only trim order `65942782652`).
4. **Telegram money request -> tap to pay:** `KIT ASKS 20 USDC - TAP: PAY` (recorded real `sim:demo` Sepolia transfer `0xc453a91d…d8178d` with dual Telegram receipts, or swipe down to decline politely).
5. **Voice brief (`"What matters?"`):** ranks remaining unresolved signals (`<= 3` lines, or `NOTHING NEEDS YOU` once cleared), plus a one-click two-venue voice limit order card (`BINANCE TESTNET $… | COINBASE $…`) using live public prices.

```bash
# Run locally with zero API keys:
npm install && npm run dev:judge        # http://127.0.0.1:5175/judge

# Or build the static bundle (packages/judge/dist serves both / and /judge):
npm run build:judge
```

---

## 2. Packaged `.ehpk` Build & Simulator

```bash
npm run pack:ehpk      # builds packages/glasses and packs + validates chainvision.ehpk against app.json
```

- Manifest: `packages/glasses/app.json` (`com.chainvision.g2` v`0.1.0`, `min_app_version: 2.2.10`, `min_sdk_version: 0.0.16`, single whitelisted backend origin).
- `*.ehpk` is gitignored rather than committed as a repo binary; attach `chainvision.ehpk` to the GitHub Release via `gh release create` (see [README.md](./README.md#6-packaged-build-chainvisionehpk)).
- Local verification without hardware: `npm run build && npm run typecheck && npm test` (and `npm run sim` with `@evenrealities/evenhub-simulator@0.9.5`).

---

## 3. Verified Testnet Proofs

Every transaction and order below was executed by ChainVision on live testnets during PR #6 (`12871f3`) verification (`verify:testnet` and `sim:demo` in `evenhub-simulator@0.9.5`). All explorer links were checked live and return HTTP 200.

| Action | Network | Recorded Run | Proof (Explorer) |
| --- | --- | --- | --- |
| Aave v3 loan repay (5 USDC) | Ethereum Sepolia | `verify:testnet` · 2026-11-25 06:28:36 UTC (block `12207803`) | [`0x8b6b4210…04ea0c`](https://sepolia.etherscan.io/tx/0x8b6b4210ac28750395a242f578369421183315906f18e2ab3ddf68e1f904ea0c) |
| Uniswap v3 swap (5 USDC -> 17.15 DAI) | Ethereum Sepolia | `verify:testnet` · 2026-11-25 06:28:48 UTC (block `12207804`) | [`0x784a80d4…6b0578`](https://sepolia.etherscan.io/tx/0x784a80d485cf97a27b84909f4290871b4a9e009b19612de3cbdde151ba6b0578) |
| Telegram `/ask 2 USDC` payout to Kit | Ethereum Sepolia | `verify:testnet` · 2026-11-25 06:29:00 UTC (block `12207805`, TG msg 32) | [`0xa0dee545…4b68be`](https://sepolia.etherscan.io/tx/0xa0dee5452b95d4fcfabeefb13947d8a1d25b10d067baea07608f219dde4b68be) |
| Telegram `/ask 20 USDC` payout to Kit | Ethereum Sepolia | `sim:demo` · 2026-11-25 06:31:24 UTC (block `12207816`) | [`0xc453a91d…d8178d`](https://sepolia.etherscan.io/tx/0xc453a91d030307a604667169047689f8703f8cc98de4281c4a33fa5252d8178d) |
| Hyperliquid ETH-PERP 50% reduce-only trim (`0.0363 -> 0.0182` ETH) | Hyperliquid Testnet | `sim:demo` · 2026-11-25 (non-withdrawable `source: "b"` agent) | [`Order 65942782652` (HL Testnet Explorer)](https://app.hyperliquid-testnet.xyz/explorer) |

*Honest status on remaining rails:* public Bybit testnet, Binance spot testnet, and Coinbase reads run live (`verify:exchanges` passes 6/6 public checks), while signed Bybit/Binance writes skip until testnet API keys are supplied; TON testnet wallet [`0QDNtIy-zwHMK5hdc0qVZoi2TkfZr_O3MjXcrq0H8QVdAYHl`](https://testnet.tonviewer.com/0QDNtIy-zwHMK5hdc0qVZoi2TkfZr_O3MjXcrq0H8QVdAYHl) reads live on toncenter testnet and awaits test coins from `@testgiver_ton_bot` for an on-chain TON payout proof.

---

## 4. What Existed Before 23 Nov

**Nothing.** This repository was initialized empty on **23 Nov 2026** for the Heads Up hackathon. All ChainVision application code, protocol integrations, signal queue, safety guards, glasses UI, Mini App, judge walkthrough, and unit tests were authored during the hackathon window using standard open-source dependencies (`@evenrealities/even_hub_sdk`, `viem`, `@msgpack/msgpack`, `@ton/ton`, `@tonconnect/ui`, `@walletconnect/ethereum-provider`, `zod`, `ws`, `vite`, `vitest`, `whisper.cpp`).

---

## 5. Safety Model (5 Lines)

1. **Testnet only:** `assertSepoliaOnly(11155111)`, `assertExchangeHost` (`api-testnet.bybit.com` / `testnet.binance.vision`), toncenter testnet endpoint checks, and Hyperliquid EIP-712 `source: "b"` hardcode testnet execution so signatures cannot replay on mainnet.
2. **Non-withdrawable Hyperliquid agent:** perp trims sign through a dedicated API agent wallet restricted to `reduceOnly: true` orders with no withdrawal path anywhere in the codebase.
3. **Hard caps and allowlists:** every EVM, exchange, and Telegram payout is bounded per action and per rolling 24 hours (persisted in mode-600 local state files), restricted to allowlisted Sepolia contracts and wearer-approved requester addresses.
4. **Explicit tap-to-confirm and zero advice:** nothing executes without a live `glasses_tap` on the shown signal (1.5 s tap lockout) or offline two-tap Telegram fallback; `validateLensLayout()` rejects financial-advice phrasing and emoji.
5. **No mainnet keys or committed secrets:** ChainVision never asks for a mainnet signing key, never custodies user funds, keeps secret fields non-enumerable in `AppConfig`, and stores zero keys in git, logs, or `/judge`.

---

## 6. Five API Feature Requests for Sponsors

1. **Even Realities:** a wake/priority notification channel for critical financial alerts so a blank lens can stay unloaded until a threshold breaches.
2. **Even Realities:** simulator IMU mocking (`imuData`) and left/right temple / R1 ring `eventSource` selection for automated CI testing.
3. **Hyperliquid:** a keyless or lightweight Sepolia-like testnet faucet flow for hackathon builders who do not hold prior mainnet deposit history.
4. **Hyperliquid:** native per-order notional caps enforced on-chain for API Agent Wallets in addition to the existing non-withdrawable guarantee.
5. **Telegram:** direct one-click pairing hand-off from embedded mobile WebViews without requiring manual 6-digit code copy/paste.
