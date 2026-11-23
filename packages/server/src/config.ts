import fs from 'node:fs';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';

export const SEPOLIA_CHAIN_ID = 11155111 as const;
export const HYPERLIQUID_TESTNET_URL = 'https://api.hyperliquid-testnet.xyz' as const;

export const AAVE_V3_SEPOLIA = {
  pool: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
  poolDataProvider: '0x3e9708d80f7B3e43118013075F7e95CE3AB31F31',
  faucet: '0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D',
  wrappedTokenGatewayV3: '0x387d311e47e80b498169e6fb51d3193167d89F7D',
} as const;

export const UNISWAP_V3_SEPOLIA = {
  factory: '0x0227628f3F023bb0B980b67D528571c95c6DaC1c',
  swapRouter02: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E',
  quoterV2: '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3',
  positionManager: '0x1238536071E1c677A632429e3655c799b22cDA52',
  // Verified live Sepolia pools with deep liquidity
  pools: {
    wethCircleUsdc500: '0x3289680dd4d6c10bb19b899729cda5eef58aeff1',
    wethAaveUsdc3000: '0x9799b5edc1aa7d3fad350309b08df3f64914e244',
    aaveUsdcDai500: '0xb67391331625bd0be95e6898cae52070d953ae1f',
  },
} as const;

export const SEPOLIA_TOKENS = {
  WETH9: {
    symbol: 'WETH',
    address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    decimals: 18,
  },
  CIRCLE_USDC: {
    symbol: 'USDC',
    address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    decimals: 6,
  },
  AAVE_USDC: {
    symbol: 'USDC',
    address: '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8',
    decimals: 6,
  },
  AAVE_DAI: {
    symbol: 'DAI',
    address: '0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357',
    decimals: 18,
  },
  AAVE_WETH: {
    symbol: 'WETH',
    address: '0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c',
    decimals: 18,
  },
  AAVE_WBTC: {
    symbol: 'WBTC',
    address: '0x29f2D40B0605204364af54EC677bD022dA425d03',
    decimals: 8,
  },
} as const;

export interface AppConfig {
  sepoliaRpcUrl: string;
  sepoliaPrivateKey: `0x${string}` | null;
  sepoliaAddress: `0x${string}`;
  hyperliquidApiUrl: string;
  hyperliquidAccountAddress: `0x${string}` | null;
  hyperliquidAgentPrivateKey: `0x${string}` | null;
  hyperliquidAgentAddress: `0x${string}` | null;
  openRouterApiKey: string | null;
  openRouterModel: string;
  telegramBotToken: string | null;
  telegramChatId: string | null;
  telegramMiniAppUrl: string | null;
  bybitTestnetApiKey: string | null;
  bybitTestnetApiSecret: string | null;
  binanceTestnetApiKey: string | null;
  binanceTestnetApiSecret: string | null;
  walletConnectProjectId: string | null;
  whisperModelPath: string | null;
  whisperPort: number;
  serverPort: number;
  serverPublicUrl: string;
  pollIntervalMs: number;
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val.length > 0) {
      out[key] = val;
    }
  }
  return out;
}

function loadLayeredEnv(): Record<string, string> {
  // Lower priority first, higher priority overwrites.
  // Dedicated secrets.env outside the repo takes priority over local-keys.env and .env,
  // while avoiding leaking unrelated host shell tokens (e.g. a different Telegram bot).
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const candidates = [
    path.join(repoRoot, '.env'),
    '/Users/thescoho/Developer/firstmate/data/chainvision-p1/local-keys.env',
    '/Users/thescoho/Developer/firstmate/data/chainvision-p1/secrets.env',
    process.env.CHAINVISION_ENV_FILE ?? '',
  ].filter(Boolean);

  const merged: Record<string, string> = {};
  for (const file of candidates) {
    Object.assign(merged, parseEnvFile(file));
  }

  // Only allow explicit CHAINVISION_* env overrides or non-empty values when not set by secrets files.
  for (const key of [
    'SEPOLIA_RPC_URL',
    'SEPOLIA_PRIVATE_KEY',
    'SEPOLIA_ADDRESS',
    'HYPERLIQUID_TESTNET_API_URL',
    'HYPERLIQUID_ACCOUNT_ADDRESS',
    'HYPERLIQUID_AGENT_PRIVATE_KEY',
    'HYPERLIQUID_AGENT_ADDRESS',
    'OPENROUTER_MODEL',
    'TELEGRAM_CHAT_ID',
    'TELEGRAM_MINIAPP_URL',
    'BYBIT_TESTNET_API_KEY',
    'BYBIT_TESTNET_API_SECRET',
    'BINANCE_TESTNET_API_KEY',
    'BINANCE_TESTNET_API_SECRET',
    'WALLETCONNECT_PROJECT_ID',
    'WHISPER_MODEL_PATH',
    'WHISPER_PORT',
    'SERVER_PORT',
    'SERVER_PUBLIC_URL',
    'POLL_INTERVAL_MS',
  ]) {
    if (!merged[key] && process.env[key]) {
      merged[key] = process.env[key]!;
    }
  }

  // Explicit prefixed overrides for sensitive keys so host env keys for other apps are never hijacked
  if (process.env.CHAINVISION_OPENROUTER_API_KEY) {
    merged.OPENROUTER_API_KEY = process.env.CHAINVISION_OPENROUTER_API_KEY;
  }
  if (process.env.CHAINVISION_TELEGRAM_BOT_TOKEN) {
    merged.TELEGRAM_BOT_TOKEN = process.env.CHAINVISION_TELEGRAM_BOT_TOKEN;
  }

  return merged;
}

function asHexKey(val: string | undefined): `0x${string}` | null {
  if (!val) return null;
  const trimmed = val.trim();
  const normalized = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) return null;
  return normalized as `0x${string}`;
}

function asAddress(val: string | undefined): `0x${string}` | null {
  if (!val) return null;
  const trimmed = val.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null;
  return trimmed as `0x${string}`;
}

export function loadConfig(): AppConfig {
  const env = loadLayeredEnv();

  const hlUrl = env.HYPERLIQUID_TESTNET_API_URL || HYPERLIQUID_TESTNET_URL;
  if (!hlUrl.includes('testnet')) {
    throw new Error(`Refusing non-testnet Hyperliquid URL: ${hlUrl}`);
  }

  const sepoliaPrivateKey = asHexKey(env.SEPOLIA_PRIVATE_KEY);
  const derivedSepoliaAddr = sepoliaPrivateKey
    ? privateKeyToAccount(sepoliaPrivateKey).address
    : null;
  const sepoliaAddress =
    derivedSepoliaAddr ??
    asAddress(env.SEPOLIA_ADDRESS) ??
    ('0x537B1ED6f937C1A27e7C6249026732565B381fB0' as `0x${string}`);

  const hlAgentKey = asHexKey(env.HYPERLIQUID_AGENT_PRIVATE_KEY);
  const hlAgentAddress = hlAgentKey
    ? privateKeyToAccount(hlAgentKey).address
    : asAddress(env.HYPERLIQUID_AGENT_ADDRESS);

  const hlAccountAddress = asAddress(env.HYPERLIQUID_ACCOUNT_ADDRESS);

  return {
    sepoliaRpcUrl: env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
    sepoliaPrivateKey,
    sepoliaAddress,
    hyperliquidApiUrl: hlUrl,
    hyperliquidAccountAddress: hlAccountAddress,
    hyperliquidAgentPrivateKey: hlAgentKey,
    hyperliquidAgentAddress: hlAgentAddress,
    openRouterApiKey: env.OPENROUTER_API_KEY || null,
    openRouterModel: env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || null,
    telegramChatId: env.TELEGRAM_CHAT_ID || null,
    telegramMiniAppUrl: env.TELEGRAM_MINIAPP_URL || null,
    bybitTestnetApiKey: env.BYBIT_TESTNET_API_KEY || null,
    bybitTestnetApiSecret: env.BYBIT_TESTNET_API_SECRET || null,
    binanceTestnetApiKey: env.BINANCE_TESTNET_API_KEY || null,
    binanceTestnetApiSecret: env.BINANCE_TESTNET_API_SECRET || null,
    walletConnectProjectId: env.WALLETCONNECT_PROJECT_ID || null,
    whisperModelPath: env.WHISPER_MODEL_PATH || null,
    whisperPort: Number(env.WHISPER_PORT || 8178),
    serverPort: Number(env.SERVER_PORT || 8787),
    serverPublicUrl: env.SERVER_PUBLIC_URL || `http://127.0.0.1:${env.SERVER_PORT || 8787}`,
    pollIntervalMs: Number(env.POLL_INTERVAL_MS || 15000),
  };
}
