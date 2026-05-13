/**
 * Anthropic Messages API route handler.
 * POST /v1/messages — compatible with Claude Code CLI and other Anthropic clients.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import {
  AnthropicMessagesRequestSchema,
  AnthropicMessageCountTokensRequestSchema,
} from "../types/anthropic.js";
import type {
  AnthropicErrorBody,
  AnthropicErrorType,
  AnthropicMessageTokensCountResponse,
} from "../types/anthropic.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import { translateAnthropicToCodexRequest } from "../translation/anthropic-to-codex.js";
import { log } from "../utils/logger.js";
import {
  streamCodexToAnthropic,
  collectCodexToAnthropicResponse,
} from "../translation/codex-to-anthropic.js";
import { getConfig } from "../config.js";
import { parseModelName, buildDisplayModelName } from "../models/model-store.js";
import { countRequestInputTokens } from "../utils/tokenizer.js";
import { enqueueLogEntry } from "../logs/entry.js";
import { getRealClientIp } from "../utils/get-real-client-ip.js";
import { randomUUID } from "crypto";
import {
  handleProxyRequest,
  handleDirectRequest,
  type FormatAdapter,
  type ResponseMetadata,
  type UsageHint,
} from "./shared/proxy-handler.js";
import { extractAnthropicClientConversationId } from "./shared/anthropic-session-id.js";
import type { UpstreamRouter, UpstreamRouteMatch } from "../proxy/upstream-router.js";
import { summarizeRequestForLog } from "../logs/request-summary.js";

function makeError(
  type: AnthropicErrorType,
  message: string,
): AnthropicErrorBody {
  return { type: "error", error: { type, message } };
}

function shouldLogAnthropicCompatibilityDebug(): boolean {
  return process.env.DEBUG_ANTHROPIC_COMPAT === "1";
}

function summarizeUnknownTopLevelFields(body: unknown, knownKeys: string[]): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];

  const knownKeySet = new Set(knownKeys);
  return Object.keys(body as Record<string, unknown>)
    .filter((key) => !knownKeySet.has(key))
    .sort();
}

const KNOWN_MESSAGE_REQUEST_KEYS = [
  "model",
  "max_tokens",
  "messages",
  "system",
  "stream",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "metadata",
  "container",
  "context_management",
  "thinking",
  "tools",
  "tool_choice",
];

const KNOWN_COUNT_TOKENS_REQUEST_KEYS = [
  "model",
  "messages",
  "system",
  "cache_control",
  "container",
  "context_management",
  "mcp_servers",
  "output_config",
  "output_format",
  "speed",
  "thinking",
  "tools",
  "tool_choice",
];

function formatCountTokensResponse(body: Record<string, unknown>): AnthropicMessageTokensCountResponse {
  const inputTokens = typeof body.input_tokens === "number" ? body.input_tokens : 0;
  const contextManagement = body.context_management;

  return {
    input_tokens: inputTokens,
    context_management:
      contextManagement && typeof contextManagement === "object"
        ? ({
            original_input_tokens:
              typeof (contextManagement as Record<string, unknown>).original_input_tokens === "number"
                ? (contextManagement as Record<string, unknown>).original_input_tokens as number
                : inputTokens,
          })
        : contextManagement === null
          ? null
          : undefined,
  };
}

async function handleCountTokensDirectRequest(
  c: Context,
  routeMatch: Extract<UpstreamRouteMatch, { kind: "api-key" | "adapter" }>,
  body: Record<string, unknown>,
  upstreamHeaders?: Record<string, string>,
): Promise<Response> {
  if (!routeMatch.adapter.countTokens) {
    c.status(501);
    return c.json(makeError("api_error", "Selected upstream does not support /v1/messages/count_tokens"));
  }

  const abortController = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => abortController.abort(), { once: true });

  try {
    const raw = await routeMatch.adapter.countTokens(
      body,
      abortController.signal,
      upstreamHeaders,
      { beta: upstreamHeaders?.["anthropic-beta"]?.includes("token-counting-2024-11-01") },
    );
    return c.json(formatCountTokensResponse(raw));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Upstream token count request failed";
    const status = "status" in (err as Record<string, unknown>) && typeof (err as Record<string, unknown>).status === "number"
      ? (err as Record<string, unknown>).status as number
      : 502;
    c.status(status as StatusCode);
    return c.json(makeError(status === 429 ? "rate_limit_error" : "api_error", msg));
  }
}

function makeAnthropicFormat(wantThinking: boolean, precomputedInputTokens?: number): FormatAdapter {
  return {
    tag: "Messages",
    noAccountStatus: 529 as StatusCode,
    formatNoAccount: () =>
      makeError(
        "overloaded_error",
        "No available accounts. All accounts are expired or rate-limited.",
      ),
    format429: (msg) => makeError("rate_limit_error", msg),
    formatError: (_status, msg) => makeError("api_error", msg),
    streamTranslator: ({
      api,
      response,
      model,
      onUsage,
      onResponseId,
      usageHint,
      onResponseMetadata,
    }) => {
      const hint = usageHint ?? {};
      if (precomputedInputTokens != null) {
        (hint as Record<string, unknown>).precomputedInputTokens = precomputedInputTokens;
      }
      return streamCodexToAnthropic(api, response, model, onUsage, onResponseId, wantThinking, hint, onResponseMetadata);
    },
    collectTranslator: ({
      api,
      response,
      model,
      usageHint,
      onResponseMetadata,
    }) => {
      const hint = usageHint ?? {};
      if (precomputedInputTokens != null) {
        (hint as Record<string, unknown>).precomputedInputTokens = precomputedInputTokens;
      }
      return collectCodexToAnthropicResponse(api, response, model, wantThinking, hint, onResponseMetadata);
    },
  };
}

export function createMessagesRoutes(
  accountPool: AccountPool,
  cookieJar?: CookieJar,
  proxyPool?: ProxyPool,
  upstreamRouter?: UpstreamRouter,
): Hono {
  const app = new Hono();

  app.post("/v1/messages/count_tokens", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      return c.json(
        makeError("invalid_request_error", "Invalid JSON in request body"),
      );
    }

    const debugCompat = shouldLogAnthropicCompatibilityDebug();
    const unknownTopLevelFields = summarizeUnknownTopLevelFields(body, KNOWN_COUNT_TOKENS_REQUEST_KEYS);
    if (debugCompat && unknownTopLevelFields.length > 0) {
      log.debug("[AnthropicCompat] Unknown top-level request fields", {
        route: "/v1/messages/count_tokens",
        fields: unknownTopLevelFields,
      });
    }

    const parsed = AnthropicMessageCountTokensRequestSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json(
        makeError("invalid_request_error", `Invalid request: ${parsed.error.message}`),
      );
    }
    const req = parsed.data;

    const routeMatch = upstreamRouter?.resolveMatch(req.model);

    const anthropicVersion = c.req.header("anthropic-version");
    const anthropicBeta = c.req.header("anthropic-beta");
    const upstreamHeaders = {
      ...(anthropicVersion ? { "anthropic-version": anthropicVersion } : {}),
      ...(anthropicBeta ? { "anthropic-beta": anthropicBeta } : {}),
    };

    // Direct upstream routes bypass local auth — they carry their own API key
    if (routeMatch?.kind === "api-key" || routeMatch?.kind === "adapter") {
      return handleCountTokensDirectRequest(
        c,
        routeMatch,
        req as unknown as Record<string, unknown>,
        Object.keys(upstreamHeaders).length > 0 ? upstreamHeaders : undefined,
      );
    }

    // Codex-backed routes: count tokens locally using tiktoken
    const inputTokens = countRequestInputTokens({
      model: req.model,
      instructions: typeof req.system === "string"
        ? req.system
        : req.system?.map((b) => b.text).join("\n\n") ?? undefined,
      input: req.messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: typeof m.content === "string"
          ? m.content
          : m.content.map((b) => "text" in b ? (b as { text: string }).text : "").join("\n"),
      })),
      stream: true,
      store: false,
      tools: req.tools?.length ? req.tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description ?? "", parameters: t.input_schema ?? {} })) : [],
    });
    return c.json({ input_tokens: inputTokens });
  });

  app.post("/v1/messages", async (c) => {
    // Parse request
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      return c.json(
        makeError("invalid_request_error", "Invalid JSON in request body"),
      );
    }
    const debugCompat = shouldLogAnthropicCompatibilityDebug();
    const unknownTopLevelFields = summarizeUnknownTopLevelFields(body, KNOWN_MESSAGE_REQUEST_KEYS);
    if (debugCompat && unknownTopLevelFields.length > 0) {
      log.debug("[AnthropicCompat] Unknown top-level request fields", {
        route: "/v1/messages",
        fields: unknownTopLevelFields,
      });
    }

    const parsed = AnthropicMessagesRequestSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      return c.json(
        makeError("invalid_request_error", `Invalid request: ${parsed.error.message}`),
      );
    }
    const req = parsed.data;

    const routeMatch = upstreamRouter?.resolveMatch(req.model);
    const allowUnauthenticated = routeMatch?.kind === "api-key" || routeMatch?.kind === "adapter";

    // Auth check
    if (!allowUnauthenticated && !accountPool.isAuthenticated()) {
      c.status(401);
      return c.json(
        makeError("authentication_error", "Not authenticated. Please login first at /"),
      );
    }

    // Optional proxy API key check (x-api-key or Bearer token)
    const config = getConfig();
    if (config.server.proxy_api_key) {
      const xApiKey = c.req.header("x-api-key");
      const authHeader = c.req.header("Authorization");
      const bearerKey = authHeader?.replace("Bearer ", "");
      const providedKey = xApiKey ?? bearerKey;

      if (!providedKey || !accountPool.validateProxyApiKey(providedKey)) {
        c.status(401);
        return c.json(makeError("authentication_error", "Invalid API key"));
      }
    }

    const clientConversationId = extractAnthropicClientConversationId(
      req,
      c.req.header("x-claude-code-session-id"),
    );

    const codexRequest = translateAnthropicToCodexRequest(req, undefined, {
      injectHostedWebSearch: !allowUnauthenticated,
      mapClaudeCodeWebSearch: !allowUnauthenticated && clientConversationId !== null,
    });
    if (!allowUnauthenticated) {
      codexRequest.useWebSocket = true;
    }
    const wantThinking = req.thinking?.type === "enabled" || req.thinking?.type === "adaptive";
    const precomputedInputTokens = countRequestInputTokens(codexRequest);
    const proxyReq = {
      codexRequest,
      model: buildDisplayModelName(parseModelName(req.model)),
      isStreaming: req.stream,
      clientConversationId: clientConversationId ?? undefined,
    };
    const fmt = makeAnthropicFormat(wantThinking, precomputedInputTokens);

    const requestId = c.get("requestId") ?? randomUUID().slice(0, 8);
    enqueueLogEntry({
      requestId,
      direction: "ingress",
      method: c.req.method,
      path: c.req.path,
      model: req.model,
      stream: !!req.stream,
      request: summarizeRequestForLog("messages", req, {
        ip: getRealClientIp(c, getConfig()?.server?.trust_proxy ?? false),
        headers: Object.fromEntries(c.req.raw.headers.entries()),
      }),
    });

    if (routeMatch?.kind === "api-key" || routeMatch?.kind === "adapter") {
      const directReq = {
        ...proxyReq,
        model: req.model,
        codexRequest: { ...codexRequest, model: req.model },
      };
      return handleDirectRequest(c, routeMatch.adapter, directReq, fmt);
    }

    return handleProxyRequest(c, accountPool, cookieJar, proxyReq, fmt, proxyPool);
  });

  return app;
}
