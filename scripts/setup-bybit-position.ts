/**
 * Opens a small BTCUSDT perp long on Bybit testnet (0.002 BTC, about $120 at testnet prices) so the
 * reduce-only trim has a real position to act on. Testnet only; refuses if a BTCUSDT position exists.
 */
import { loadConfig } from '../packages/server/src/config.js';
import { BybitTestnetClient } from '../packages/server/src/exchanges/bybit.js';

const QTY = '0.002';

async function main() {
  const bybit = new BybitTestnetClient(loadConfig());
  if (!bybit.hasKey) throw new Error('BYBIT_TESTNET_API_KEY / BYBIT_TESTNET_API_SECRET not configured');
  const existing = (await bybit.readPositions()).find((p) => p.symbol === 'BTCUSDT');
  if (existing) {
    console.log('[setup:bybit] Existing BTCUSDT position:', existing);
    return;
  }
  const order = await bybit.placeMarketOrder({ symbol: 'BTCUSDT', side: 'Buy', qty: QTY, reduceOnly: false, positionIdx: 0 });
  console.log('[setup:bybit] Opened', QTY, 'BTCUSDT long, order', order.orderId);
  console.log('[setup:bybit] Positions:', await bybit.readPositions());
}

main().catch((err) => {
  console.error('[setup:bybit] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
