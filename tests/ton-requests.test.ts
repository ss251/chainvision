import { Address } from '@ton/core';
import { describe, expect, it } from 'vitest';
import { renderLensPage, validateLensLayout } from '@chainvision/shared';
import { loadConfig } from '../packages/server/src/config.js';
import type { CommandContext } from '../packages/server/src/telegram/bot.js';
import { testnetFriendly } from '../packages/server/src/ton/address.js';
import { ChainVisionEngine } from '../packages/server/src/watcher/engine.js';

const WEARER = '1000';
const KIT = '2000';
const KIT_TON = testnetFriendly(Address.parseRaw(`0:${'1f'.repeat(32)}`));

function ctx(from: string, text: string): CommandContext {
  return { chatId: from, isGroup: false, from: { id: from, firstName: 'Kit', username: 'kit' }, text, args: text.split(/\s+/).slice(1) };
}

function setup() {
  const engine = new ChainVisionEngine(loadConfig());
  engine.pairFromMiniApp({ code: engine.getSession().code, telegramChatId: WEARER });
  engine.pollNow = async () => ({}) as never;
  const sent: Array<{ to: string; amountNano: bigint; approved: string[] }> = [];
  engine.tonWallet.transfer = async (p) => {
    sent.push({ to: p.to, amountNano: p.amountNano, approved: [...p.approvedRecipientKeys] });
    return { txHash: 'cd'.repeat(32), messageHash: 'ef'.repeat(32), explorerUrl: `https://testnet.tonviewer.com/transaction/${'cd'.repeat(32)}`, from: 'app', to: p.to, amountNano: p.amountNano, beforeNano: 3_000_000_000n, afterNano: 1_000_000_000n };
  };
  return { engine, sent };
}

describe('TON money requests through Telegram (merged with the request flow)', () => {
  it('registers a TON address, asks "/ask 2 TON", shows one line and pays only on a tap', async () => {
    const { engine, sent } = setup();
    expect((await engine.handleRegister(ctx(KIT, `/register ${KIT_TON} Kit`))).text).toMatch(/TON testnet/);
    expect((await engine.handleAsk(ctx(KIT, '/ask 2 TON'))).text).toMatch(/not approved/);
    engine.requests.approve(KIT, Date.now());
    expect((await engine.handleAsk(ctx(KIT, '/ask 20 USDC'))).text).toMatch(/Sepolia address first/);
    expect((await engine.handleAsk(ctx(KIT, '/ask 3 TON'))).text).toMatch(/capped at 2 TON/);
    expect((await engine.handleAsk(ctx(KIT, '/ask 2 TON'))).text).toMatch(/Sent to the wearer: 2 TON/);
    expect(sent).toHaveLength(0);

    const state = engine.getLensState();
    const layout = renderLensPage(state);
    expect(validateLensLayout(layout).errors).toEqual([]);
    expect(layout.textObject[0]?.content).toBe('KIT ASKS 2 TON - TAP: PAY');

    const receipt = await engine.confirmPendingAction(state.signal!.action!.id);
    expect(receipt).toMatchObject({ protocol: 'ton', network: 'ton-testnet', summary: 'PAID 2 TON TO KIT' });
    expect(sent).toEqual([{ to: KIT_TON, amountNano: 2_000_000_000n, approved: [`0:${'1f'.repeat(32)}`] }]);
    const request = engine.requests.requests[0]!;
    expect(request).toMatchObject({ currency: 'TON', status: 'paid', resolvedVia: 'glasses_tap' });
    expect(engine.requests.payouts[0]).toMatchObject({ currency: 'TON', amount: 2 });
    expect(engine.requests.paidLastDay(Date.now())).toBe(0);
    expect(engine.getLensState().signal).toBeNull();
  });

  it('a swipe declines a TON request and nothing is sent', async () => {
    const { engine, sent } = setup();
    await engine.handleRegister(ctx(KIT, `/register ${KIT_TON} Kit`));
    engine.requests.approve(KIT, Date.now());
    await engine.handleAsk(ctx(KIT, '/ask 0.5 TON'));
    engine.dismissToBlank();
    await new Promise((r) => setTimeout(r, 10));
    expect(engine.requests.requests[0]?.status).toBe('declined');
    expect(sent).toHaveLength(0);
  });
});
