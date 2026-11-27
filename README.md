# ChainVision

**A quiet, non-custodial crypto HUD for Even Realities G2 smart glasses — built for the Heads Up Hackathon (Track 02 Crypto & DeFi + Track 03 Exchanges & Stocks + Best Telegram Integration).**

> **Testnet only · Non-custodial · Not financial advice.**  
> ChainVision runs exclusively on **Ethereum Sepolia**, **Hyperliquid / Bybit / Binance Testnets** and **TON testnet**, plus two reads that need no account and move nothing: Coinbase public market data, and (optionally) the balance of your own TON mainnet wallet address. It never holds user funds, never asks for a mainnet private key, never gives financial advice, and never executes a transaction without an explicit single-tap confirmation on the glasses.

> **For Judges (60-second evaluation, no API keys):** read [JUDGES.md](./JUDGES.md), run `npm run dev:judge` from the repository (or deploy `packages/judge/dist` as a static site) to click through the exact `576 × 288` Even G2 lens with no keys, and build the validated `.ehpk` package with `npm run pack:ehpk`.

## Verified Testnet Proofs

Real testnet executions recorded from ChainVision's `verify:testnet` and `sim:demo` (`evenhub-simulator@0.9.5`) runs on PR #6 (`12871f3`). The four Sepolia transactions were checked against Sepolia on-chain data (block, timestamp, method, and token transfers match). The Hyperliquid link opens the testnet account's explorer page (`0x1449…5182`), which lists the `2026-11-25 06:31:07 UTC` Place order transaction (`0x3be5…a863`, block `787719700`); fill size and price (`0.0181 ETH @ $1,653.7`, position `0.0363 -> 0.0182`, order `65942782652`) come from the public Hyperliquid testnet API:

| Action | Network | Recorded Run | Explorer Proof |
| --- | --- | --- | --- |
| Aave v3 loan repay (5 USDC) | Ethereum Sepolia | `verify:testnet` · 2026-11-25 06:28:36 UTC (block `12207803`) | [`0x8b6b4210…04ea0c`](https://sepolia.etherscan.io/tx/0x8b6b4210ac28750395a242f578369421183315906f18e2ab3ddf68e1f904ea0c) |
| Uniswap v3 swap (5 USDC -> 17.15 DAI) | Ethereum Sepolia | `verify:testnet` · 2026-11-25 06:28:48 UTC (block `12207804`) | [`0x784a80d4…6b0578`](https://sepolia.etherscan.io/tx/0x784a80d485cf97a27b84909f4290871b4a9e009b19612de3cbdde151ba6b0578) |
| Telegram `/ask 2 USDC` payout to Kit | Ethereum Sepolia | `verify:testnet` · 2026-11-25 06:29:00 UTC (block `12207805`, TG msg 32) | [`0xa0dee545…4b68be`](https://sepolia.etherscan.io/tx/0xa0dee5452b95d4fcfabeefb13947d8a1d25b10d067baea07608f219dde4b68be) |
| Telegram `/ask 20 USDC` payout to Kit | Ethereum Sepolia | `sim:demo` · 2026-11-25 06:31:24 UTC (block `12207816`, owner chat) | [`0xc453a91d…d8178d`](https://sepolia.etherscan.io/tx/0xc453a91d030307a604667169047689f8703f8cc98de4281c4a33fa5252d8178d) |
| Hyperliquid ETH-PERP reduce-only IOC sell (`0.0181 ETH @ $1,653.7`, position `0.0363 -> 0.0182`) | Hyperliquid Testnet | `sim:demo` · 2026-11-25 06:31:07 UTC (order `65942782652`, tx `0x3be5…a863`, block `787719700`, non-withdrawable `source: "b"` agent) | [`0x1449…5182` (HL Testnet Account Page)](https://app.hyperliquid-testnet.xyz/explorer/address/0x14490658fc8C7e3f5cDc68f01317Bdf684715182) |

*Pending owner keys/faucet:* public Bybit testnet, Binance spot testnet, and Coinbase reads run live (`npm run verify:exchanges`), while signed exchange writes skip until testnet API keys are configured; the TON test wallet [`0QDNtIy-zwHMK5hdc0qVZoi2TkfZr_O3MjXcrq0H8QVdAYHl`](https://testnet.tonviewer.com/0QDNtIy-zwHMK5hdc0qVZoi2TkfZr_O3MjXcrq0H8QVdAYHl) reads live on toncenter testnet and awaits faucet coins from `@testgiver_ton_bot` for a live TON payout hash.

---

## What ChainVision Does

ChainVision stays **completely blank** (0 lit pixels on Even G2's transparent monochrome green waveguides) until either a user-configured risk threshold triggers or you hold the temple touchpad to speak:

1. **Ambient Testnet Watcher (Read + One-Tap Fix)**
   - **Aave v3 (Sepolia):** watches your live loan health factor against your configured threshold (e.g. `1.35`). When breached, shows a single factual card (`AAVE LOAN THRESHOLD · HEALTH 1.12 · TAP: REPAY 300 USDC`). One tap executes the Sepolia repay transaction, displays the updated health factor, and posts a receipt to Telegram.
   - **Uniswap v3 (Sepolia):** monitors live WETH/USDC and USDC/DAI pool ticks, quotes via `QuoterV2`, and checks whether your `NonfungiblePositionManager` LP NFTs are in range.
   - **Hyperliquid (Testnet):** watches live perp positions and liquidation distance (`clearinghouseState`). When liquidation distance drops below your threshold, one tap sends a `reduceOnly` IOC trim via a **non-withdrawable API Agent Wallet**.
   - **Bybit testnet, Binance spot testnet, Coinbase (read-only):** margin and liquidation signals with a one-tap Funding-to-Trading transfer or reduce-only trim on Bybit, limit orders and cancels on Binance's spot testnet by voice, and Coinbase as a second price on confirm cards. See [Track 03: Exchanges](#track-03-exchanges).
2. **Hold-to-Speak Voice Actions (OpenRouter + Whisper)**
   - Hold the temple (`LONG_PRESS_EVENT` -> `LONG_PRESS_RELEASE_EVENT`) and say *"put 200 USDC to work"*, *"swap half my ETH to USDC"*, or *"trim half my ETH perp"*.
   - Audio (16 kHz s16le mono PCM via `--aid` in the simulator or G2 mics) is transcribed locally via Whisper and parsed by an OpenRouter LLM into a strict Zod-validated JSON intent.
   - A single factual confirm card compares live Aave APY, Uniswap quote, and exchange data. **Tap confirms; swipe down cancels.** Nothing executes without a tap.
3. **Telegram Bot + Mini App**
   - **Telegram Mini App (`/miniapp`):** connects Trust Wallet on Sepolia via WalletConnect v2 (or injected Trust Wallet), pairs the glasses using a 6-digit code, configures your thresholds and per-action caps, approves money requesters, and connects a TON testnet wallet through TON Connect (read-only).
   - **Telegram Bot:** posts a verified testnet receipt (with Etherscan / Hyperliquid Testnet Explorer link) after every execution, supports `/pair <code>`, `/status`, `/share` with an inline **Share to Group** button, and `/register` / `/ask` for money requests.

4. **One Queue, One Line**
   - Every source becomes a **signal**: Aave loan health, Hyperliquid liquidation distance, Uniswap LP range, exchange-testnet liquidation distance, and price alerts you set by voice. All of them feed one priority queue; the lens shows only the top signal as one line, for example `AAVE HEALTH 1.34 (LIMIT 1.60) - TAP: REPAY 251 USDC`. Adding a source never adds a screen.
   - **Tap** approves the shown signal's fix through the same tap-confirm safety path; **swipe down** dismisses it and shows the next one, or blank if none; **hold** listens. A line left untouched blanks itself after about 10 seconds and comes back only if it still matters. With an empty queue the lens shows 0 lit characters.
   - **"What matters?"** by voice shows one read-only card with at most three ranked lines, then goes blank again. With nothing in the queue it says `NOTHING NEEDS YOU`.
   - **Alerts by voice:** *"tell me if ETH drops below 1700"* (ETH, BTC or SOL; below or above) stores a rule. When the live Hyperliquid testnet mark price crosses it, a signal is raised once and the rule is removed. Rules are listed and removable in the Mini App.

5. **Money Requests Through Telegram (USDC on Sepolia, TON on testnet)**
   - Someone asks through the bot and the wearer answers on the lens: `KIT ASKS 20 USDC - TAP: PAY` or `KIT ASKS 2 TON - TAP: PAY`. A tap pays from the app's capped test wallet for that currency to the requester's registered address; both people get a Telegram receipt with the Etherscan or tonviewer link. A swipe declines, and the requester is told politely. See [Telegram](#telegram-money-requests-and-the-mini-app).
6. **TON (Gram) on testnet**
   - **The app's own TON test wallet** (v4r2, from `TON_TESTNET_MNEMONIC`, read through toncenter testnet) is watched like any other source: a payment that lands raises `RECEIVED 2 TON FROM 0QAB..WXYZ (TESTNET)` for 10 minutes, and a balance that drops below `TON_LOW_BALANCE_TON` raises `TON TEST WALLET 0.12 TON, UNDER 0.5`. Neither carries an action; a tap clears it.
   - **TON Connect in the Mini App (testnet):** the wearer connects a wallet that is in testnet mode (for example Tonkeeper with testnet on). ChainVision only reads that wallet's balance; it never asks it to sign. The wallet must report TON Connect network `-3`; a mainnet wallet is refused.
   - **Read-only mainnet balance:** set `TON_MAINNET_WATCH_ADDRESS` to your real Telegram (Gram) wallet address and the brief adds one line, for example `READ-ONLY TON 3.21 TESTNET · GRAM 12.34 MAINNET`. Nothing is ever sent on mainnet: the mainnet client has no send method.

---

## Architecture

```
Even G2 Glasses / evenhub-simulator (576x288 4-bit green)
  └─ packages/glasses (@evenrealities/even_hub_sdk, Vite TS)
       │ HTTP + WebSocket (single whitelisted origin: http://127.0.0.1:8787)
       ▼
  packages/server (Node + TypeScript)
  ├─ watcher/engine.ts       — polling loop, signal queue, auto-blank tick, tap-confirm gate
  ├─ store.ts                — JSON state file (alert rules, requesters, requests, payouts) that survives restarts
  ├─ safety/policy.ts        — Sepolia-only chainId, contract allowlist, per-action caps
  ├─ protocols/aave.ts       — Aave v3 Sepolia (Pool, PoolDataProvider, Faucet, WETH Gateway)
  ├─ protocols/uniswap.ts    — Uniswap v3 Sepolia (QuoterV2, SwapRouter02, PositionManager)
  ├─ protocols/hyperliquid.ts— Hyperliquid Testnet EIP-712 ('source: b') non-withdrawable agent
  ├─ protocols/exchange.ts   — public ETH perp mark price and funding (Bybit testnet, Binance Futures testnet fallback)
  ├─ exchanges/              — Bybit testnet and Binance spot testnet (signed reads and writes), Coinbase public prices, caps
  ├─ voice/stt.ts + openrouter.ts — Whisper 16kHz PCM STT + OpenRouter strict JSON intent
  ├─ telegram/bot.ts         — receipts, group sharing, /pair, /status, /register, /ask, approval buttons
  ├─ requests/book.ts        — requesters, money requests and the payout ledger
  ├─ protocols/payout.ts     — Sepolia test USDC transfer to an approved requester
  ├─ ton/                    — TON testnet wallet (toncenter), request payout rail, address handling
  └─ safety/ton.ts           — TON payouts: testnet endpoint only, approved addresses, nanoton caps
  packages/shared
  ├─ signal.ts               — Signal model, ranking, SignalQueue (shared by server and glasses)
  ├─ alerts.ts               — price alert rules and the signal a crossed rule raises
  ├─ requests.ts             — money request rules (caps, one open request, approval) and its signal
  ├─ exchange.ts             — exchange intents, caps and signals
  ├─ ton.ts                  — nanoton amounts, TON request and wallet signals, the read-only brief line
  └─ lens.ts                 — pure G2 page renderer and limit validator
       ▲
       │ HTTPS / Telegram WebApp
  packages/miniapp (Telegram Mini App: Trust Wallet WalletConnect on Sepolia, 6-digit pairing, requesters, TON Connect on testnet)
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

## Track 02: which listed apps ChainVision uses, and how

- **Hyperliquid (testnet):** live perp positions and liquidation distance feed the queue; a tap sends a `reduceOnly` IOC trim through a non-withdrawable API agent wallet.
- **Trust Wallet (Sepolia):** the Mini App connects Trust Wallet through WalletConnect v2 to set the Sepolia address ChainVision watches. Sepolia transactions (Aave repay and supply, Uniswap swaps) are signed by the app's own Sepolia test key after a tap, not by Trust Wallet.
- **Gram Wallet (TON) through TON Connect, testnet:** Telegram's built-in wallet runs on mainnet only and cannot sign testnet transfers, so the testnet part uses TON Connect with a testnet-capable wallet such as Tonkeeper in testnet mode. What uses which wallet:

| Part | Wallet | Network | Signs? |
| --- | --- | --- | --- |
| Paying a `/ask 2 TON` request after a tap | The app's own TON test wallet (`TON_TESTNET_MNEMONIC`) | TON testnet | Yes, server-side, within the request caps |
| Incoming-payment and low-balance lines | The app's own TON test wallet | TON testnet | No, read-only |
| Balance in the brief | The wallet you connect through TON Connect | TON testnet | No, read-only |
| Balance in the brief | Your Gram Wallet address (`TON_MAINNET_WATCH_ADDRESS`) | TON mainnet | No, read-only |

### Connecting a testnet wallet once (owner steps)
1. Serve the Mini App on a public HTTPS URL and set it as `TELEGRAM_MINIAPP_URL`; TON Connect wallets fetch `<that URL>/tonconnect-manifest.json` from it.
2. In Tonkeeper, switch to a testnet account (its developer menu offers testnet; the steps change between app versions).
3. Optionally send that testnet address test coins from @testgiver_ton_bot, so the brief has a non-zero balance to show.
4. Open the Mini App from the bot, tap **Connect Wallet** in the TON Testnet card, choose Tonkeeper and approve. The card then shows the connected address and its testnet balance; ask *"what matters?"* on the glasses to see the READ-ONLY line.

---

## Track 03: Exchanges

ChainVision connects three of Track 03's listed apps. Each one becomes signals in the same queue and actions behind the same tap; none of them adds a screen.

| App | How it is used | Reads | Writes |
| --- | --- | --- | --- |
| **Bybit** | Testnet, V5 API (`api-testnet.bybit.com`) | Trading (Unified) account equity, free margin and maintenance margin rate; Funding account USDT; linear perp positions with liquidation price | Internal transfer **Funding -> Trading** (USDT); **reduce-only** market order that trims a position |
| **Binance** | Spot testnet (`testnet.binance.vision`) | Balances, open orders, fills | **Limit order** and **cancel open orders**, by voice with a confirm card |
| **Coinbase** | Public market data only (`api.exchange.coinbase.com`) | BTC, ETH, SOL last trade in USD | **None. Coinbase is read-only:** no key, no account, no orders |

**What the lens shows.** When the Bybit Trading account runs low on margin (free margin under 250 USDT or maintenance margin rate at 30% or more, with a position open) the lens shows one line in the organisers' own shape: `BYBIT MARGIN LOW - TAP: MOVE 500 USDT FUNDING TO TRADING`. A tap moves the USDT from Funding to Trading and posts a Telegram receipt with the transfer id. If Funding is empty or today's transfer cap is used, the same line offers `CLOSE 50% BTC` instead. A Bybit position within your liquidation threshold shows `BYBIT BTC LONG LIQ 6.0% AWAY - TAP: CLOSE 50% BTC`, and a tap sends a reduce-only market order. Binance testnet open orders within 0.5% of the market and recent fills appear as read-only notices, all labelled `BINANCE TESTNET`. With nothing to say, the lens stays blank.

**By voice** (hold the temple), each with a confirm card and a tap:

- *"move 500 to trading"*: Bybit Funding -> Trading transfer, capped and shown on the card.
- *"close half my BTC position"*: reduce-only trim. It goes to Bybit when Bybit holds that position and Hyperliquid does not; *"close half my Bybit BTC position"* always means Bybit.
- *"buy 0.001 BTC at 57000"*: Binance spot testnet limit order. The card shows both venues' prices on one line, for example `BINANCE TESTNET $59201 | COINBASE $59115`.
- *"cancel my Binance orders"* or *"cancel my open BTC orders"*: cancels Binance testnet open orders.

**Caps.** Every exchange write is capped per action and per rolling 24 hours, checked when the card is built and again at the tap against live balances (`EXCHANGE_CAPS` in `packages/shared/src/exchange.ts`; the day survives restarts in `.chainvision/exchange-ledger.json`, mode 600):

| Action | Per action | Per 24 h |
| --- | --- | --- |
| Bybit Funding -> Trading | 500 USDT | 1,500 USDT |
| Bybit reduce-only trim | $1,000 notional | $3,000 |
| Binance limit order | $500 notional | $1,500 |
| Binance cancel | 10 orders | 50 orders |

Limit orders priced more than 25% from the testnet market are refused. Keys only ever travel to the two testnet hosts (`assertExchangeHost`), and the code has no withdrawal, no transfer out of Bybit, and no transfer from Trading to Funding.

**Keys.** Put `BYBIT_TESTNET_API_KEY` / `BYBIT_TESTNET_API_SECRET` (created at testnet.bybit.com with Account Transfer and Contract Orders and Positions permissions, no withdrawal) and `BINANCE_TESTNET_API_KEY` / `BINANCE_TESTNET_API_SECRET` (from testnet.binance.vision) in your secrets file. Without them every public read still runs and the signed steps report `SKIPPED` with the reason. To see the margin line, request test coins on testnet.bybit.com, move most of the Trading balance to Funding in the Bybit testnet web app, then open a small position with `npm run setup:bybit`.

```bash
npm run setup:bybit        # opens a 0.002 BTC long on Bybit testnet if none is open
npm run verify:exchanges   # public reads live; signed transfer, trim, limit order and cancel when keys are set
```

**Not used, and why.**

- **OKX:** OKX stopped serving India in 2024 and its hosts are blocked on the build machine's network; demo trading needs an OKX login.
- **Interactive Brokers:** paper trading needs an IBKR account and a locally running gateway; not set up for this build.
- **Binance futures and Binance transfers:** the spot testnet has no transfer endpoints and no reduce-only, and the current futures demo hosts do not resolve on the build machine's network, so ChainVision does not route around that block. Binance is used for spot limit orders and cancels only.
- **Bybit "spot to margin":** a Unified account has only Unified (Trading) and Fund accounts, so the honest wording is Funding to Trading.
- **Coinbase trading:** Coinbase's Advanced Trade sandbox answers with static, pre-defined responses, so a sandbox order would prove nothing; Coinbase stays read-only.


---

## Telegram: money requests and the Mini App

How it works, with the bot `@evenchainvisionbot`:

1. **The requester registers once** in a private chat with the bot: `/register 0xTheirSepoliaAddress Kit` for USDC, and/or `/register <their TON testnet address> Kit` for TON. A private chat is required because a bot cannot message anyone who has never started it, and receipts arrive there. Changing the address later needs approval again.
2. **The wearer approves them once** in the Mini App (Money Requests card). Approval needs proof of being the wearer: valid Telegram Mini App `initData` from the paired Telegram user, or a direct request on `127.0.0.1` that did not come through a proxy or tunnel.
3. **The requester asks** with `/ask 20 USDC` or `/ask 2 TON` in the private chat, or in a group the bot is in with `/ask@evenchainvisionbot 20 USDC`. Group privacy mode delivers commands addressed to the bot, while plain mentions are not delivered, so the command form is the one that works without making the bot an admin. The group gets the short replies; receipts still go to each person's private chat.
4. **The wearer answers on the lens:** tap pays, swipe declines. The wearer's Telegram message carries **Approve here** and **Decline** buttons: Approve asks for a second confirmation (`Yes, pay 20 USDC`), and both taps are refused while the glasses are connected.

Payouts use Aave's Sepolia test USDC (`0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8`, 6 decimals), which the test wallet can mint from the Aave Sepolia faucet. Set `SEPOLIA_PAYOUT_TOKEN=CIRCLE_USDC` to pay in Circle's Sepolia USDC (`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, from https://faucet.circle.com) instead. TON requests are paid in testnet TON from the app's own TON test wallet (`TON_TESTNET_MNEMONIC`) and have their own caps (2 TON per request, 5 TON per rolling 24 hours by default), counted separately from USDC. USDC per-request and daily caps are editable in the Mini App. Requesters, requests and payouts are kept in the same state file as alert rules, so the daily cap survives a restart.

To see it end to end with two people: the requester opens the bot, sends `/start`, then `/register <their Sepolia address> <name>`; the wearer approves them in the Mini App; the requester sends `/ask 5 USDC`; the wearer taps PAY in the simulator or on the glasses.

---

## Safety Model

- **Testnet-only enforcement:** `assertSepoliaOnly(11155111)` blocks all non-Sepolia EVM chain IDs; Hyperliquid L1 EIP-712 signing hardcodes `source: 'b'` (testnet) so signatures cannot replay on mainnet.
- **Contract allowlist & caps:** EVM writes are strictly restricted to verified Sepolia Aave v3 Pool / WrappedTokenGatewayV3 / Faucet and Uniswap v3 SwapRouter02 / PositionManager, with bounded per-action USD, ETH, and USDC caps.
- **Non-withdrawable Hyperliquid agent:** uses an authorized API agent wallet restricted to `reduceOnly: true` orders; no withdraw path exists in the codebase.
- **Tap-to-confirm invariant:** `POST /api/actions/confirm` requires explicit `source: "glasses_tap"` confirmation of a short-lived pending action ID.
- **Money requests:** only requesters the wearer approved once in the Mini App can ask; each request is capped (default 25 USDC or 2 TON), payouts are capped per rolling 24 hours per currency (default 50 USDC and 5 TON), a requester has at most one open request, and a request expires after 5 minutes. The rules are checked when asked and again at the moment of paying, and a USDC transfer is blocked unless the chain is Sepolia, the token is Sepolia test USDC, and the recipient is an approved address (`assertAllowedPayout`). Nothing is paid without a tap on the glasses; the only other path is two taps by the wearer in Telegram, accepted only while the glasses are not connected.
- **TON payouts:** sent only through the toncenter testnet endpoint, only to a TON address the wearer approved, as a whole number of nanotons within the TON caps (`assertAllowedTonPayout`). The only mainnet call in the codebase is a balance read of `TON_MAINNET_WATCH_ADDRESS`.
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

### TON testnet verification
```bash
VERIFY_TON_RECIPIENT=<test requester's TON testnet address> npm run verify:ton
```
Prints the app's TON test wallet address, reads its balance live from toncenter testnet, reads `TON_MAINNET_WATCH_ADDRESS` read-only if set, renders a TON request on the lens, and checks that an over-cap request is refused before anything is sent. When the test wallet holds at least `VERIFY_TON_AMOUNT` (default 0.05) plus 0.05 TON for fees, it pays one request through the lens tap path and records the transaction hash; otherwise that step reports SKIPPED with the address that needs test coins (send it test coins from @testgiver_ton_bot in Telegram).

### 5. Simulator End-to-End Run
```bash
npm run build
SIM_OUT=./sim-out npm run sim:e2e
```
Starts the backend on `127.0.0.1:8787` and the simulator, then walks the queue: blank with an empty queue, a voice alert set and fired, the top signal over a queued one, swipe to the next, auto-blank, the brief, the rest-and-return, and a tap clearing the last line. It saves a screenshot per step and `sim-e2e-report.json` in `SIM_OUT`. With `VERIFY_REQUESTER_ADDRESS=<Sepolia address>` it also registers and approves a requester, pays a 20 USDC request on the lens tap (a real Sepolia transfer), and declines a second one with a swipe. Telegram updates are fed to the bot's own handler through `POST /api/dev/telegram-update`, which exists only when `CHAINVISION_DEV_TELEGRAM_UPDATES=1` and only for loopback callers; the requester side uses the owner's own chat. `npm run verify:testnet` runs the same request flow with 2 USDC when `VERIFY_REQUESTER_ADDRESS` is set.

For the demo video, `npm run sim:demo` (same env, plus `VERIFY_REQUESTER_ADDRESS` and `VERIFY_TON_RECIPIENT`) walks the whole story in order: blank lens; an exchange line when live data raises one (it needs Bybit or Binance testnet keys, since every exchange line comes from a signed account read); a Hyperliquid trim by voice and tap; a Telegram request in USDC shown and paid; a request in TON shown, and paid only when the TON test wallet is funded; the brief; a voice alert set and fired; a voice order card with two venues' prices; blank again. It writes `sim-demo-report.json` with every step.

Alert rules are kept in `.chainvision/state.json` (gitignored, mode 600); set `CHAINVISION_STATE_FILE` to keep them elsewhere. The glasses app's backend origin is one value: the first `network` whitelist entry in `packages/glasses/app.json` (`http://127.0.0.1:8787`). The glasses build reads it from there, so pointing the app at a hosted backend later means changing that one line and rebuilding.

### 6. Packaged Build (`chainvision.ehpk`)

Build and validate the Even Hub package from `packages/glasses`:

```bash
npm run pack:ehpk
```

This builds `@chainvision/shared` and `@chainvision/glasses`, runs `@evenrealities/evenhub-cli pack` against `packages/glasses/app.json` and `packages/glasses/dist` (`--sdk-ver 0.0.16`), outputs `chainvision.ehpk` in the repository root, and verifies that `package_id` (`com.chainvision.g2`), `version` (`0.1.0`), `min_app_version` (`2.2.10`), warnings (`[]`), and byte size all match `packages/glasses/app.json`.

**Installing `chainvision.ehpk`:**
- **Even Hub / G2 glasses:** build `chainvision.ehpk` locally with `npm run pack:ehpk` (or download it once published on a GitHub Release) and upload/sideload it through the Even Hub developer portal or CLI (`npx -y @evenrealities/evenhub-cli@0.2.0 create chainvision.ehpk` for a first draft, or `upload chainvision.ehpk` for subsequent builds). If you are pointing G2 at a hosted backend instead of `http://127.0.0.1:8787`, update the single `network` whitelist entry in `packages/glasses/app.json` before packing.
- **Even Hub Simulator (no glasses required):** run `npm run dev:server`, `npm run dev:glasses`, and `npm run sim`.

**Publishing a release binary (binary is gitignored, not committed to git):**
```bash
npm run pack:ehpk
gh release create v1.0.0 chainvision.ehpk \
  --title "ChainVision v1.0.0 (Heads Up Hackathon)" \
  --notes "Packaged Even G2 .ehpk build (com.chainvision.g2 v0.1.0, min_app_version 2.2.10, SDK 0.0.16)."
```

### 7. Zero-Key Judge Walkthrough (`/judge`)

`packages/judge` is a standalone static site (also served by the backend at `http://127.0.0.1:8787/judge/`, with `/judge` redirecting to `/judge/`) that **runs from the repository with one command** and needs **no API keys**. It renders the exact `576 × 288` Even G2 monochrome lens through `@chainvision/shared`'s `renderLensPage()`, enforces both `validateLensLayout()` and the 60-character line limit, pulls live public read-only prices (Hyperliquid Testnet, Bybit Testnet, Binance Spot Testnet, Coinbase Public; falling back to last recorded prices with their timestamp when feeds are unavailable), and walks a judge through five clearly labeled steps in under a minute:

1. Blank lens (`0` lit pixels — example)
2. Exchange margin line with a one-tap Funding -> Trading move (example action; signed Bybit/Binance writes run on testnet once keys are supplied)
3. Hyperliquid liquidation line (`HL ETH LONG LIQ ~4m (6.0%)` scripted example line alongside the public HL mark; tapping replays the recorded real fill for order `65942782652`: `0.0181 ETH @ $1,653.7`, `0.0363 -> 0.0182`, tx `0x3be55891…9a863`)
4. Telegram `/ask 20 USDC` request with tap to pay (recorded real Sepolia tx `0xc453a91d…d8178d`, dev-injected into the owner's single Telegram chat during `sim:demo`)
5. Voice brief (`"What matters?"` + live public two-venue Binance/Coinbase confirm card)

Run locally from the repository:
```bash
npm run dev:judge        # opens on http://127.0.0.1:5175/judge/
```

Deploy as a static site (one command; outputs both `/` and `/judge/` in `packages/judge/dist`):
```bash
npm run build:judge && npx wrangler pages deploy packages/judge/dist --project-name chainvision-judge
```

---

## What Existed Before 23 Nov

**Nothing.** This repository was initialized empty on 23 Nov 2026 for the Heads Up hackathon. All ChainVision application code, protocol integrations, safety policy engine, glasses UI, Telegram bot, Mini App, and tests were written during the hackathon build window.

### Open-Source Dependencies Used
- `@evenrealities/even_hub_sdk` (`0.0.16`) & `@evenrealities/evenhub-simulator` (`0.9.5`) — Even Realities official G2 SDK & simulator
- `viem` — Ethereum Sepolia RPC, contract calls, and EIP-712 signing
- `@msgpack/msgpack` — Hyperliquid L1 action encoding
- `@walletconnect/ethereum-provider` — Trust Wallet WalletConnect v2 session in the Telegram Mini App
- `zod` — strict JSON schema validation for OpenRouter voice intents
- `@ton/ton`, `@ton/core`, `@ton/crypto` — TON testnet wallet (v4r2), message building and signing
- `@tonconnect/ui` — TON Connect in the Telegram Mini App (testnet)
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
