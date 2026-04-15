/**
 * UpstreamAdapter — abstract interface for all upstream API backends.
 *
 * Both the existing CodexApi and new API-key-based adapters (OpenAI,
 * Anthropic, Gemini) implement this interface so the proxy handler can
 * treat them uniformly.
 */

import type { CodexResponsesRequest, CodexSSEEvent } from "./codex-types.js";

export interface UpstreamCountTokensOptions {
  beta?: boolean;
}

export interface UpstreamAdapter {
  /** Short identifier used in logs (e.g. "codex", "openai", "anthropic"). */
  readonly tag: string;
  /**
   * Send a Codex-format request to the upstream API.
   * Returns a raw HTTP Response whose body is an SSE stream.
   * Throws on HTTP error (non-2xx).
   */
  createResponse(
    req: CodexResponsesRequest,
    signal: AbortSignal,
    extraHeaders?: Record<string, string>,
  ): Promise<Response>;
  /**
   * Optional native token-count endpoint for Anthropic-compatible /v1/messages/count_tokens.
   */
  countTokens?(
    body: Record<string, unknown>,
    signal: AbortSignal,
    extraHeaders?: Record<string, string>,
    options?: UpstreamCountTokensOptions,
  ): Promise<Record<string, unknown>>;
  /**
   * Parse the upstream SSE response into a stream of Codex-normalized events.
   * Each adapter normalizes its native event format to CodexSSEEvent.
   */
  parseStream(response: Response): AsyncGenerator<CodexSSEEvent>;
}
