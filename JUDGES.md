# ChainVision — Judge Guide (60-Second Evaluation)

**Quiet, non-custodial crypto, exchange, and Telegram action HUD for Even Realities G2**  
**Tracks:** Track 03 · Exchanges & Stocks · Track 02 · Crypto & DeFi · Best Telegram Integration

---

## 1. Try It Locally in 60 Seconds (No API Keys)

ChainVision ships a standalone `/judge` walkthrough (`packages/judge`) that **runs from the repository with one command** and needs **no API keys**. It renders the exact `576 × 288` Even G2 monochrome lens through `@chainvision/shared`'s `renderLensPage()` and checks every frame against G2 limits and the 60-character line ceiling. Every step uses one of three labels defined on the page (**recorded from a real testnet run**, **live public data**, or **example**):

1. **Blank lens (`0` lit pixels) — example:** confirms G2 waveguides stay completely clear (`0/1000` chars) when nothing needs attention.
2. **Exchange margin line -> one-tap move — example:** `BYBIT MARGIN LOW - TAP: MOVE 500 USDT FUNDING TO TRADING`. Shows an example of the Track 03 action alongside public Bybit/Coinbase prices; no Bybit testnet write has run yet, and signed exchange actions run on testnet once keys are supplied.
3. **Hyperliquid liquidation line -> one-tap trim — example line -> recorded fill:** `HL ETH LONG LIQ ~4m (6.0%) - TAP: TRIM 50% ETH` (the `6.0%` distance and `~4m` ETA are scripted example inputs paired with the public Hyperliquid ETH mark; tapping replays the recorded real Hyperliquid testnet fill for order `65942782652`).
4. **Telegram money request -> tap to pay — recorded from a real testnet run:** `KIT ASKS 20 USDC - TAP: PAY` replays the real `sim:demo` Sepolia transfer (`0xc453a91d…d8178d`, block `12207816`), where `/ask 20 USDC` was injected via `/api/dev/telegram-update` into the owner's single Telegram chat and paid on a simulator tap (or swipe down for an example decline).
5. **Voice brief (`"What matters?"`) + two-venue voice order check:** ranks remaining open items (`<= 3` lines, or `NOTHING NEEDS YOU` once cleared), plus a one-click Binance Spot Testnet / Coinbase confirm card (`BINANCE TESTNET $… | COINBASE $…`) using live public data (falling back cleanly to last recorded prices with their timestamp if feeds are unavailable).

```bash
# Run from the repository with no API keys:
npm install && npm run dev:judge        # http://127.0.0.1:5175/judge/

# Or build the static bundle (packages/judge/dist serves both / and /judge/):
npm run build:judge
```

---

## 2. Packaged `.ehpk` Build & Simulator

```bash
npm run pack:ehpk      # builds packages/glasses and packs + validates chainvision.ehpk against app.json
```

- Manifest: `packages/glasses/app.json` (`com.chainvision.g2` v`0.1.0`, `min_app_version: 2.2.10`, `min_sdk_version: 0.0.16`, single whitelisted backend origin `http://127.0.0.1:8787`).
- `*.ehpk` is gitignored rather than committed as a repo binary; once the owner publishes a GitHub Release, `chainvision.ehpk` can be attached via `gh release create` (see [README.md](./README.md#6-packaged-build-chainvisionehpk)).
- Local verification without hardware: `npm run build && npm run typecheck && npm test` (and `npm run sim` with `@evenrealities/evenhub-simulator@0.9.5`).

---

## 3. Verified Testnet Proofs

Transactions and fills recorded from ChainVision's live testnet runs on PR #6 (`12871f3`, `verify:testnet` and `sim:demo` in `evenhub-simulator@0.9.5`). The four Sepolia transactions were checked against Sepolia on-chain data (block, timestamp, method, and token transfers match); the Hyperliquid fill matches the Hyperliquid testnet API record for order `65942782652` and links directly to the fill transaction in the client-rendered Hyperliquid Testnet Explorer.

| Action | Network | Recorded Run | Proof (Explorer) |
| --- | --- | --- | --- |
| Aave v3 loan repay (5 USDC) | Ethereum Sepolia | `verify:testnet` · 2026-11-25 06:28:36 UTC (block `12207803`) | [`0x8b6b4210…04ea0c`](https://sepolia.etherscan.io/tx/0x8b6b4210ac28750395a242f578369421183315906f18e2ab3ddf68e1f904ea0c) |
| Uniswap v3 swap (5 USDC -> 17.15 DAI) | Ethereum Sepolia | `verify:testnet` · 2026-11-25 06:28:48 UTC (block `12207804`) | [`0x784a80d4…6b0578`](https://sepolia.etherscan.io/tx/0x784a80d485cf97a27b84909f4290871b4a9e009b19612de3cbdde151ba6b0578) |
| Telegram `/ask 2 USDC` payout to Kit | Ethereum Sepolia | `verify:testnet` · 2026-11-25 06:29:00 UTC (block `12207805`, TG msg 32) | [`0xa0dee545…4b68be`](https://sepolia.etherscan.io/tx/0xa0dee5452b95d4fcfabeefb13947d8a1d25b10d067baea07608f219dde4b68be) |
| Telegram `/ask 20 USDC` payout to Kit | Ethereum Sepolia | `sim:demo` · 2026-11-25 06:31:24 UTC (block `12207816`, owner chat) | [`0xc453a91d…d8178d`](https://sepolia.etherscan.io/tx/0xc453a91d030307a604667169047689f8703f8cc98de4281c4a33fa5252d8178d) |
| Hyperliquid ETH-PERP reduce-only IOC sell (`0.0181 ETH @ $1,653.7`, position `0.0363 -> 0.0182`) | Hyperliquid Testnet | `sim:demo` · 2026-11-25 06:31:07 UTC (order `65942782652`, non-withdrawable `source: "b"` agent) | [`0x3be55891…9a863` (HL Testnet Explorer)](https://app.hyperliquid-testnet.xyz/explorer/tx/0x3be55891d105ce793d5f042ef3a61401040070776c08ed4bdfae03e49009a863) |

*Honest status on remaining rails:* public Bybit testnet, Binance spot testnet, and Coinbase reads run live (`verify:exchanges` passes 6/6 public checks), while signed Bybit/Binance writes skip until testnet API keys are supplied; TON testnet wallet [`0QDNtIy-zwHMK5hdc0qVZoi2TkfZr_O3MjXcrq0H8QVdAYHl`](https://testnet.tonviewer.com/0QDNtIy-zwHMK5hdc0qVZoi2TkfZr_O3MjXcrq0H8QVdAYHl) reads live on toncenter testnet and awaits test coins from `@testgiver_ton_bot` for an on-chain TON payout proof.

---

## 4. What Existed Before 23 Nov

**Nothing.** This repository was initialized empty on **23 Nov 2026** for the Heads Up hackathon. All ChainVision application code, protocol integrations, signal queue, safety guards, glasses UI, Mini App, judge walkthrough, and unit tests were authored during the hackathon window using standard open-source dependencies (`@evenrealities/even_hub_sdk`, `@evenrealities/evenhub-simulator`, `viem`, `@msgpack/msgpack`, `@ton/ton`, `@ton/core`, `@ton/crypto`, `@tonconnect/ui`, `@walletconnect/ethereum-provider`, `zod`, `ws`, `vite`, `vitest`, `whisper.cpp`).

---

## 5. Safety Model (5 Lines)

1. **Testnet only:** `assertSepoliaOnly(11155111)`, `assertExchangeHost` (`api-testnet.bybit.com` / `testnet.binance.vision`), toncenter testnet endpoint checks, and Hyperliquid EIP-712 `source: "b"` hardcode testnet execution so signatures cannot replay on mainnet.
2. **Non-withdrawable Hyperliquid agent:** ChainVision only sends `reduceOnly: true` orders through a protocol-level non-withdrawable Hyperliquid API agent wallet; no withdrawal path exists in the codebase.
3. **Explicit caps and allowlists:** Aave, Uniswap, and Hyperliquid actions enforce per-action caps (`maxSingleActionUsd`, `maxEvmSwapEth`, `maxUsdcAction`) and Sepolia contract/spender allowlists; Telegram USDC/TON payouts and Bybit/Binance exchange actions enforce both per-action and rolling 24-hour caps (persisted in mode-600 local state files), restricted to wearer-approved requester addresses.
4. **Explicit tap-to-confirm and zero advice:** nothing executes without a live `glasses_tap` on the shown signal (1.5 s tap lockout) or offline two-tap Telegram fallback; `validateLensLayout()` rejects financial-advice phrasing and emoji.
5. **No mainnet keys or committed secrets:** ChainVision never asks for a mainnet signing key, never custodies user funds, keeps secret fields non-enumerable in `AppConfig`, and stores zero keys in git, logs, or `/judge`.

---

## 6. Five API Feature Requests for Sponsors

1. **Even Realities:** a wake/priority notification channel for critical financial alerts so a blank lens can stay unloaded until a threshold breaches.
2. **Even Realities:** simulator IMU mocking (`imuData`) and left/right temple / R1 ring `eventSource` selection for automated CI testing.
3. **Hyperliquid:** a keyless or lightweight Sepolia-like testnet faucet flow for hackathon builders who do not hold prior mainnet deposit history.
4. **Hyperliquid:** native per-order notional caps enforced on-chain for API Agent Wallets in addition to the existing non-withdrawable guarantee.
5. **Telegram:** direct one-click pairing hand-off from embedded mobile WebViews without requiring manual 6-digit code copy/paste.
