// The LLM commander's connection to a language model: the Messages API over HTTPS with
// plain fetch. Configured only from the environment (and CLI flags for the model and
// URL): WERFORCES_AI_API_KEY, WERFORCES_AI_MODEL (required, no default), and optionally
// WERFORCES_AI_BASE_URL and WERFORCES_AI_API_VERSION. The key is never logged or saved.

import type { LlmProvider } from '../sim/commander/manager.js';
import type { LlmRequest, LlmResponse, LlmTransport } from '../sim/commander/llm.js';

export interface LlmConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  /** The anthropic-version header. */
  version: string;
  /** Milliseconds before a call is given up. */
  timeoutMs: number;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_VERSION = '2026-10-21';

/** The configuration from the environment and CLI flags, or why there is none. */
export function llmConfig(env: Record<string, string | undefined>, flags: { model?: string; baseUrl?: string } = {}): { config?: LlmConfig; unavailable?: string } {
  const apiKey = env.WERFORCES_AI_API_KEY?.trim();
  const model = (flags.model ?? env.WERFORCES_AI_MODEL)?.trim();
  if (!apiKey && !model) return { unavailable: 'no language model is configured on this server (set WERFORCES_AI_API_KEY and WERFORCES_AI_MODEL)' };
  if (!apiKey) return { unavailable: 'WERFORCES_AI_API_KEY is not set' };
  if (!model) return { unavailable: 'WERFORCES_AI_MODEL is not set (the model id to use)' };
  const baseUrl = (flags.baseUrl ?? env.WERFORCES_AI_BASE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) return { unavailable: `WERFORCES_AI_BASE_URL must be an http(s) URL (got "${baseUrl}")` };
  const timeout = Number(env.WERFORCES_AI_TIMEOUT ?? 90);
  return { config: { apiKey, model, baseUrl, version: env.WERFORCES_AI_API_VERSION?.trim() || DEFAULT_VERSION, timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout * 1000 : 90000 } };
}

/** Messages API calls with fetch. Errors carry the status and the API's message, never the key. */
export function httpTransport(cfg: LlmConfig, fetchImpl: typeof fetch = fetch): LlmTransport {
  return {
    async send(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
      const timeout = AbortSignal.timeout(cfg.timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(`${cfg.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': cfg.version },
          body: JSON.stringify({ model: cfg.model, ...req }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        if (timeout.aborted) throw new Error(`the model did not answer within ${Math.round(cfg.timeoutMs / 1000)} s`);
        throw new Error(`could not reach the model API: ${err instanceof Error ? err.message : String(err)}`);
      }
      const text = await res.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      if (!res.ok) {
        const msg = (body as { error?: { message?: string } } | undefined)?.error?.message ?? res.statusText;
        throw new Error(`model API ${res.status}: ${String(msg).replaceAll(cfg.apiKey, '***').slice(0, 300)}`);
      }
      if (!body || typeof body !== 'object' || !Array.isArray((body as LlmResponse).content)) throw new Error('model API: unexpected reply');
      return body as LlmResponse;
    },
  };
}

/** What the engine's commanders use: a transport, or why there is none. */
export function llmProvider(env: Record<string, string | undefined>, flags: { model?: string; baseUrl?: string } = {}): LlmProvider {
  const { config, unavailable } = llmConfig(env, flags);
  return config ? { transport: httpTransport(config) } : { unavailable };
}
