import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AppConfig } from '../config.js';

const execFileAsync = promisify(execFile);

/**
 * Wraps raw 16 kHz mono signed 16-bit little-endian PCM into a standard RIFF/WAV buffer.
 */
export function pcm16ToWav(pcm: Buffer, sampleRate = 16000, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

const DOMAIN_PROMPT =
  'Aave, Uniswap, Hyperliquid, USDC, ETH, WETH, DAI, repay, supply, swap, trim, health factor, perp.';

export class WhisperSttService {
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async transcribePcm16(pcm: Buffer): Promise<{ transcript: string; latencyMs: number; engine: string }> {
    const t0 = Date.now();
    if (pcm.length < 3200) {
      return { transcript: '', latencyMs: Date.now() - t0, engine: 'empty' };
    }

    const wav = pcm16ToWav(pcm);

    // 1. Try warm local whisper-server first (<100ms)
    try {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
      form.append('response_format', 'json');
      form.append('prompt', DOMAIN_PROMPT);

      const res = await fetch(`http://127.0.0.1:${this.config.whisperPort}/inference`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const j = (await res.json()) as { text?: string };
        const clean = (j.text ?? '').replace(/\[BLANK_AUDIO\]/gi, '').trim();
        return { transcript: clean, latencyMs: Date.now() - t0, engine: 'whisper-server' };
      }
    } catch {
      // Fall through to whisper-cli
    }

    // 2. Fallback to whisper-cli if model file exists
    const modelPath = this.config.whisperModelPath;
    if (!modelPath || !fs.existsSync(modelPath)) {
      throw new Error('Whisper STT unavailable: start whisper-server or set WHISPER_MODEL_PATH');
    }

    const tmpWav = path.join(os.tmpdir(), `chainvision-stt-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
    try {
      fs.writeFileSync(tmpWav, wav);
      const { stdout } = await execFileAsync(
        'whisper-cli',
        ['-m', modelPath, '-f', tmpWav, '--no-timestamps', '--prompt', DOMAIN_PROMPT],
        { timeout: 15000 },
      );
      const clean = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('['))
        .join(' ')
        .replace(/\[BLANK_AUDIO\]/gi, '')
        .trim();
      return { transcript: clean, latencyMs: Date.now() - t0, engine: 'whisper-cli' };
    } finally {
      fs.rmSync(tmpWav, { force: true });
    }
  }
}
