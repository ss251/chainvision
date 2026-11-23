import type { ExecutionReceipt, ProtocolSnapshots } from '@chainvision/shared';
import type { AppConfig } from '../config.js';

export interface TelegramBotHandlers {
  onPairCode: (code: string, chatId: string) => { ok: boolean; message: string };
  onStatusRequest: () => Promise<ProtocolSnapshots>;
  onGetLastReceipt: () => ExecutionReceipt | null;
}

export function formatReceiptText(receipt: ExecutionReceipt): string {
  const ts = new Date(receipt.timestamp).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  return [
    `ChainVision Testnet Receipt`,
    `Action: ${receipt.summary}`,
    `Network: ${receipt.network}`,
    `Before: ${receipt.beforeFact}`,
    `After: ${receipt.afterFact}`,
    `ID: ${receipt.txHashOrOrderId}`,
    `Explorer: ${receipt.explorerUrl}`,
    `Time: ${ts}`,
    `Testnet only · Non-custodial · Not financial advice`,
  ].join('\n');
}

export function formatShareSnippet(receipt: ExecutionReceipt): string {
  return [
    `[ChainVision Testnet] ${receipt.summary}`,
    `${receipt.beforeFact} -> ${receipt.afterFact}`,
    `Proof: ${receipt.explorerUrl}`,
    `(Testnet only, not financial advice)`,
  ].join('\n');
}

export function formatSnapshotText(s: ProtocolSnapshots): string {
  const hf = s.aave.healthFactor === null ? 'No debt' : s.aave.healthFactor.toFixed(2);
  const hlPos = s.hyperliquid.positions[0];
  const hlLine = hlPos
    ? `${hlPos.coin}-PERP ${hlPos.side} ${hlPos.size} @ $${hlPos.markPx.toFixed(2)} (liq dist ${hlPos.liqDistancePct !== null ? hlPos.liqDistancePct.toFixed(1) + '%' : 'N/A'})`
    : `No open perp (ETH mark $${s.hyperliquid.ethMarkPx.toFixed(2)}, equity $${s.hyperliquid.accountValueUsd.toFixed(2)})`;
  const lpLine = s.uniswap.lpPositions[0]
    ? `LP #${s.uniswap.lpPositions[0].tokenId}: ${s.uniswap.lpPositions[0].inRange ? 'In range' : 'Out of range'}`
    : `0 LP NFTs (WETH/USDC quote $${s.uniswap.ethQuoteUsdc.toFixed(2)})`;
  const exLine = `${s.exchange.venue} (${s.exchange.mode}): ETH $${s.exchange.ethMarkPx.toFixed(2)}, funding ${s.exchange.ethFundingPct.toFixed(4)}%`;

  return [
    `ChainVision Live Testnet Snapshot`,
    `Aave v3 Sepolia: Health ${hf} | Collateral $${s.aave.totalCollateralUsd.toFixed(2)} | Debt $${s.aave.totalDebtUsd.toFixed(2)}`,
    `Hyperliquid Testnet: ${hlLine}`,
    `Uniswap v3 Sepolia: ${lpLine}`,
    `Exchange Watcher: ${exLine}`,
    `Testnet only · Facts only, not financial advice`,
  ].join('\n');
}

export class TelegramBotService {
  private readonly config: AppConfig;
  private polling = false;
  private offset = 0;
  private lastKnownChatId: string | null;

  constructor(config: AppConfig) {
    this.config = config;
    this.lastKnownChatId = config.telegramChatId;
  }

  get isConfigured(): boolean {
    return Boolean(this.config.telegramBotToken);
  }

  get chatId(): string | null {
    return this.lastKnownChatId;
  }

  setChatId(chatId: string): void {
    this.lastKnownChatId = chatId;
  }

  private async api<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    if (!this.config.telegramBotToken) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }
    const res = await fetch(`https://api.telegram.org/bot${this.config.telegramBotToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15000),
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) {
      throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`);
    }
    return json.result as T;
  }

  async getMe(): Promise<{ id: number; username?: string; first_name?: string }> {
    return this.api('getMe');
  }

  async sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: Record<string, unknown>,
  ): Promise<{ message_id: number }> {
    return this.api('sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  async sendReceipt(
    receipt: ExecutionReceipt,
    overrideChatId?: string | null,
  ): Promise<{ sent: boolean; messageId?: number; error?: string }> {
    const targetChat = overrideChatId ?? this.lastKnownChatId;
    if (!this.isConfigured || !targetChat) {
      return { sent: false, error: 'Telegram bot token or chat_id not configured' };
    }
    try {
      const text = formatReceiptText(receipt);
      const shareText = formatShareSnippet(receipt);
      const res = await this.sendMessage(targetChat, text, {
        inline_keyboard: [
          [
            { text: 'View on Explorer', url: receipt.explorerUrl },
            { text: 'Share to Group', switch_inline_query: shareText },
          ],
        ],
      });
      return { sent: true, messageId: res.message_id };
    } catch (err) {
      return { sent: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  startPolling(handlers: TelegramBotHandlers): void {
    if (!this.isConfigured || this.polling) return;
    this.polling = true;
    void this.pollLoop(handlers);
  }

  stopPolling(): void {
    this.polling = false;
  }

  private async pollLoop(handlers: TelegramBotHandlers): Promise<void> {
    while (this.polling) {
      try {
        const updates = await this.api<
          Array<{
            update_id: number;
            message?: { chat: { id: number }; text?: string };
          }>
        >('getUpdates', { offset: this.offset, timeout: 10 });

        for (const u of updates) {
          this.offset = u.update_id + 1;
          const msg = u.message;
          if (!msg?.text) continue;
          const chatId = String(msg.chat.id);
          this.lastKnownChatId = chatId;
          const text = msg.text.trim();

          if (text.startsWith('/start')) {
            const parts = text.split(/\s+/);
            const code = parts[1];
            if (code) {
              const res = handlers.onPairCode(code, chatId);
              await this.sendMessage(chatId, res.message);
            } else {
              const keyboard = this.config.telegramMiniAppUrl
                ? {
                    inline_keyboard: [
                      [{ text: 'Open ChainVision Setup', web_app: { url: this.config.telegramMiniAppUrl } }],
                    ],
                  }
                : undefined;
              await this.sendMessage(
                chatId,
                [
                  'ChainVision G2 (Testnet Only)',
                  'Commands:',
                  '/pair <6-digit-code> — bind this chat to your glasses',
                  '/status — live Sepolia & Hyperliquid testnet snapshot',
                  '/share — format last receipt for group sharing',
                  'Not financial advice · Non-custodial',
                ].join('\n'),
                keyboard,
              );
            }
          } else if (text.startsWith('/pair')) {
            const code = text.split(/\s+/)[1] ?? '';
            const res = handlers.onPairCode(code, chatId);
            await this.sendMessage(chatId, res.message);
          } else if (text.startsWith('/status')) {
            const snap = await handlers.onStatusRequest();
            await this.sendMessage(chatId, formatSnapshotText(snap));
          } else if (text.startsWith('/share')) {
            const last = handlers.onGetLastReceipt();
            if (!last) {
              await this.sendMessage(chatId, 'No testnet execution receipt recorded yet.');
            } else {
              const shareText = formatShareSnippet(last);
              await this.sendMessage(chatId, shareText, {
                inline_keyboard: [[{ text: 'Forward to Group', switch_inline_query: shareText }]],
              });
            }
          }
        }
      } catch {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
}
