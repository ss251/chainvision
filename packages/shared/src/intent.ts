import { z } from 'zod';
import { EXCHANGE_INTENT_PROMPT, EXCHANGE_INTENT_SCHEMAS, parseExchangeIntentLocally } from './exchange.js';

export const VoiceIntentSchema = z.discriminatedUnion('action', [
  ...EXCHANGE_INTENT_SCHEMAS,
  z.object({
    action: z.literal('aave_supply'),
    token: z.enum(['USDC', 'DAI', 'ETH', 'EURS']),
    amount: z.number().positive(),
    compareVenues: z.boolean().default(true),
    confidence: z.number().min(0).max(1).default(0.9),
  }),
  z.object({
    action: z.literal('aave_repay'),
    token: z.enum(['USDC', 'DAI']),
    amount: z.number().positive(),
    confidence: z.number().min(0).max(1).default(0.9),
  }),
  z.object({
    action: z.literal('uniswap_swap'),
    tokenIn: z.enum(['ETH', 'WETH', 'USDC', 'DAI']),
    tokenOut: z.enum(['ETH', 'WETH', 'USDC', 'DAI']),
    amount: z.number().positive().optional(),
    amountPct: z.number().min(1).max(100).optional(),
    confidence: z.number().min(0).max(1).default(0.9),
  }),
  z.object({
    action: z.literal('hl_trim'),
    coin: z.enum(['ETH', 'BTC', 'SOL']),
    amountPct: z.number().min(1).max(100),
    confidence: z.number().min(0).max(1).default(0.9),
  }),
  z.object({
    action: z.literal('status'),
    protocol: z.enum(['all', 'aave', 'uniswap', 'hyperliquid', 'exchange']).default('all'),
    confidence: z.number().min(0).max(1).default(0.9),
  }),
  z.object({
    action: z.literal('brief'),
    confidence: z.number().min(0).max(1).default(0.9),
  }),
  z.object({
    action: z.literal('price_alert'),
    asset: z.enum(['ETH', 'BTC', 'SOL']),
    direction: z.enum(['below', 'above']),
    price: z.number().positive(),
    confidence: z.number().min(0).max(1).default(0.9),
  }),
  z.object({
    action: z.literal('unsupported'),
    reason: z.string().min(1).max(140),
    confidence: z.number().min(0).max(1).default(1),
  }),
]);

export type VoiceIntent = z.infer<typeof VoiceIntentSchema>;

export const INTENT_SYSTEM_PROMPT = `You are a strict JSON parser for ChainVision on Even G2 smart glasses (testnet only, non-custodial, no financial advice).
Convert the user's spoken crypto command into ONE JSON object matching one of these exact schemas:
1) {"action":"aave_supply","token":"USDC"|"DAI"|"ETH","amount":<number>,"compareVenues":true,"confidence":0.95}
   Use for: "put 200 USDC to work", "supply 100 USDC to Aave", "deposit 50 DAI into Aave", "earn yield on 200 USDC".
2) {"action":"aave_repay","token":"USDC"|"DAI","amount":<number>,"confidence":0.95}
   Use for: "repay 300 USDC", "pay back 100 USDC Aave loan".
3) {"action":"uniswap_swap","tokenIn":"ETH"|"WETH"|"USDC"|"DAI","tokenOut":"ETH"|"WETH"|"USDC"|"DAI","amount":<number optional>,"amountPct":<1..100 optional>,"confidence":0.95}
   Use for: "swap half my ETH to USDC" (amountPct:50), "swap 0.01 ETH to USDC" (amount:0.01), "swap 25 USDC to DAI".
   Ensure tokenIn != tokenOut and either amount or amountPct is present.
4) {"action":"hl_trim","coin":"ETH"|"BTC"|"SOL","amountPct":<1..100>,"confidence":0.95}
   Use for: "trim half my ETH perp" (amountPct:50), "close ETH position" (amountPct:100), "reduce BTC by 25 percent".
5) {"action":"status","protocol":"all"|"aave"|"uniswap"|"hyperliquid"|"exchange","confidence":0.95}
   Use for: "check my health factor", "show my positions".
6) {"action":"brief","confidence":0.95}
   Use for: "what matters?", "anything I need to know?", "brief me", "what needs me?".
7) {"action":"price_alert","asset":"ETH"|"BTC"|"SOL","direction":"below"|"above","price":<number>,"confidence":0.95}
   Use for: "tell me if ETH drops below 1700" (direction:"below"), "alert me when BTC goes above 70000" (direction:"above"), "let me know if SOL falls under 120".
   Only ETH, BTC and SOL are supported; any other asset, or no clear direction or price, is unsupported.
8) {"action":"unsupported","reason":"<short factual reason>","confidence":1}
   Use for: withdrawals, transfers to external wallets, mainnet requests, financial advice questions, or unclear commands.
${EXCHANGE_INTENT_PROMPT}

Output ONLY valid JSON with no markdown fences and no extra text.`;

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  ten: 10,
  twenty: 20,
  twentyfive: 25,
  thirty: 30,
  forty: 40,
  fifty: 50,
  hundred: 100,
  twohundred: 200,
  threehundred: 300,
};

function extractNumber(text: string): number | undefined {
  const numMatch = text.match(/(\d+(?:\.\d+)?)/);
  if (numMatch?.[1]) {
    const val = Number(numMatch[1]);
    if (Number.isFinite(val) && val > 0) return val;
  }
  const compact = text.toLowerCase().replace(/[^a-z\s]/g, ' ');
  for (const [word, val] of Object.entries(WORD_NUMBERS)) {
    if (compact.includes(word)) return val;
  }
  return undefined;
}

function normalizeToken(raw: string): 'ETH' | 'WETH' | 'USDC' | 'DAI' | null {
  const t = raw.toUpperCase();
  if (t === 'ETH' || t === 'ETHER' || t === 'ETHEREUM') return 'ETH';
  if (t === 'WETH') return 'WETH';
  if (t === 'USDC' || t === 'USD' || t === 'DOLLARS') return 'USDC';
  if (t === 'DAI') return 'DAI';
  return null;
}

export function parseIntentJson(raw: string): VoiceIntent {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { action: 'unsupported', reason: 'Invalid JSON from intent model', confidence: 1 };
  }

  const result = VoiceIntentSchema.safeParse(parsed);
  if (!result.success) {
    return {
      action: 'unsupported',
      reason: `Schema mismatch: ${result.error.issues[0]?.message ?? 'invalid intent'}`,
      confidence: 1,
    };
  }

  const intent = result.data;
  if (intent.action === 'uniswap_swap') {
    if (intent.tokenIn === intent.tokenOut) {
      return { action: 'unsupported', reason: 'Swap input and output tokens must differ', confidence: 1 };
    }
    if (intent.amount === undefined && intent.amountPct === undefined) {
      return { action: 'unsupported', reason: 'Swap requires an amount or percentage', confidence: 1 };
    }
  }
  return intent;
}

/**
 * Deterministic local parser used as an offline stub (when OPENROUTER_API_KEY is unset)
 * and as a fast safety cross-check in tests.
 */
export function parseVoiceIntentLocally(transcript: string): VoiceIntent {
  const raw = transcript.trim();
  const lower = raw.toLowerCase();

  if (!raw || raw.length < 3) {
    return { action: 'unsupported', reason: 'Empty speech transcript', confidence: 1 };
  }

  // Hard safety blocks: never withdraw, transfer out, or touch mainnet
  if (/\b(withdraw|send to|transfer out|mainnet|drain|private key|seed phrase)\b/.test(lower)) {
    return { action: 'unsupported', reason: 'Blocked: withdrawals and mainnet actions are disabled', confidence: 1 };
  }

  // Brief: "what matters?", "anything I need to know?"
  if (/\b(what matters|what needs me|what('s| is) important|anything i (need|should) (to )?know|brief me|briefing)\b/.test(lower)) {
    return { action: 'brief', confidence: 0.92 };
  }

  // Price alert: "tell me if ETH drops below 1700", "alert me when BTC goes above 70000"
  if (/\b(tell me|alert me|notify me|let me know|warn me|ping me)\b/.test(lower)) {
    const asset = /\b(btc|bitcoin)\b/.test(lower)
      ? 'BTC'
      : /\b(sol|solana)\b/.test(lower)
        ? 'SOL'
        : /\b(eth|ether|ethereum)\b/.test(lower)
          ? 'ETH'
          : null;
    const below = /\b(below|under|beneath|drops?|falls?|dips?|sinks?)\b/.test(lower);
    const above = /\b(above|over|rises?|climbs?|exceeds?)\b/.test(lower);
    const priceMatch = lower.replace(/,/g, '').match(/\$?(\d+(?:\.\d+)?)/);
    const price = priceMatch?.[1] ? Number(priceMatch[1]) : NaN;
    if (!asset || below === above || !Number.isFinite(price) || price <= 0) {
      return { action: 'unsupported', reason: 'Alerts need ETH, BTC or SOL, below or above, and a price', confidence: 0.9 };
    }
    return { action: 'price_alert', asset, direction: below ? 'below' : 'above', price, confidence: 0.92 };
  }

  const exchangeIntent = parseExchangeIntentLocally(lower);
  if (exchangeIntent) return exchangeIntent;

  // 1. Aave repay: "repay 300 USDC", "pay back 100 DAI"
  if (/\b(repay|pay back|payback)\b/.test(lower)) {
    const amount = extractNumber(lower);
    const token: 'USDC' | 'DAI' = /\bdai\b/.test(lower) ? 'DAI' : 'USDC';
    if (!amount) {
      return { action: 'unsupported', reason: 'Specify repay amount in USDC or DAI', confidence: 0.9 };
    }
    return { action: 'aave_repay', token, amount, confidence: 0.92 };
  }

  // 2. Aave supply / put to work: "put 200 USDC to work", "supply 100 USDC to Aave"
  if (/\b(put .+ to work|supply|deposit|lend|earn|yield)\b/.test(lower)) {
    const amount = extractNumber(lower);
    const token: 'USDC' | 'DAI' | 'ETH' = /\bdai\b/.test(lower)
      ? 'DAI'
      : /\b(eth|ether)\b/.test(lower)
        ? 'ETH'
        : 'USDC';
    if (!amount) {
      return { action: 'unsupported', reason: 'Specify amount to supply (e.g. 200 USDC)', confidence: 0.9 };
    }
    return {
      action: 'aave_supply',
      token,
      amount,
      compareVenues: true,
      confidence: 0.92,
    };
  }

  // 3. Uniswap swap: "swap half my ETH to USDC", "swap 0.01 ETH for USDC", "swap 25 USDC to DAI"
  if (/\b(swap|convert|exchange|trade)\b/.test(lower)) {
    const swapRegex = /\b(?:swap|convert|exchange|trade)\s+(?:(half|quarter|all|\d+(?:\.\d+)?%?)\s+(?:of\s+)?(?:my\s+)?)?(weth|eth|ether|usdc|dai)\s+(?:to|for|into)\s+(weth|eth|ether|usdc|dai)\b/i;
    const m = lower.match(swapRegex);
    if (m && m[2] && m[3]) {
      const tokenIn = normalizeToken(m[2]);
      const tokenOut = normalizeToken(m[3]);
      if (!tokenIn || !tokenOut || tokenIn === tokenOut) {
        return { action: 'unsupported', reason: 'Invalid swap token pair', confidence: 1 };
      }
      const qtyRaw = m[1] ?? '';
      if (qtyRaw === 'half') {
        return { action: 'uniswap_swap', tokenIn, tokenOut, amountPct: 50, confidence: 0.93 };
      }
      if (qtyRaw === 'quarter') {
        return { action: 'uniswap_swap', tokenIn, tokenOut, amountPct: 25, confidence: 0.93 };
      }
      if (qtyRaw === 'all') {
        return { action: 'uniswap_swap', tokenIn, tokenOut, amountPct: 100, confidence: 0.9 };
      }
      if (qtyRaw.endsWith('%')) {
        const pct = Number(qtyRaw.slice(0, -1));
        if (pct >= 1 && pct <= 100) {
          return { action: 'uniswap_swap', tokenIn, tokenOut, amountPct: pct, confidence: 0.92 };
        }
      }
      const amt = Number(qtyRaw);
      if (Number.isFinite(amt) && amt > 0) {
        return { action: 'uniswap_swap', tokenIn, tokenOut, amount: amt, confidence: 0.93 };
      }
    }
    return { action: 'unsupported', reason: 'Could not parse swap pair and amount', confidence: 0.85 };
  }

  // 4. Hyperliquid trim/reduce/close: "trim half my ETH", "close ETH perp", "reduce BTC 25%"
  if (/\b(trim|reduce|close|cut|flatten|de-risk)\b/.test(lower)) {
    const coin: 'ETH' | 'BTC' | 'SOL' = /\b(btc|bitcoin)\b/.test(lower)
      ? 'BTC'
      : /\b(sol|solana)\b/.test(lower)
        ? 'SOL'
        : 'ETH';
    let amountPct = 50;
    if (/\b(all|full|100%?|flatten)\b/.test(lower)) {
      amountPct = 100;
    } else if (/\bhalf\b/.test(lower)) {
      amountPct = 50;
    } else if (/\bquarter\b/.test(lower)) {
      amountPct = 25;
    } else {
      const pctMatch = lower.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)/);
      if (pctMatch?.[1]) {
        const v = Number(pctMatch[1]);
        if (v >= 1 && v <= 100) amountPct = v;
      }
    }
    return { action: 'hl_trim', coin, amountPct, confidence: 0.92 };
  }

  // 5. Status check
  if (/\b(status|health|position|positions|balance|check|portfolio)\b/.test(lower)) {
    const protocol = /\baave\b/.test(lower)
      ? 'aave'
      : /\buni/.test(lower)
        ? 'uniswap'
        : /\b(hyper|hl|perp)\b/.test(lower)
          ? 'hyperliquid'
          : /\b(bybit|binance|exchange)\b/.test(lower)
            ? 'exchange'
            : 'all';
    return { action: 'status', protocol, confidence: 0.9 };
  }

  return { action: 'unsupported', reason: 'Unrecognized voice command', confidence: 0.8 };
}
