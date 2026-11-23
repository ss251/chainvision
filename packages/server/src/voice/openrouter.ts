import {
  INTENT_SYSTEM_PROMPT,
  parseIntentJson,
  parseVoiceIntentLocally,
  type VoiceIntent,
} from '@chainvision/shared';
import type { AppConfig } from '../config.js';

export interface IntentParseResult {
  intent: VoiceIntent;
  provider: 'openrouter' | 'local-stub';
  model: string;
  latencyMs: number;
  fallbackReason?: string;
}

export class VoiceIntentService {
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async parseTranscript(transcript: string): Promise<IntentParseResult> {
    const t0 = Date.now();
    const cleaned = transcript.trim();
    if (!cleaned) {
      return {
        intent: { action: 'unsupported', reason: 'Empty speech transcript', confidence: 1 },
        provider: 'local-stub',
        model: 'local-rules',
        latencyMs: 0,
      };
    }

    if (!this.config.openRouterApiKey) {
      return {
        intent: parseVoiceIntentLocally(cleaned),
        provider: 'local-stub',
        model: 'local-rules',
        latencyMs: Date.now() - t0,
        fallbackReason: 'OPENROUTER_API_KEY not configured',
      };
    }

    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.openRouterApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://chainvision.local',
          'X-Title': 'ChainVision G2',
        },
        body: JSON.stringify({
          model: this.config.openRouterModel,
          temperature: 0,
          max_tokens: 140,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: INTENT_SYSTEM_PROMPT },
            { role: 'user', content: cleaned },
          ],
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        return {
          intent: parseVoiceIntentLocally(cleaned),
          provider: 'local-stub',
          model: 'local-rules',
          latencyMs: Date.now() - t0,
          fallbackReason: `OpenRouter HTTP ${res.status}: ${errBody.slice(0, 120)}`,
        };
      }

      const json = (await res.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content ?? '';
      const intent = parseIntentJson(content);

      return {
        intent,
        provider: 'openrouter',
        model: json.model ?? this.config.openRouterModel,
        latencyMs: Date.now() - t0,
      };
    } catch (err) {
      return {
        intent: parseVoiceIntentLocally(cleaned),
        provider: 'local-stub',
        model: 'local-rules',
        latencyMs: Date.now() - t0,
        fallbackReason: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
