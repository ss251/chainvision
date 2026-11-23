import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import type { WsClientMessage } from '@chainvision/shared';
import { loadConfig } from './config.js';
import { ChainVisionEngine } from './watcher/engine.js';

function setCors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  setCors(res);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function readBody(req: http.IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error('Request payload too large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function createServer() {
  const config = loadConfig();
  const engine = new ChainVisionEngine(config);
  const miniappDist = path.resolve(import.meta.dirname, '../../miniapp/dist');

  const server = http.createServer(async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

    try {
      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          service: 'chainvision-server',
          network: 'sepolia+hyperliquid-testnet',
          openRouterConfigured: Boolean(config.openRouterApiKey),
          telegramConfigured: Boolean(config.telegramBotToken),
          walletConnectConfigured: Boolean(config.walletConnectProjectId),
          sepoliaAddress: config.sepoliaAddress,
          hyperliquidAgentAddress: config.hyperliquidAgentAddress,
          hyperliquidAccountConfigured: Boolean(config.hyperliquidAccountAddress),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        sendJson(res, 200, {
          state: engine.getLensState(),
          session: engine.getSession(),
          walletConnectProjectId: config.walletConnectProjectId,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/sync') {
        const snapshots = await engine.pollNow();
        sendJson(res, 200, { ok: true, snapshots, state: engine.getLensState() });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/pair') {
        const raw = (await readBody(req)).toString('utf8');
        const body = JSON.parse(raw || '{}') as {
          code?: string;
          walletAddress?: string;
          telegramChatId?: string;
          thresholds?: Record<string, unknown>;
        };
        const result = engine.pairFromMiniApp(body);
        sendJson(res, result.ok ? 200 : 400, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/thresholds') {
        const raw = (await readBody(req)).toString('utf8');
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        const thresholds = engine.updateThresholds(body);
        sendJson(res, 200, { ok: true, thresholds });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/voice/text') {
        const raw = (await readBody(req)).toString('utf8');
        const body = JSON.parse(raw || '{}') as { transcript?: string };
        const out = await engine.handleVoiceTranscript(body.transcript ?? '');
        sendJson(res, 200, {
          ok: true,
          transcript: body.transcript ?? '',
          parse: out.parse,
          pendingAction: out.pendingAction,
          state: engine.getLensState(),
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/voice/pcm') {
        const pcm = await readBody(req, 5 * 1024 * 1024);
        const stt = await engine.stt.transcribePcm16(pcm);
        const out = await engine.handleVoiceTranscript(stt.transcript);
        sendJson(res, 200, {
          ok: true,
          stt,
          parse: out.parse,
          pendingAction: out.pendingAction,
          state: engine.getLensState(),
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/actions/confirm') {
        const raw = (await readBody(req)).toString('utf8');
        const body = JSON.parse(raw || '{}') as { actionId?: string; source?: string };
        if (body.source !== 'glasses_tap') {
          sendJson(res, 403, {
            ok: false,
            error: 'Execution requires explicit glasses_tap confirmation',
          });
          return;
        }
        const receipt = await engine.confirmPendingAction(body.actionId ?? '');
        sendJson(res, 200, { ok: true, receipt, state: engine.getLensState() });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/actions/dismiss') {
        const raw = (await readBody(req)).toString('utf8');
        const body = JSON.parse(raw || '{}') as { actionId?: string };
        engine.dismissToBlank(body.actionId);
        sendJson(res, 200, { ok: true, state: engine.getLensState() });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/view/positions') {
        engine.cyclePositionView();
        sendJson(res, 200, { ok: true, state: engine.getLensState() });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/telegram/share') {
        const last = engine.getLastReceipt();
        if (!last) {
          sendJson(res, 404, { ok: false, error: 'No receipt to share yet' });
          return;
        }
        const tg = await engine.telegram.sendReceipt(last, engine.getSession().telegramChatId);
        sendJson(res, 200, { ok: tg.sent, result: tg });
        return;
      }

      // Serve Telegram Mini App bundle at /miniapp
      if (req.method === 'GET' && (url.pathname === '/miniapp' || url.pathname.startsWith('/miniapp/'))) {
        const rel = url.pathname.replace(/^\/miniapp\/?/, '') || 'index.html';
        const candidate = path.join(miniappDist, rel);
        const safePath = candidate.startsWith(miniappDist) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
          ? candidate
          : path.join(miniappDist, 'index.html');
        if (fs.existsSync(safePath)) {
          const ext = path.extname(safePath);
          res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
          fs.createReadStream(safePath).pipe(res);
          return;
        }
      }

      sendJson(res, 404, { ok: false, error: 'Not found' });
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    const unsub = engine.subscribe((msg) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    });

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString('utf8')) as WsClientMessage;
        if (msg.type === 'tap_confirm') {
          await engine.confirmPendingAction(msg.actionId);
        } else if (msg.type === 'dismiss') {
          engine.dismissToBlank(msg.actionId);
        } else if (msg.type === 'cycle_view') {
          engine.cyclePositionView();
        } else if (msg.type === 'request_sync') {
          await engine.pollNow();
        }
      } catch (err) {
        if (ws.readyState === ws.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'error',
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
    });

    ws.on('close', unsub);
  });

  return { server, wss, engine, config };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { server, engine, config } = createServer();
  engine.start();
  server.listen(config.serverPort, '127.0.0.1', () => {
    console.log(
      `[ChainVision] Server listening on http://127.0.0.1:${config.serverPort} (pair code: ${engine.getSession().code})`,
    );
  });
}
