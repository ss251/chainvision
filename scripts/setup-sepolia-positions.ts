/**
 * Seeds a real Sepolia Aave v3 loan (supplies DAI collateral, borrows USDC, mints spare USDC
 * for repay) on the configured Sepolia testnet wallet.
 * Requires ~0.05 Sepolia ETH for gas.
 */
import { DEFAULT_THRESHOLDS } from '@chainvision/shared';
import { loadConfig } from '../packages/server/src/config.js';
import { AaveSepoliaClient } from '../packages/server/src/protocols/aave.js';

async function main() {
  const config = loadConfig();
  const aave = new AaveSepoliaClient(config);

  const before = await aave.readSnapshot();
  console.log(`[setup:sepolia] Wallet ${before.address} ETH balance: ${before.ethBalance.toFixed(4)} ETH`);
  if (before.ethBalance < 0.005) {
    throw new Error(`Need at least 0.005 Sepolia ETH on ${before.address} to seed Aave position.`);
  }

  if ((before.eursBalance ?? 0) < 100) {
    console.log('[setup:sepolia] Minting 200 AaveEURS (open-cap Sepolia stablecoin) from Aave Faucet...');
    const tx = await aave.mintFromFaucet({ token: 'EURS', amount: 200 });
    console.log(`  mint EURS tx: https://sepolia.etherscan.io/tx/${tx}`);
  }

  if (before.usdcBalance < 500) {
    console.log('[setup:sepolia] Minting 1000 AaveUSDC from Aave Sepolia Faucet...');
    const tx = await aave.mintFromFaucet({ token: 'USDC', amount: 1000 });
    console.log(`  mint USDC tx: https://sepolia.etherscan.io/tx/${tx}`);
  }

  const mid = await aave.readSnapshot();
  if (mid.totalCollateralUsd < 200) {
    console.log('[setup:sepolia] Minting & supplying 0.015 AaveWBTC (non-isolated collateral) on Aave v3 Sepolia...');
    const mTx = await aave.mintFromFaucet({ token: 'WBTC', amount: 0.015 });
    console.log(`  mint WBTC tx: https://sepolia.etherscan.io/tx/${mTx}`);
    const sup = await aave.supply({
      token: 'WBTC',
      amount: 0.015,
      thresholds: { ...DEFAULT_THRESHOLDS, maxSingleActionUsd: 2500 },
    });
    console.log(`  supply WBTC tx: ${sup.explorerUrl}`);
  }

  const afterSup = await aave.readSnapshot();
  if (afterSup.totalDebtUsd < 50 && afterSup.availableBorrowsUsd > 60) {
    const borrowAmt = Math.max(50, Math.floor(afterSup.availableBorrowsUsd * 0.85));
    console.log(`[setup:sepolia] Borrowing ${borrowAmt} AaveUSDC on Aave v3 Sepolia (avail $${afterSup.availableBorrowsUsd.toFixed(0)})...`);
    const bTx = await aave.borrowForDemoSetup({ token: 'USDC', amount: borrowAmt });
    console.log(`  borrow USDC tx: https://sepolia.etherscan.io/tx/${bTx}`);
  }

  const finalSnap = await aave.readSnapshot();
  console.log('[setup:sepolia] Done:', {
    address: finalSnap.address,
    healthFactor: finalSnap.healthFactor?.toFixed(3) ?? null,
    totalCollateralUsd: finalSnap.totalCollateralUsd.toFixed(2),
    totalDebtUsd: finalSnap.totalDebtUsd.toFixed(2),
    usdcBalance: finalSnap.usdcBalance.toFixed(2),
    daiBalance: finalSnap.daiBalance.toFixed(2),
  });
}

main().catch((err) => {
  console.error('[setup:sepolia] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
