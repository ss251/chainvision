import type { ExecutionReceipt, ProtocolSnapshots } from '@chainvision/shared';
import type { AppConfig } from '../config.js';

export interface TelegramUser {
  id: string;
  firstName: string;
  username: string | null;
}

export interface CommandContext {
  chatId: string;
  isGroup: boolean;
  from: TelegramUser;
  text: string;
  args: string[];
}

export interface BotReply {
  text: string;
  keyboard?: Record<string, unknown>;
}

export interface CallbackContext {
  data: string;
  from: TelegramUser;
  chatId: string | null;
  messageId: number | null;
}

export interface CallbackReply {
  answer?: string;
  editText?: string;
  keyboard?: Record<string, unknown>;
}

export interface TelegramBotHandlers {
  onPairCode: (code: string, chatId: string) => { ok: boolean; message: string };
  onStatusRequest: () => Promise<ProtocolSnapshots>;
  onGetLastReceipt: () => ExecutionReceipt | null;
  onRegister?: (ctx: CommandContext) => Promise<BotReply> | BotReply;
  onAsk?: (ctx: CommandContext) => Promise<BotReply> | BotReply;
  onCallback?: (ctx: CallbackContext) => Promise<CallbackReply> | CallbackReply;
}

interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type?: string };
    from?: TgUser;
    text?: string;
  };
  callback_query?: {
    id: string;
    from: TgUser;
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

function toUser(u: TgUser | undefined, fallbackId: string): TelegramUser {
  return { id: u ? String(u.id) : fallbackId, firstName: u?.first_name ?? '', username: u?.username ?? null };
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
  private username: string | null | undefined;

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

  async discoverChatIdFromUpdates(): Promise<string | null> {
    if (!this.isConfigured) return null;
    if (this.lastKnownChatId) return this.lastKnownChatId;
    try {
      const updates = await this.api<
        Array<{ update_id: number; message?: { chat?: { id?: number } } }>
      >('getUpdates', { limit: 20, timeout: 0 });
      for (let i = updates.length - 1; i >= 0; i--) {
        const cid = updates[i]?.message?.chat?.id;
        if (cid !== undefined) {
          this.lastKnownChatId = String(cid);
          return this.lastKnownChatId;
        }
      }
    } catch {
      // ignore discovery error
    }
    return null;
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

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    await this.api('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
  }

  async editMessage(chatId: string, messageId: number, text: string, replyMarkup?: Record<string, unknown>): Promise<void> {
    await this.api('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      reply_markup: replyMarkup ?? { inline_keyboard: [] },
    });
  }

  /** Bot username, read once with getMe; used to ignore commands addressed to other bots in groups. */
  async resolveUsername(): Promise<string | null> {
    if (this.username === undefined) {
      this.username = await this.getMe()
        .then((me) => me.username ?? null)
        .catch(() => undefined);
    }
    return this.username ?? null;
  }

  /**
   * Handle one Bot API update. Returns the ids of the messages sent in reply.
   * In groups a command may be written /ask@thisbot; commands for other bots are ignored.
   */
  async handleUpdate(update: TelegramUpdate, handlers: TelegramBotHandlers): Promise<number[]> {
    const sent: number[] = [];
    const reply = async (chatId: string, text: string, keyboard?: Record<string, unknown>) => {
      const res = await this.sendMessage(chatId, text, keyboard);
      sent.push(res.message_id);
    };

    const cb = update.callback_query;
    if (cb) {
      const out = handlers.onCallback
        ? await handlers.onCallback({
            data: cb.data ?? '',
            from: toUser(cb.from, ''),
            chatId: cb.message ? String(cb.message.chat.id) : null,
            messageId: cb.message?.message_id ?? null,
          })
        : {};
      await this.answerCallback(cb.id, out.answer).catch(() => {});
      if (out.editText && cb.message) {
        await this.editMessage(String(cb.message.chat.id), cb.message.message_id, out.editText, out.keyboard);
      }
      return sent;
    }

    const msg = update.message;
    if (!msg?.text) return sent;
    const chatId = String(msg.chat.id);
    if (!this.lastKnownChatId) this.lastKnownChatId = chatId;
    const text = msg.text.trim();
    const [head = '', ...args] = text.split(/\s+/);
    const [command = '', target] = head.split('@');
    if (target) {
      const me = await this.resolveUsername();
      if (me && target.toLowerCase() !== me.toLowerCase()) return sent;
    }
    const ctx: CommandContext = {
      chatId,
      isGroup: msg.chat.type === 'group' || msg.chat.type === 'supergroup',
      from: toUser(msg.from, chatId),
      text,
      args,
    };

    if (command === '/start') {
      const code = args[0];
      if (code) {
        const res = handlers.onPairCode(code, chatId);
        await reply(chatId, res.message);
      } else {
        const keyboard =
          this.config.telegramMiniAppUrl && !ctx.isGroup
            ? { inline_keyboard: [[{ text: 'Open ChainVision Setup', web_app: { url: this.config.telegramMiniAppUrl } }]] }
            : undefined;
        await reply(
          chatId,
          [
            'ChainVision G2 (Testnet Only)',
            'Commands:',
            '/pair <6-digit-code> — bind this chat to your glasses',
            '/status — live Sepolia & Hyperliquid testnet snapshot',
            '/share — format last receipt for group sharing',
            '/register <Sepolia address> <name> — become a known requester (private chat)',
            '/ask <amount> USDC — ask the wearer for testnet USDC (in a group: /ask@<this bot> <amount> USDC)',
            'Not financial advice · Non-custodial',
          ].join('\n'),
          keyboard,
        );
      }
    } else if (command === '/pair') {
      const res = handlers.onPairCode(args[0] ?? '', chatId);
      await reply(chatId, res.message);
    } else if (command === '/status') {
      const snap = await handlers.onStatusRequest();
      await reply(chatId, formatSnapshotText(snap));
    } else if (command === '/share') {
      const last = handlers.onGetLastReceipt();
      if (!last) {
        await reply(chatId, 'No testnet execution receipt recorded yet.');
      } else {
        const shareText = formatShareSnippet(last);
        await reply(chatId, shareText, {
          inline_keyboard: [[{ text: 'Forward to Group', switch_inline_query: shareText }]],
        });
      }
    } else if (command === '/register' && handlers.onRegister) {
      const out = await handlers.onRegister(ctx);
      await reply(chatId, out.text, out.keyboard);
    } else if (command === '/ask' && handlers.onAsk) {
      const out = await handlers.onAsk(ctx);
      await reply(chatId, out.text, out.keyboard);
    }
    return sent;
  }

  private async pollLoop(handlers: TelegramBotHandlers): Promise<void> {
    await this.resolveUsername();
    while (this.polling) {
      try {
        const updates = await this.api<TelegramUpdate[]>('getUpdates', {
          offset: this.offset,
          timeout: 10,
          allowed_updates: ['message', 'callback_query'],
        });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handleUpdate(u, handlers).catch((err) => {
            console.error('[ChainVision] Telegram update failed:', err instanceof Error ? err.message : String(err));
          });
        }
      } catch {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
}
