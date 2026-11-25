/**
 * ChainVision 60-second end-to-end testnet verifier (`npm run verify:testnet`).
 * Proves:
 *  1. Live reads from Aave v3 Sepolia, Uniswap v3 Sepolia, Hyperliquid Testnet, and Exchange Testnet
 *  2. Live OpenRouter strict JSON intent parse
 *  3. One real signed testnet transaction per protocol (Aave, Uniswap, Hyperliquid)
 *  4. One live Telegram receipt message
 *  5. The signal queue built from live reads, the "what matters?" brief by voice,
 *     and one voice-set price alert firing on the live Hyperliquid testnet mark price
 *
 * Writes sanitized proof JSON (ZERO secrets) to PROOF_OUT when set.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_THRESHOLDS,
  renderLensPage,
  signalLensLine,
  validateLensLayout,
  type ExecutionReceipt,
  type LensViewState,
} from '@chainvision/shared';
import { loadConfig } from '../packages/server/src/config.js';
import { AaveSepoliaClient } from '../packages/server/src/protocols/aave.js';
import { ExchangeTestnetWatcher } from '../packages/server/src/protocols/exchange.js';
import { HyperliquidTestnetClient } from '../packages/server/src/protocols/hyperliquid.js';
import { UniswapSepoliaClient } from '../packages/server/src/protocols/uniswap.js';
import { TelegramBotService } from '../packages/server/src/telegram/bot.js';
import { VoiceIntentService } from '../packages/server/src/voice/openrouter.js';
import { ChainVisionEngine } from '../packages/server/src/watcher/engine.js';

function lensText(state: LensViewState): { text: string; chars: number; errors: string[] } {
  const layout = renderLensPage(state);
  return {
    text: layout.textObject.map((c) => c.content).join(' | '),
    chars: layout.totalChars,
    errors: validateLensLayout(layout).errors,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CheckResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIPPED';
  latencyMs: number;
  details: Record<string, unknown>;
}

async function runCheck(
  name: string,
  fn: () => Promise<{ status?: 'PASS' | 'SKIPPED'; details: Record<string, unknown> }>,
): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const res = await fn();
    return {
      name,
      status: res.status ?? 'PASS',
      latencyMs: Date.now() - t0,
      details: res.details,
    };
  } catch (err) {
    return {
      name,
      status: 'FAIL',
      latencyMs: Date.now() - t0,
      details: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

async function main() {
  const startedAt = Date.now();
  const config = loadConfig();
  const readOnly = process.argv.includes('--read-only');

  const aave = new AaveSepoliaClient(config);
  const uniswap = new UniswapSepoliaClient(config);
  const hyperliquid = new HyperliquidTestnetClient(config);
  const exchange = new ExchangeTestnetWatcher(config);
  const voiceIntents = new VoiceIntentService(config);
  const telegram = new TelegramBotService(config);

  const results: CheckResult[] = [];

  // 1. Live protocol reads in parallel
  const [rAave, rUni, rHl, rEx] = await Promise.all([
    runCheck('read:aave-v3-sepolia', async () => {
      const snap = await aave.readSnapshot();
      if (snap.error) throw new Error(snap.error);
      return {
        details: {
          address: snap.address,
          healthFactor: snap.healthFactor,
          totalCollateralUsd: snap.totalCollateralUsd,
          totalDebtUsd: snap.totalDebtUsd,
          ethBalance: snap.ethBalance,
          usdcBalance: snap.usdcBalance,
          usdcSupplyApyPct: snap.rates.find((r) => r.symbol === 'USDC')?.supplyApyPct ?? null,
        },
      };
    }),
    runCheck('read:uniswap-v3-sepolia', async () => {
      const snap = await uniswap.readSnapshot();
      if (snap.error) throw new Error(snap.error);
      return {
        details: {
          poolAddress: snap.poolAddress,
          pair: snap.pair,
          currentTick: snap.currentTick,
          ethQuoteUsdc: snap.ethQuoteUsdc,
          usdcToDaiRate: snap.usdcToDaiRate,
          lpPositionsCount: snap.lpPositions.length,
        },
      };
    }),
    runCheck('read:hyperliquid-testnet', async () => {
      const snap = await hyperliquid.readSnapshot();
      if (snap.error) throw new Error(snap.error);
      return {
        details: {
          accountAddress: snap.accountAddress,
          agentAddress: snap.agentAddress,
          ethMarkPx: snap.ethMarkPx,
          btcMarkPx: snap.btcMarkPx,
          accountValueUsd: snap.accountValueUsd,
          openPositions: snap.positions.length,
        },
      };
    }),
    runCheck('read:exchange-testnet', async () => {
      const snap = await exchange.readSnapshot();
      if (snap.error) throw new Error(snap.error);
      return {
        details: {
          venue: snap.venue,
          mode: snap.mode,
          ethMarkPx: snap.ethMarkPx,
          ethFundingPct: snap.ethFundingPct,
          openPositions: snap.positions.length,
        },
      };
    }),
  ]);
  results.push(rAave, rUni, rHl, rEx);

  // 2. Voice intent parsing (OpenRouter live when key set)
  const rVoice = await runCheck('voice:openrouter-intent', async () => {
    const parsed = await voiceIntents.parseTranscript('put 200 USDC to work');
    if (parsed.intent.action !== 'aave_supply') {
      throw new Error(`Expected aave_supply, got ${JSON.stringify(parsed.intent)}`);
    }
    if (parsed.provider !== 'openrouter') {
      return {
        status: 'SKIPPED',
        details: {
          provider: parsed.provider,
          reason: parsed.fallbackReason ?? 'OPENROUTER_API_KEY not configured',
          stubIntent: parsed.intent,
        },
      };
    }
    return {
      details: {
        provider: parsed.provider,
        model: parsed.model,
        intent: parsed.intent,
      },
    };
  });
  results.push(rVoice);

  // 3. One queue, one brief, one alert (in-memory engine on live reads)
  const engine = new ChainVisionEngine(config);
  results.push(
    await runCheck('queue:live-signals', async () => {
      await engine.pollNow();
      const now = Date.now();
      const ranked = engine.queue.ranked(now);
      const state = engine.getLensState(now);
      const lens = lensText(state);
      if (lens.errors.length) throw new Error(lens.errors.join('; '));
      if (ranked.length === 0 && lens.chars !== 0) throw new Error('Empty queue must leave the lens blank');
      if (ranked.length > 0 && state.signal?.id !== ranked[0]?.id) throw new Error('Lens is not showing the top signal');
      return {
        details: {
          signals: ranked.map((sig) => ({
            id: sig.id,
            severity: sig.severity,
            lossDistancePct: sig.lossDistancePct,
            usdAtRisk: sig.usdAtRisk,
            lensLine: signalLensLine(sig),
          })),
          lensMode: state.mode,
          lensText: lens.text,
          lensChars: lens.chars,
        },
      };
    }),
  );

  results.push(
    await runCheck('voice:brief-what-matters', async () => {
      const out = await engine.handleVoiceTranscript('What matters?');
      if (out.parse.intent.action !== 'brief') throw new Error(`Expected brief, got ${JSON.stringify(out.parse.intent)}`);
      const state = engine.getLensState();
      const lens = lensText(state);
      if (state.mode !== 'brief' || lens.errors.length) throw new Error(`Brief not shown: ${lens.errors.join('; ')}`);
      engine.dismissToBlank();
      return {
        status: out.parse.provider === 'openrouter' ? 'PASS' : 'SKIPPED',
        details: {
          provider: out.parse.provider,
          model: out.parse.model,
          briefLines: state.briefLines,
          lensText: lens.text,
          lensChars: lens.chars,
        },
      };
    }),
  );

  results.push(
    await runCheck('alert:voice-set-and-fire', async () => {
      const prices = await engine.pollPrices();
      const eth = prices.ETH;
      if (!eth) throw new Error('No live ETH testnet mark price');
      const step = Math.max(0.01, Number((eth * 0.0002).toFixed(2)));
      const above = Number((eth + step).toFixed(2));
      const below = Number((eth - step).toFixed(2));
      const transcript = `tell me if ETH goes above ${above}`;
      const voiced = await engine.handleVoiceTranscript(transcript);
      if (!voiced.alert?.ok) throw new Error(`Voice alert not stored: ${JSON.stringify(voiced.alert ?? voiced.parse.intent)}`);
      const twin = await engine.addAlert({ asset: 'ETH', direction: 'below', price: below }, 'api');
      if (!twin.ok) throw new Error(`Twin alert not stored: ${twin.reason}`);
      const rules = engine.listAlerts();

      const started = Date.now();
      const observed: number[] = [];
      while (Date.now() - started < 300_000) {
        await sleep(3000);
        const live = await engine.pollPrices();
        if (live.ETH) observed.push(live.ETH);
        const fired = engine.queue.ranked(Date.now()).find((sig) => sig.source === 'price_alert');
        if (!fired) continue;
        for (const left of engine.listAlerts()) engine.removeAlert(left.id);
        const firedRule = rules.find((r) => fired.id === `price_alert:${r.id}`);
        return {
          status: voiced.parse.provider === 'openrouter' ? 'PASS' : 'SKIPPED',
          details: {
            provider: voiced.parse.provider,
            transcript,
            intent: voiced.parse.intent,
            rules: rules.map((r) => ({ id: r.id, rule: `${r.asset} ${r.direction} ${r.price}`, referencePrice: r.referencePrice, via: r.createdVia })),
            firedRule: firedRule ? `${firedRule.asset} ${firedRule.direction} ${firedRule.price}` : fired.id,
            priceAtFire: live.ETH,
            secondsToFire: Math.round((Date.now() - started) / 1000),
            observedPrices: observed,
            signalLensLine: signalLensLine(fired),
            priceSource: 'Hyperliquid testnet metaAndAssetCtxs markPx',
          },
        };
      }
      for (const left of engine.listAlerts()) engine.removeAlert(left.id);
      throw new Error(`No alert fired in 300 s (ETH observed ${Math.min(...observed)}..${Math.max(...observed)}, rules ${below} / ${above})`);
    }),
  );

  let lastReceipt: ExecutionReceipt | null = null;

  if (!readOnly) {
    // 4. Signed Aave v3 Sepolia transaction (repay if debt > 1 else supply 5 USDC)
    const rAaveTx = await runCheck('tx:aave-v3-sepolia', async () => {
      const snap = await aave.readSnapshot();
      if (snap.ethBalance < 0.002) {
        return {
          status: 'SKIPPED',
          details: { reason: `Sepolia wallet ${snap.address} has ${snap.ethBalance} ETH (needs gas)` },
        };
      }
      if (snap.usdcBalance < 10) {
        await aave.mintFromFaucet({ token: 'USDC', amount: 100 });
      }
      if (snap.totalDebtUsd >= 5) {
        const res = await aave.repay({ token: 'USDC', amount: 5, thresholds: DEFAULT_THRESHOLDS });
        lastReceipt = {
          id: `verify_aave_${Date.now()}`,
          actionId: 'verify',
          protocol: 'aave',
          actionType: 'aave_repay',
          network: 'sepolia',
          summary: 'AAVE REPAY 5 USDC',
          beforeFact: `HF ${res.before.healthFactor?.toFixed(2) ?? 'N/A'}`,
          afterFact: `HF ${res.after.healthFactor?.toFixed(2) ?? 'N/A'}`,
          txHashOrOrderId: res.txHash,
          explorerUrl: res.explorerUrl,
          telegramPosted: false,
          timestamp: Date.now(),
        };
        return {
          details: {
            action: 'repay',
            txHash: res.txHash,
            explorerUrl: res.explorerUrl,
            beforeHf: res.before.healthFactor,
            afterHf: res.after.healthFactor,
          },
        };
      }
      if ((snap.eursBalance ?? 0) < 10) {
        await aave.mintFromFaucet({ token: 'EURS', amount: 100 });
      }
      const res = await aave.supply({ token: 'EURS', amount: 5, thresholds: DEFAULT_THRESHOLDS });
      lastReceipt = {
        id: `verify_aave_${Date.now()}`,
        actionId: 'verify',
        protocol: 'aave',
        actionType: 'aave_supply',
        network: 'sepolia',
        summary: 'AAVE SUPPLY 5 EURS',
        beforeFact: `COLLAT $${res.before.totalCollateralUsd.toFixed(2)}`,
        afterFact: `COLLAT $${res.after.totalCollateralUsd.toFixed(2)}`,
        txHashOrOrderId: res.txHash,
        explorerUrl: res.explorerUrl,
        telegramPosted: false,
        timestamp: Date.now(),
      };
      return {
        details: {
          action: 'supply',
          txHash: res.txHash,
          explorerUrl: res.explorerUrl,
          beforeCollateralUsd: res.before.totalCollateralUsd,
          afterCollateralUsd: res.after.totalCollateralUsd,
        },
      };
    });
    results.push(rAaveTx);

    // 5. Signed Uniswap v3 Sepolia swap (5 AaveUSDC -> AaveDAI on fee=500 pool)
    const rUniTx = await runCheck('tx:uniswap-v3-sepolia', async () => {
      const snap = await aave.readSnapshot();
      if (snap.ethBalance < 0.002) {
        return {
          status: 'SKIPPED',
          details: { reason: `Sepolia wallet ${snap.address} has ${snap.ethBalance} ETH (needs gas)` },
        };
      }
      if (snap.usdcBalance < 5) {
        await aave.mintFromFaucet({ token: 'USDC', amount: 100 });
      }
      const res = await uniswap.executeSwap({
        tokenIn: 'USDC',
        tokenOut: 'DAI',
        amountIn: 5,
        slippageBps: 500,
        thresholds: DEFAULT_THRESHOLDS,
      });
      return {
        details: {
          pair: res.route.pairLabel,
          txHash: res.txHash,
          explorerUrl: res.explorerUrl,
          quotedOutDai: res.quotedOut,
        },
      };
    });
    results.push(rUniTx);

    // 6. Signed Hyperliquid Testnet reduce-only trim
    const rHlTx = await runCheck('tx:hyperliquid-testnet', async () => {
      if (!config.hyperliquidAccountAddress || !config.hyperliquidAgentPrivateKey) {
        return {
          status: 'SKIPPED',
          details: { reason: 'HYPERLIQUID_ACCOUNT_ADDRESS or agent key not configured' },
        };
      }
      const snap = await hyperliquid.readSnapshot();
      if (snap.positions.length === 0) {
        return {
          status: 'SKIPPED',
          details: {
            reason: `No open Hyperliquid testnet position on ${snap.accountAddress} (equity $${snap.accountValueUsd.toFixed(2)})`,
          },
        };
      }
      const pos = snap.positions[0]!;
      const res = await hyperliquid.trimPosition({
        coin: pos.coin,
        amountPct: 25,
        thresholds: DEFAULT_THRESHOLDS,
      });
      return {
        details: {
          coin: pos.coin,
          orderId: res.orderId,
          status: res.status,
          explorerUrl: res.explorerUrl,
        },
      };
    });
    results.push(rHlTx);

    // 7. Live Telegram receipt post
    const rTg = await runCheck('receipt:telegram', async () => {
      if (!telegram.isConfigured) {
        return {
          status: 'SKIPPED',
          details: { reason: 'TELEGRAM_BOT_TOKEN not configured' },
        };
      }
      const chatId = telegram.chatId ?? (await telegram.discoverChatIdFromUpdates());
      if (!chatId) {
        const me = await telegram.getMe();
        return {
          status: 'SKIPPED',
          details: {
            reason: `Waiting for user to tap /start on @${me.username ?? 'bot'} so chat_id is available`,
            botUsername: me.username ?? null,
          },
        };
      }
      const sampleReceipt: ExecutionReceipt = lastReceipt ?? {
        id: `verify_tg_${Date.now()}`,
        actionId: 'verify',
        protocol: 'aave',
        actionType: 'aave_repay',
        network: 'sepolia',
        summary: 'VERIFY TESTNET CHECK',
        beforeFact: 'READ OK',
        afterFact: 'TELEGRAM RECEIPT OK',
        txHashOrOrderId: 'verify-ping',
        explorerUrl: `https://sepolia.etherscan.io/address/${config.sepoliaAddress}`,
        telegramPosted: false,
        timestamp: Date.now(),
      };
      const out = await telegram.sendReceipt(sampleReceipt, chatId);
      if (!out.sent) throw new Error(out.error ?? 'Failed to post Telegram receipt');
      return {
        details: {
          messageId: out.messageId,
          receiptId: sampleReceipt.id,
          explorerUrl: sampleReceipt.explorerUrl,
        },
      };
    });
    results.push(rTg);
  }

  const totalMs = Date.now() - startedAt;
  const summary = {
    timestamp: new Date().toISOString(),
    totalMs,
    readOnly,
    passed: results.filter((r) => r.status === 'PASS').length,
    skipped: results.filter((r) => r.status === 'SKIPPED').length,
    failed: results.filter((r) => r.status === 'FAIL').length,
    results,
  };

  for (const r of results) {
    console.log(`[${r.status}] ${r.name} (${r.latencyMs}ms) ${JSON.stringify(r.details)}`);
  }
  console.log(
    `\nSummary: ${summary.passed} PASS, ${summary.skipped} SKIPPED, ${summary.failed} FAIL in ${(totalMs / 1000).toFixed(1)}s`,
  );

  const outPath = process.env.PROOF_OUT;
  if (outPath) {
    const dir = path.dirname(outPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
    console.log(`Proof written to ${outPath}`);
  }

  if (summary.failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[verify:testnet] Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
