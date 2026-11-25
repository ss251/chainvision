/**
 * Opens a small ~$40 ETH-PERP position on Hyperliquid Testnet using the authorized
 * non-withdrawable API Agent Wallet so ChainVision has a live perp to monitor and trim.
 */
import { loadConfig } from '../packages/server/src/config.js';
import { HyperliquidTestnetClient } from '../packages/server/src/protocols/hyperliquid.js';

async function main() {
  const config = loadConfig();
  const hl = new HyperliquidTestnetClient(config);
  const before = await hl.readSnapshot();
  console.log('[setup:hyperliquid] Account:', before.accountAddress, 'Equity:', before.accountValueUsd);

  const existing = before.positions.find((p) => p.coin === 'ETH');
  if (existing && existing.notionalUsd >= 45) {
    console.log('[setup:hyperliquid] Existing ETH position found:', existing);
    return;
  }

  console.log('[setup:hyperliquid] Opening ~$60 ETH-PERP long on Hyperliquid Testnet...');
  const res = await hl.openTestnetDemoPosition({ coin: 'ETH', notionalUsd: 60 });
  console.log('[setup:hyperliquid] Result:', res);

  const after = await hl.readSnapshot();
  console.log('[setup:hyperliquid] Live positions:', after.positions);
}

main().catch((err) => {
  console.error('[setup:hyperliquid] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
