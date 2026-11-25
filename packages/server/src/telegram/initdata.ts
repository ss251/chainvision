import crypto from 'node:crypto';

/**
 * Validates Telegram Mini App initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 * the hash is HMAC-SHA256 of the sorted fields, keyed by HMAC-SHA256("WebAppData", bot token).
 */
export function verifyInitData(
  initData: string,
  botToken: string,
  now = Date.now(),
  maxAgeSec = 24 * 60 * 60,
): { ok: true; userId: string } | { ok: false; reason: string } {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'missing hash' };
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (expected.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash))) {
    return { ok: false, reason: 'bad hash' };
  }
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || now / 1000 - authDate > maxAgeSec) return { ok: false, reason: 'expired' };
  try {
    const user = JSON.parse(params.get('user') ?? '{}') as { id?: number };
    if (!user.id) return { ok: false, reason: 'no user' };
    return { ok: true, userId: String(user.id) };
  } catch {
    return { ok: false, reason: 'bad user' };
  }
}

/**
 * The wearer is either the paired Telegram user, proven by Mini App initData, or someone at this
 * computer: a direct loopback request that did not come through a proxy or tunnel.
 */
export function isWearerRequest(params: {
  initData: string | undefined;
  botToken: string | null;
  wearerChatId: string | null;
  remoteAddress: string | undefined;
  host: string | undefined;
  forwarded: boolean;
  now?: number;
}): boolean {
  if (params.initData && params.botToken && params.wearerChatId) {
    const v = verifyInitData(params.initData, params.botToken, params.now);
    return v.ok && v.userId === params.wearerChatId;
  }
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(params.remoteAddress ?? '');
  const localHost = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(params.host ?? '');
  return loopback && localHost && !params.forwarded;
}
