import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";

const mockConfig = {
  server: { proxy_api_key: null as string | null },
  model: {
    default: "gpt-5.2-codex",
    default_reasoning_effort: null,
    default_service_tier: null,
    suppress_desktop_directives: false,
  },
  auth: {
    jwt_token: undefined as string | undefined,
    rotation_strategy: "least_used" as const,
    rate_limit_backoff_seconds: 60,
  },
};

vi.mock("../../config.js", () => ({
  getConfig: vi.fn(() => mockConfig),
}));

vi.mock("../../paths.js", () => ({
  getDataDir: vi.fn(() => "/tmp/test-upstream-auth"),
  getConfigDir: vi.fn(() => "/tmp/test-upstream-auth-config"),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(() => "models: []"),
    writeFileSync: vi.fn(),
    writeFile: vi.fn(
      (_p: string, _d: string, _e: string, cb: (err: Error | null) => void) => cb(null),
    ),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

vi.mock("js-yaml", () => ({
  default: {
    load: vi.fn(() => ({ models: [], aliases: {} })),
    dump: vi.fn(() => ""),
  },
}));

vi.mock("../../auth/jwt-utils.js", () => ({
  decodeJwtPayload: vi.fn(() => ({
    exp: Math.floor(Date.now() / 1000) + 3600,
  })),
  extractChatGptAccountId: vi.fn((token: string) => `acct-${token}`),
  extractUserProfile: vi.fn(() => null),
  isTokenExpired: vi.fn(() => false),
}));

vi.mock("../../models/model-fetcher.js", () => ({
  triggerImmediateRefresh: vi.fn(),
  startModelRefresh: vi.fn(),
  stopModelRefresh: vi.fn(),
}));

vi.mock("../../utils/retry.js", () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

const debugMessages: Array<{ msg: string; extra?: Record<string, unknown> }> = [];

vi.mock("../../utils/logger.js", () => ({
  log: {
    debug: (msg: string, extra?: Record<string, unknown>) => {
      debugMessages.push({ msg, extra });
    },
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
}));

const mockHandleDirectRequest = vi.fn(async (c) => c.json({ ok: true }));
vi.mock("../shared/proxy-handler.js", () => ({
  handleProxyRequest: vi.fn(async (c) => c.json({ proxied: true })),
  handleDirectRequest: (...args: unknown[]) => mockHandleDirectRequest(...args),
}));

import { AccountPool } from "../../auth/account-pool.js";
import { loadStaticModels } from "../../models/model-store.js";
import { createChatRoutes } from "../chat.js";
import { createMessagesRoutes } from "../messages.js";
import { createGeminiRoutes } from "../gemini.js";
import { createResponsesRoutes } from "../responses.js";

const originalDebugAnthropicCompat = process.env.DEBUG_ANTHROPIC_COMPAT;

describe("upstream direct routing without Codex auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    debugMessages.length = 0;
    mockConfig.server.proxy_api_key = null;
    mockHandleDirectRequest.mockImplementation(async (c) => c.json({ ok: true }));
    if (originalDebugAnthropicCompat === undefined) delete process.env.DEBUG_ANTHROPIC_COMPAT;
    else process.env.DEBUG_ANTHROPIC_COMPAT = originalDebugAnthropicCompat;
    loadStaticModels();
  });

  it("allows OpenAI chat direct upstream routing without local accounts", async () => {
    const pool = new AccountPool();
    const app = createChatRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({ kind: "adapter" })),
      resolve: vi.fn(() => ({ tag: "custom-upstream" })),
    } as never);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "my-custom-model",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockHandleDirectRequest).toHaveBeenCalledTimes(1);
    pool.destroy();
  });

  it("allows Anthropic messages direct upstream routing without local accounts", async () => {
    const pool = new AccountPool();
    const app = createMessagesRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({ kind: "adapter", adapter: { tag: "custom-upstream" } })),
    } as never);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2024-10-22",
        "anthropic-beta": "files-api-2025-04-14,context-management-2025-06-27",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockHandleDirectRequest).toHaveBeenCalledTimes(1);
    expect(mockHandleDirectRequest.mock.calls[0][2]).toMatchObject({
      upstreamHeaders: {
        "anthropic-version": "2024-10-22",
        "anthropic-beta": "files-api-2025-04-14,context-management-2025-06-27",
      },
    });
    pool.destroy();
  });

  it("forwards Anthropic count_tokens direct upstream routing without local accounts", async () => {
    const pool = new AccountPool();
    const countTokens = vi.fn(async () => ({
      input_tokens: 321,
      context_management: { original_input_tokens: 654 },
    }));
    const app = createMessagesRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({
        kind: "adapter",
        adapter: { tag: "custom-upstream", countTokens },
      })),
    } as never);

    const res = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2024-10-22",
        "anthropic-beta": "token-counting-2024-11-01,context-management-2025-06-27",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        system: "You are a focused child agent.",
        messages: [{ role: "user", content: "hello" }],
        context_management: {
          clear_function_results: false,
          edits: [{ type: "compact_20260112" }],
        },
        output_format: { type: "json" },
        mcp_servers: [{ type: "url", url: "https://example.com/mcp" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockHandleDirectRequest).toHaveBeenCalledTimes(0);
    expect(countTokens).toHaveBeenCalledTimes(1);
    expect(countTokens).toHaveBeenCalledWith(
      {
        model: "claude-opus-4-6",
        system: "You are a focused child agent.",
        messages: [{ role: "user", content: "hello" }],
        context_management: {
          clear_function_results: false,
          edits: [{ type: "compact_20260112" }],
        },
        output_format: { type: "json" },
        mcp_servers: [{ type: "url", url: "https://example.com/mcp" }],
      },
      expect.any(AbortSignal),
      {
        "anthropic-version": "2024-10-22",
        "anthropic-beta": "token-counting-2024-11-01,context-management-2025-06-27",
      },
      { beta: true },
    );
    await expect(res.json()).resolves.toEqual({
      input_tokens: 321,
      context_management: { original_input_tokens: 654 },
    });
    pool.destroy();
  });

  it("returns 501 when Anthropic count_tokens direct upstream is unavailable", async () => {
    const pool = new AccountPool();
    const app = createMessagesRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({ kind: "adapter", adapter: { tag: "custom-upstream" } })),
    } as never);

    const res = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(501);
    await expect(res.json()).resolves.toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: "Selected upstream does not support /v1/messages/count_tokens",
      },
    });
    pool.destroy();
  });

  it("logs unknown Anthropic count_tokens top-level request fields in debug mode", async () => {
    process.env.DEBUG_ANTHROPIC_COMPAT = "1";
    const pool = new AccountPool();
    const countTokens = vi.fn(async () => ({ input_tokens: 12 }));
    const app = createMessagesRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({
        kind: "adapter",
        adapter: { tag: "custom-upstream", countTokens },
      })),
    } as never);

    try {
      const res = await app.request("/v1/messages/count_tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-opus-4-6",
          messages: [{ role: "user", content: "hello" }],
          future_field: { enabled: true },
        }),
      });

      expect(res.status).toBe(200);
      expect(debugMessages).toContainEqual({
        msg: "[AnthropicCompat] Unknown top-level request fields",
        extra: {
          route: "/v1/messages/count_tokens",
          fields: ["future_field"],
        },
      });
    } finally {
      pool.destroy();
      if (originalDebugAnthropicCompat === undefined) delete process.env.DEBUG_ANTHROPIC_COMPAT;
      else process.env.DEBUG_ANTHROPIC_COMPAT = originalDebugAnthropicCompat;
    }
  });

  it("returns 501 for count_tokens on codex-backed Anthropic routes", async () => {
    const pool = new AccountPool();
    const app = createMessagesRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({ kind: "codex", adapter: { tag: "codex" } })),
    } as never);

    const res = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(501);
    await expect(res.json()).resolves.toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: "/v1/messages/count_tokens is only supported for direct Anthropic-compatible upstreams",
      },
    });
    pool.destroy();
  });

  it("returns 404 for unknown models on Anthropic count_tokens route", async () => {
    const pool = new AccountPool();
    const app = createMessagesRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({ kind: "not-found" })),
    } as never);

    const res = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "unknown-model-xyz",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      type: "error",
      error: {
        type: "not_found_error",
        message: "Model 'unknown-model-xyz' not found",
      },
    });
    pool.destroy();
  });

  it("returns 501 for count_tokens on codex-backed routes even without login", async () => {
    const pool = new AccountPool();
    const app = createMessagesRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({ kind: "codex", adapter: { tag: "codex" } })),
    } as never);

    const res = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(501);
    await expect(res.json()).resolves.toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: "/v1/messages/count_tokens is only supported for direct Anthropic-compatible upstreams",
      },
    });
    pool.destroy();
  });

  it("returns 400 for invalid Anthropic count_tokens payloads", async () => {
    const pool = new AccountPool();
    const app = createMessagesRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({ kind: "adapter", adapter: { tag: "custom-upstream" } })),
    } as never);

    const res = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
      }),
    });

    expect(res.status).toBe(400);
    expect(mockHandleDirectRequest).toHaveBeenCalledTimes(0);
    pool.destroy();
  });

  it("bypasses proxy api key validation for configured direct Anthropic count_tokens routing", async () => {
    mockConfig.server.proxy_api_key = "proxy-secret";
    const pool = new AccountPool();
    const countTokens = vi.fn(async () => ({ input_tokens: 9 }));
    const app = createMessagesRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({
        kind: "api-key",
        adapter: { tag: "custom-upstream", countTokens },
        entry: { model: "claude-opus-4-6" },
      })),
    } as never);

    const res = await app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-key",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(countTokens).toHaveBeenCalledTimes(1);
    pool.destroy();
  });

  it("preserves a child-agent style Claude loop through /v1/messages direct routing", async () => {
    const pool = new AccountPool();
    let capturedDirectReq: Record<string, unknown> | null = null;

    mockHandleDirectRequest.mockImplementationOnce(async (_c, _upstream, directReq, fmt) => {
      capturedDirectReq = directReq as Record<string, unknown>;
      const events = [
        {
          event: "response.created",
          data: { response: { id: "resp_child_1" } },
        },
        {
          event: "response.reasoning_summary_text.delta",
          data: { delta: "Need to inspect the file first." },
        },
        {
          event: "response.output_item.added",
          data: {
            output_index: 0,
            item: {
              type: "function_call",
              id: "item_1",
              call_id: "toolu_child_2",
              name: "Read",
            },
          },
        },
        {
          event: "response.function_call_arguments.delta",
          data: {
            item_id: "item_1",
            output_index: 0,
            delta: '{"file_path":"/tmp/demo.txt"}',
          },
        },
        {
          event: "response.function_call_arguments.done",
          data: {
            item_id: "item_1",
            arguments: '{"file_path":"/tmp/demo.txt"}',
            name: "Read",
          },
        },
        {
          event: "response.completed",
          data: {
            response: {
              id: "resp_child_1",
              usage: {
                input_tokens: 15,
                output_tokens: 6,
                input_tokens_details: { cached_tokens: 2 },
              },
              stop_reason: "tool_use",
              stop_sequence: "END_TOOL",
            },
          },
        },
      ];

      const adapter = {
        tag: "mock-upstream",
        createResponse: async () => new Response(),
        async *parseStream() {
          for (const event of events) {
            yield event;
          }
        },
      };

      const chunks: string[] = [];
      for await (const chunk of fmt.streamTranslator(
        adapter as never,
        new Response(),
        (directReq as Record<string, unknown>).model as string,
        () => {},
        () => {},
        undefined,
      )) {
        chunks.push(chunk);
      }

      return new Response(chunks.join(""), {
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const app = createMessagesRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({ kind: "adapter", adapter: { tag: "custom-upstream" } })),
    } as never);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2024-10-22",
        "anthropic-beta": "files-api-2025-04-14,context-management-2025-06-27",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        system: "You are a focused child agent.",
        max_tokens: 128,
        stream: true,
        thinking: { type: "enabled", budget_tokens: 4000 },
        tool_choice: { type: "any" },
        tools: [
          {
            name: "Read",
            description: "Read a file from disk",
            input_schema: {
              type: "object",
              properties: {
                file_path: { type: "string" },
              },
              required: ["file_path"],
            },
          },
        ],
        context_management: {
          clear_function_results: false,
          edits: [{ type: "compact_20260112" }],
        },
        container: {
          type: "session",
          id: "container_123",
        },
        mcp_servers: [{ type: "url", url: "https://example.com/mcp" }],
        messages: [
          { role: "user", content: "Open /tmp/demo.txt and summarize it." },
          {
            role: "assistant",
            content: [
              { type: "text", text: "I'll read the file." },
              { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/tmp/demo.txt" } },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: [
                  { type: "text", text: "demo file contents" },
                  { type: "tool_reference", tool_name: "Read" },
                ],
              },
              { type: "text", text: "Now summarize it in one sentence." },
            ],
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(mockHandleDirectRequest).toHaveBeenCalledTimes(1);
    expect(capturedDirectReq).not.toBeNull();
    expect(capturedDirectReq).toMatchObject({
      model: "claude-opus-4-6",
      isStreaming: true,
      upstreamHeaders: {
        "anthropic-version": "2024-10-22",
        "anthropic-beta": "files-api-2025-04-14,context-management-2025-06-27",
      },
    });

    const codexRequest = capturedDirectReq?.codexRequest as Record<string, unknown>;
    expect(codexRequest).toMatchObject({
      model: "claude-opus-4-6",
      instructions: "You are a focused child agent.",
      stream: true,
      store: false,
      tool_choice: "required",
      reasoning: { effort: "medium", summary: "auto" },
      tools: [
        {
          type: "function",
          name: "Read",
          description: "Read a file from disk",
          parameters: {
            type: "object",
            properties: {
              file_path: { type: "string" },
            },
            required: ["file_path"],
          },
        },
      ],
    });
    expect(codexRequest).not.toHaveProperty("context_management");
    expect(codexRequest).not.toHaveProperty("container");
    expect(codexRequest.input).toEqual([
      { role: "user", content: "Open /tmp/demo.txt and summarize it." },
      { role: "assistant", content: "I'll read the file." },
      {
        type: "function_call",
        call_id: "toolu_1",
        name: "Read",
        arguments: JSON.stringify({ file_path: "/tmp/demo.txt" }),
      },
      {
        type: "function_call_output",
        call_id: "toolu_1",
        output: [
          "demo file contents",
          "[Anthropic compatibility note] tool_reference block for tool \"Read\" was downgraded to text.",
        ].join("\n"),
      },
      { role: "user", content: "Now summarize it in one sentence." },
    ]);

    const sse = await res.text();
    expect(sse).toContain('"type":"message_start"');
    expect(sse).toContain('"type":"content_block_start","index":0,"content_block":{"type":"thinking"');
    expect(sse).toContain('"thinking":"Need to inspect the file first."');
    expect(sse).toContain('"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_child_2","name":"Read","input":{}}');
    expect(sse).toContain('"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"/tmp/demo.txt\\"}"');
    expect(sse).toContain('"stop_reason":"tool_use"');
    expect(sse).toContain('"stop_sequence":"END_TOOL"');
    expect(sse).toContain('"cache_read_input_tokens":2');
    pool.destroy();
  });

  it("logs unknown Anthropic top-level request fields in debug mode", async () => {
    process.env.DEBUG_ANTHROPIC_COMPAT = "1";
    const pool = new AccountPool();
    const app = createMessagesRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({ kind: "adapter", adapter: { tag: "custom-upstream" } })),
    } as never);

    try {
      const res = await app.request("/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-opus-4-6",
          max_tokens: 16,
          messages: [{ role: "user", content: "hello" }],
          context_management: { mode: "auto" },
          container: { type: "session" },
        }),
      });

      expect(res.status).toBe(200);
      expect(debugMessages).toContainEqual({
        msg: "[AnthropicCompat] Ignored request features",
        extra: {
          topLevelFields: ["container", "context_management"],
          contentBlockTypes: [],
        },
      });
    } finally {
      pool.destroy();
      if (originalDebugAnthropicCompat === undefined) delete process.env.DEBUG_ANTHROPIC_COMPAT;
      else process.env.DEBUG_ANTHROPIC_COMPAT = originalDebugAnthropicCompat;
    }
  });

  it("allows Gemini direct upstream routing without local accounts", async () => {
    const pool = new AccountPool();
    const app = createGeminiRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({ kind: "adapter", adapter: { tag: "custom-upstream" } })),
    } as never);

    const res = await app.request("/v1beta/models/gemini-2.5-pro:generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockHandleDirectRequest).toHaveBeenCalledTimes(1);
    pool.destroy();
  });

  it("allows Responses direct upstream routing without local accounts", async () => {
    const pool = new AccountPool();
    const app = createResponsesRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({ kind: "adapter", adapter: { tag: "custom-upstream" } })),
    } as never);

    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "my-custom-model",
        input: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockHandleDirectRequest).toHaveBeenCalledTimes(1);
    pool.destroy();
  });

  it("bypasses proxy api key validation for configured direct upstream models", async () => {
    mockConfig.server.proxy_api_key = "proxy-secret";
    const pool = new AccountPool();
    const app = createChatRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({ kind: "api-key", adapter: { tag: "custom-upstream" }, entry: { model: "deepseek-chat" } })),
      hasApiKeyModel: vi.fn(() => true),
      resolve: vi.fn(() => ({ tag: "custom-upstream" })),
    } as never);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-key",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(mockHandleDirectRequest).toHaveBeenCalledTimes(1);
    pool.destroy();
  });

  it("returns 404 for unknown models before auth", async () => {
    mockConfig.server.proxy_api_key = "proxy-secret";
    const pool = new AccountPool();
    const app = createChatRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({ kind: "not-found" })),
    } as never);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-key",
      },
      body: JSON.stringify({
        model: "unknown-model-xyz",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(404);
    expect(mockHandleDirectRequest).toHaveBeenCalledTimes(0);
    pool.destroy();
  });

  it("still requires login for codex models without api-key fallback", async () => {
    const pool = new AccountPool();
    const app = createChatRoutes(pool, undefined, undefined, {
      resolveMatch: vi.fn(() => ({ kind: "codex", adapter: { tag: "codex" } })),
      hasApiKeyModel: vi.fn(() => false),
    } as never);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5.2-codex",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(401);
    expect(mockHandleDirectRequest).toHaveBeenCalledTimes(0);
    pool.destroy();
  });
});
