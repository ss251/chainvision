# ChainVision

**A quiet, non-custodial crypto HUD for Even Realities G2 smart glasses — built for the Heads Up Hackathon (Track 02 Crypto & DeFi + Track 03 Exchanges & Stocks + Best Telegram Integration).**

> **Testnet only · Non-custodial · Not financial advice.**  
> ChainVision runs exclusively on **Ethereum Sepolia** and **Hyperliquid / Bybit / Binance Testnets**. It never holds user funds, never asks for a mainnet private key, never gives financial advice, and never executes a transaction without an explicit single-tap confirmation on the glasses.

---

## What ChainVision Does

ChainVision stays **completely blank** (0 lit pixels on Even G2's transparent monochrome green waveguides) until either a user-configured risk threshold triggers or you hold the temple touchpad to speak:

1. **Ambient Testnet Watcher (Read + One-Tap Fix)**
   - **Aave v3 (Sepolia):** watches your live loan health factor against your configured threshold (e.g. `1.35`). When breached, shows a single factual card (`AAVE LOAN THRESHOLD · HEALTH 1.12 · TAP: REPAY 300 USDC`). One tap executes the Sepolia repay transaction, displays the updated health factor, and posts a receipt to Telegram.
   - **Uniswap v3 (Sepolia):** monitors live WETH/USDC and USDC/DAI pool ticks, quotes via `QuoterV2`, and checks whether your `NonfungiblePositionManager` LP NFTs are in range.
   - **Hyperliquid (Testnet):** watches live perp positions and liquidation distance (`clearinghouseState`). When liquidation distance drops below your threshold, one tap sends a `reduceOnly` IOC trim via a **non-withdrawable API Agent Wallet**.
   - **Bybit / Binance Futures (Testnet):** read-only watcher for live mark prices, funding rates, and (when read-only testnet API keys are configured) open positions and equity.
2. **Hold-to-Speak Voice Actions (OpenRouter + Whisper)**
   - Hold the temple (`LONG_PRESS_EVENT` -> `LONG_PRESS_RELEASE_EVENT`) and say *"put 200 USDC to work"*, *"swap half my ETH to USDC"*, or *"trim half my ETH perp"*.
   - Audio (16 kHz s16le mono PCM via `--aid` in the simulator or G2 mics) is transcribed locally via Whisper and parsed by an OpenRouter LLM into a strict Zod-validated JSON intent.
   - A single factual confirm card compares live Aave APY, Uniswap quote, and exchange data. **Tap confirms; swipe down cancels.** Nothing executes without a tap.
3. **Telegram Bot + Mini App**
   - **Telegram Mini App (`/miniapp`):** connects Trust Wallet on Sepolia via WalletConnect v2 (or injected Trust Wallet), pairs the glasses using a 6-digit code, and configures your thresholds and per-action caps.
   - **Telegram Bot:** posts a verified testnet receipt (with Etherscan / Hyperliquid Testnet Explorer link) after every execution, supports `/pair <code>`, `/status`, and `/share` with an inline **Share to Group** button.

4. **One Queue, One Line**
   - Every source becomes a **signal**: Aave loan health, Hyperliquid liquidation distance, Uniswap LP range, exchange-testnet liquidation distance, and price alerts you set by voice. All of them feed one priority queue; the lens shows only the top signal as one line, for example `AAVE HEALTH 1.34 (LIMIT 1.60) - TAP: REPAY 251 USDC`. Adding a source never adds a screen.
   - **Tap** approves the shown signal's fix through the same tap-confirm safety path; **swipe down** dismisses it and shows the next one, or blank if none; **hold** listens. A line left untouched blanks itself after about 10 seconds and comes back only if it still matters. With an empty queue the lens shows 0 lit characters.
   - **"What matters?"** by voice shows one read-only card with at most three ranked lines, then goes blank again. With nothing in the queue it says `NOTHING NEEDS YOU`.
   - **Alerts by voice:** *"tell me if ETH drops below 1700"* (ETH, BTC or SOL; below or above) stores a rule. When the live Hyperliquid testnet mark price crosses it, a signal is raised once and the rule is removed. Rules are listed and removable in the Mini App.

---

## Architecture

```
Even G2 Glasses / evenhub-simulator (576x288 4-bit green)
  └─ packages/glasses (@evenrealities/even_hub_sdk, Vite TS)
       │ HTTP + WebSocket (single whitelisted origin: http://127.0.0.1:8787)
       ▼
  packages/server (Node + TypeScript)
  ├─ watcher/engine.ts       — polling loop, signal queue, auto-blank tick, tap-confirm gate
  ├─ store.ts                — JSON state file (alert rules) that survives restarts
  ├─ safety/policy.ts        — Sepolia-only chainId, contract allowlist, per-action caps
  ├─ protocols/aave.ts       — Aave v3 Sepolia (Pool, PoolDataProvider, Faucet, WETH Gateway)
  ├─ protocols/uniswap.ts    — Uniswap v3 Sepolia (QuoterV2, SwapRouter02, PositionManager)
  ├─ protocols/hyperliquid.ts— Hyperliquid Testnet EIP-712 ('source: b') non-withdrawable agent
  ├─ protocols/exchange.ts   — Bybit / Binance Futures Testnet read-only watcher
  ├─ voice/stt.ts + openrouter.ts — Whisper 16kHz PCM STT + OpenRouter strict JSON intent
  └─ telegram/bot.ts         — receipts, group sharing, /pair, /status
  packages/shared
  ├─ signal.ts               — Signal model, ranking, SignalQueue (shared by server and glasses)
  ├─ alerts.ts               — price alert rules and the signal a crossed rule raises
  └─ lens.ts                 — pure G2 page renderer and limit validator
       ▲
       │ HTTPS / Telegram WebApp
  packages/miniapp (Telegram Mini App: Trust Wallet WalletConnect on Sepolia + 6-digit pairing)
```

### Even G2 Platform Compliance

- **Blank idle screen:** `mode === 'idle'` renders 0 characters (`content: ''`) so waveguides stay transparent.
- **Container & character limits:** max 3 text containers (platform limit: 12), **exactly one** `isEventCapture: 1`, `< 400` characters per page (platform limit: 1,000), zero emoji.
- **Controls:**
  - **Double tap:** always calls `bridge.shutDownPageContainer(1)` (native exit).
  - **Single tap:** approves the shown signal's fix or a voice confirm card (1.5 s lockout prevents accidental double-tap exit); clears a signal that carries no fix, closes the brief, and opens positions from idle.
  - **Swipe up:** cycles live protocol views (`Aave -> Hyperliquid -> Uniswap -> Exchange`, 650 ms debounce).
  - **Swipe down:** dismisses the shown signal for 15 minutes (unless it escalates) and shows the next one or blank; closes any other card.
  - **Hold temple (long press):** captures live 16 kHz PCM voice command (also reachable via contextual menu `Voice (4s)`).
- **Hardware caveats (simulator-only build):** developed and verified in `evenhub-simulator@0.9.5` (which fixes `imuData = null` and right-arm touch). Physical G2 Bluetooth timing, Android background suspension, and head gestures are untested on hardware.

### Signal ranking

Signals are ranked money at risk soonest first (`compareSignals` in `packages/shared/src/signal.ts`, covered by `tests/signal.test.ts`):

1. Severity: `critical` (past half of your threshold margin), then `warning` (threshold crossed), then `notice` (price alerts).
2. Signals with money at risk before those without, smallest loss distance first. Loss distance is the percent move left before money is lost: liquidation distance for perps, `(1 - 1/HF)` for an Aave loan.
3. Larger dollar exposure first, then the one expiring sooner, then the older one, then by id.

Watchers re-emit what is still true on every poll; a signal a source stops emitting leaves the queue, and one not re-emitted expires. Timings: a shown line blanks after 10 s untouched and returns after a 60 s rest only if it is still raised; a swipe hides it for 15 minutes unless its severity rises; the brief blanks after 10 s.

---

## Safety Model

- **Testnet-only enforcement:** `assertSepoliaOnly(11155111)` blocks all non-Sepolia EVM chain IDs; Hyperliquid L1 EIP-712 signing hardcodes `source: 'b'` (testnet) so signatures cannot replay on mainnet.
- **Contract allowlist & caps:** EVM writes are strictly restricted to verified Sepolia Aave v3 Pool / WrappedTokenGatewayV3 / Faucet and Uniswap v3 SwapRouter02 / PositionManager, with bounded per-action USD, ETH, and USDC caps.
- **Non-withdrawable Hyperliquid agent:** uses an authorized API agent wallet restricted to `reduceOnly: true` orders; no withdraw path exists in the codebase.
- **Tap-to-confirm invariant:** `POST /api/actions/confirm` requires explicit `source: "glasses_tap"` confirmation of a short-lived pending action ID.
- **Signals never act on their own:** a signal's fix runs only when a tap confirms the action of the signal the lens is showing at that moment; a queued signal behind it cannot be confirmed.
- **Secrets:** never committed to git; loaded from a gitignored `.env` or external mode-600 files via `CHAINVISION_ENV_FILE` / `CHAINVISION_SECRETS_FILE` (with secret fields marked non-enumerable on `AppConfig`).
- **Aave v3 Sepolia supply cap handling:** live on-chain `getReserveCaps()` checks detect when Sepolia's testnet `USDC`/`DAI` pools have hit their supply cap (Aave Error `51`) and route voice stablecoin supply transparently to Sepolia's open-cap `EURS` reserve while borrowing/repaying live `USDC` debt against `WBTC` collateral.

---

## Quick Start (Even Hub Simulator)

### Prerequisites
- Node.js `>= 22`
- `whisper-cli` / `whisper-server` (Homebrew: `brew install whisper-cpp`) and a `ggml-tiny.en.bin` model for local microphone STT
- `@evenrealities/evenhub-simulator@0.9.5` (invoked via `npx`)

### 1. Install & Configure
```bash
npm install
cp .env.example .env
# Fill in your Sepolia testnet key, Hyperliquid testnet account + non-withdrawable agent key,
# OpenRouter API key, and Telegram BotFather token in .env (NEVER commit .env).
```

### 2. Build & Run Unit Tests
```bash
npm run build
npm test
```

### 3. Run Server + Glasses Plugin in Even Hub Simulator
Terminal 1 (backend + Mini App at `http://127.0.0.1:8787/miniapp`):
```bash
npm run dev:server
```
Terminal 2 (Even G2 glasses WebView at `http://127.0.0.1:5173`):
```bash
npm run dev:glasses
```
Terminal 3 (Even Hub Simulator with live microphone capture):
```bash
# List your macOS/desktop microphone devices:
npx -y @evenrealities/evenhub-simulator@0.9.5 --list-audio-input-devices

# Launch simulator with your mic ID:
npx -y @evenrealities/evenhub-simulator@0.9.5 http://127.0.0.1:5173 --automation-port 9898 --aid "<YOUR_MIC_DEVICE_ID>"
```

### 4. Seed Sepolia Positions & Run 60-Second Verification
```bash
# Optional: mint Aave Sepolia test tokens and open a sample Sepolia loan
npm run setup:sepolia

# Verify live reads, OpenRouter intent, the signal queue, the voice brief, one voice-set
# price alert firing on the live testnet price, real testnet txs, and a Telegram receipt
npm run verify:testnet
```

### 5. Simulator End-to-End Run
```bash
npm run build
SIM_OUT=./sim-out npm run sim:e2e
```
Starts the backend on `127.0.0.1:8787` and the simulator, then walks the queue: blank with an empty queue, a voice alert set and fired, the top signal over a queued one, swipe to the next, auto-blank, the brief, the rest-and-return, and a tap clearing the last line. It saves a screenshot per step and `sim-e2e-report.json` in `SIM_OUT`.

Alert rules are kept in `.chainvision/state.json` (gitignored, mode 600); set `CHAINVISION_STATE_FILE` to keep them elsewhere. The glasses app reads its backend origin from `VITE_CHAINVISION_BACKEND` (default `http://127.0.0.1:8787`), which must match the `network` whitelist in `packages/glasses/app.json`.

---

## What Existed Before 23 Nov

**Nothing.** This repository was initialized empty on 23 Nov 2026 for the Heads Up hackathon. All ChainVision application code, protocol integrations, safety policy engine, glasses UI, Telegram bot, Mini App, and tests were written during the hackathon build window.

### Open-Source Dependencies Used
- `@evenrealities/even_hub_sdk` (`0.0.16`) & `@evenrealities/evenhub-simulator` (`0.9.5`) — Even Realities official G2 SDK & simulator
- `viem` — Ethereum Sepolia RPC, contract calls, and EIP-712 signing
- `@msgpack/msgpack` — Hyperliquid L1 action encoding
- `@walletconnect/ethereum-provider` — Trust Wallet WalletConnect v2 session in the Telegram Mini App
- `zod` — strict JSON schema validation for OpenRouter voice intents
- `ws`, `vite`, `typescript`, `tsx`, `vitest` — WebSocket server, bundler, TypeScript runtime, and test runner
- `whisper.cpp` (`whisper-server` / `whisper-cli`) — local 16 kHz PCM speech-to-text

---

## API Feature Requests for Sponsors

1. **Even Realities:** a wake/priority notification channel for critical financial alerts so a blank lens can stay unloaded until a threshold breaches.
2. **Even Realities:** simulator IMU mocking (`imuData`) and left/right temple / R1 ring `eventSource` selection for automated CI testing.
3. **Hyperliquid:** a keyless or lightweight Sepolia-like testnet faucet flow for hackathon builders who do not hold prior mainnet deposit history.
4. **Hyperliquid:** native per-order notional caps enforced on-chain for API Agent Wallets in addition to the existing non-withdrawable guarantee.
5. **Telegram:** direct one-click pairing hand-off from embedded mobile WebViews without requiring manual 6-digit code copy/paste.

---

## License

MIT — see [LICENSE](./LICENSE).
