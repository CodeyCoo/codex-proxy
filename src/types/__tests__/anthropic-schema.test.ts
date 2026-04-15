import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AnthropicMessagesRequestSchema, AnthropicMessageCountTokensRequestSchema } from "../anthropic.js";
import { translateAnthropicToCodexRequest } from "../../translation/anthropic-to-codex.js";
import { streamCodexToAnthropic, collectCodexToAnthropicResponse } from "../../translation/codex-to-anthropic.js";
import type { UpstreamAdapter } from "../../proxy/upstream-adapter.js";
import type { CodexSSEEvent } from "../../proxy/codex-types.js";
import { setConfigForTesting, resetConfigForTesting } from "../../config.js";

const debugMessages: Array<{ msg: string; extra?: Record<string, unknown> }> = [];
const originalDebugAnthropicCompat = process.env.DEBUG_ANTHROPIC_COMPAT;

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

const BASE_REQUEST = {
  model: "claude-opus-4-5",
  max_tokens: 1024,
  messages: [
    { role: "user", content: "Hello" },
  ],
};

function withDebugAnthropicCompat<T>(run: () => Promise<T>): Promise<T>;
function withDebugAnthropicCompat<T>(run: () => T): T;
function withDebugAnthropicCompat<T>(run: () => T | Promise<T>): T | Promise<T> {
  process.env.DEBUG_ANTHROPIC_COMPAT = "1";
  try {
    const result = run();
    if (result instanceof Promise) {
      return result.finally(() => {
        restoreDebugAnthropicCompat();
      });
    }
    restoreDebugAnthropicCompat();
    return result;
  } catch (error) {
    restoreDebugAnthropicCompat();
    throw error;
  }
}

function restoreDebugAnthropicCompat(): void {
  if (originalDebugAnthropicCompat === undefined) delete process.env.DEBUG_ANTHROPIC_COMPAT;
  else process.env.DEBUG_ANTHROPIC_COMPAT = originalDebugAnthropicCompat;
}

function makeTestConfig() {
  return {
    model: {
      default: "gpt-5.2-codex",
      default_reasoning_effort: null,
      default_service_tier: null,
      suppress_desktop_directives: false,
    },
  } as any;
}

function installTestConfig(): void {
  setConfigForTesting(makeTestConfig());
}

function restoreTestConfig(): void {
  resetConfigForTesting();
}

function clearDebugMessages(): void {
  debugMessages.length = 0;
}

function findDebugMessage(msg: string): Record<string, unknown> | undefined {
  return debugMessages.find((entry) => entry.msg === msg)?.extra;
}

function makeResponseUsage(
  inputTokens: number,
  outputTokens: number,
  cachedTokens?: number,
): Record<string, unknown> {
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cachedTokens == null ? {} : { input_tokens_details: { cached_tokens: cachedTokens } }),
  };
}

function makeResponseEvent(event: string, data: Record<string, unknown>): CodexSSEEvent {
  return { event, data };
}

function makeCreatedEvent(id: string, usage?: Record<string, unknown>): CodexSSEEvent {
  return makeResponseEvent("response.created", { response: { id, ...(usage ? { usage } : {}) } });
}

function makeCompletedEvent(
  id: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens?: number,
  stopReason?: string,
  stopSequence?: string | null,
): CodexSSEEvent {
  return makeResponseEvent("response.completed", {
    response: {
      id,
      usage: makeResponseUsage(inputTokens, outputTokens, cachedTokens),
      ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
      ...(stopSequence === undefined ? {} : { stop_sequence: stopSequence }),
    },
  });
}

function makeToolStartEvent(itemId: string, callId: string, name: string): CodexSSEEvent {
  return makeResponseEvent("response.output_item.added", {
    output_index: 0,
    item: { type: "function_call", id: itemId, call_id: callId, name },
  });
}

function makeToolDeltaEvent(itemId: string, delta: string): CodexSSEEvent {
  return makeResponseEvent("response.function_call_arguments.delta", {
    item_id: itemId,
    output_index: 0,
    delta,
  });
}

function makeToolDoneEvent(itemId: string, argumentsText: string, name: string): CodexSSEEvent {
  return makeResponseEvent("response.function_call_arguments.done", {
    item_id: itemId,
    arguments: argumentsText,
    name,
  });
}

function makeReasoningDeltaEvent(delta: string): CodexSSEEvent {
  return makeResponseEvent("response.reasoning_summary_text.delta", { delta });
}

function makeTextDeltaEvent(delta: string): CodexSSEEvent {
  return makeResponseEvent("response.output_text.delta", { delta });
}

function makeMockAdapter(events: CodexSSEEvent[]): UpstreamAdapter {
  return {
    tag: "mock",
    createResponse: async (_req, _signal) => new Response(),
    async *parseStream(_response) {
      for (const event of events) {
        yield event;
      }
    },
  };
}

async function collectStreamChunks(stream: AsyncGenerator<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

beforeEach(() => {
  clearDebugMessages();
  installTestConfig();
  restoreDebugAnthropicCompat();
});

afterEach(() => {
  clearDebugMessages();
  restoreTestConfig();
  restoreDebugAnthropicCompat();
});

describe("AnthropicMessagesRequestSchema", () => {
  it("accepts count_tokens requests with advanced beta-style fields", () => {
    const result = AnthropicMessageCountTokensRequestSchema.safeParse({
      model: "claude-opus-4-5",
      messages: [{ role: "user", content: "Hello" }],
      system: "You are a child agent.",
      cache_control: { type: "ephemeral" },
      context_management: {
        clear_function_results: false,
        edits: [{ type: "compact_20260112" }],
      },
      container: {
        type: "session",
        id: "container_123",
      },
      mcp_servers: [{ type: "url", url: "https://example.com/mcp" }],
      output_config: { compact: true },
      output_format: { type: "json" },
      speed: "fast",
      thinking: { type: "adaptive" },
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: { type: "object" },
        },
      ],
      tool_choice: { type: "auto" },
      future_field: { enabled: true },
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      context_management: {
        clear_function_results: false,
        edits: [{ type: "compact_20260112" }],
      },
      container: {
        type: "session",
        id: "container_123",
      },
      mcp_servers: [{ type: "url", url: "https://example.com/mcp" }],
      output_config: { compact: true },
      output_format: { type: "json" },
      speed: "fast",
      future_field: { enabled: true },
    });
  });

  it("requires messages in count_tokens requests", () => {
    const result = AnthropicMessageCountTokensRequestSchema.safeParse({
      model: "claude-opus-4-5",
    });

    expect(result.success).toBe(false);
  });

  it("accepts null container and context_management in count_tokens requests", () => {
    const result = AnthropicMessageCountTokensRequestSchema.safeParse({
      model: "claude-opus-4-5",
      messages: [{ role: "user", content: "Hello" }],
      container: null,
      context_management: null,
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      container: null,
      context_management: null,
    });
  });

  it("rejects invalid speed values in count_tokens requests", () => {
    const result = AnthropicMessageCountTokensRequestSchema.safeParse({
      model: "claude-opus-4-5",
      messages: [{ role: "user", content: "Hello" }],
      speed: "turbo",
    });

    expect(result.success).toBe(false);
  });

  it("accepts tool blocks inside count_tokens request messages", () => {
    const result = AnthropicMessageCountTokensRequestSchema.safeParse({
      model: "claude-opus-4-5",
      messages: [
        { role: "user", content: "run bash" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "file.txt" },
          ],
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("accepts unknown content block types inside count_tokens requests", () => {
    const result = AnthropicMessageCountTokensRequestSchema.safeParse({
      model: "claude-opus-4-5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Here is a file:" },
            { type: "container_upload", file_id: "file_123" },
          ],
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("preserves unknown top-level count_tokens request fields via passthrough", () => {
    const result = AnthropicMessageCountTokensRequestSchema.safeParse({
      model: "claude-opus-4-5",
      messages: [{ role: "user", content: "Hello" }],
      custom_future_flag: { enabled: true },
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      custom_future_flag: { enabled: true },
    });
  });

  it("accepts count_tokens requests without max_tokens", () => {
    const result = AnthropicMessageCountTokensRequestSchema.safeParse({
      model: "claude-opus-4-5",
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(result.success).toBe(true);
  });

  it("still requires max_tokens for messages.create requests", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      model: "claude-opus-4-5",
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(result.success).toBe(false);
  });

  it("accepts string content", () => {
    const result = AnthropicMessagesRequestSchema.safeParse(BASE_REQUEST);
    expect(result.success).toBe(true);
  });

  it("accepts known array content (text block)", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts tool_use + tool_result multi-turn", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
      messages: [
        { role: "user", content: "run bash" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "file.txt" },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts unknown content block types (forward-compatibility)", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Here is a file:" },
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: "abc" } },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts thinking blocks in assistant messages", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
      messages: [
        { role: "user", content: "think hard" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me reason...", signature: "sig" },
            { type: "text", text: "Answer" },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts context_management and container top-level fields", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
      context_management: {
        clear_function_results: false,
        edits: [{ type: "compact_20260112" }],
      },
      container: {
        type: "session",
        id: "container_123",
        skills: [{ type: "bash_20250124" }],
      },
    });

    expect(result.success).toBe(true);
    expect(result.data?.context_management).toEqual({
      clear_function_results: false,
      edits: [{ type: "compact_20260112" }],
    });
    expect(result.data?.container).toEqual({
      type: "session",
      id: "container_123",
      skills: [{ type: "bash_20250124" }],
    });
  });

  it("preserves unknown top-level request fields via passthrough", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
      mcp_servers: [{ type: "url", url: "https://example.com/mcp" }],
      custom_future_flag: { enabled: true },
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      mcp_servers: [{ type: "url", url: "https://example.com/mcp" }],
      custom_future_flag: { enabled: true },
    });
  });
});

describe("Anthropic compatibility debug logging", () => {
  it("logs unknown request block types during Anthropic translation", () => {
    withDebugAnthropicCompat(() => {
      translateAnthropicToCodexRequest({
        ...BASE_REQUEST,
        context_management: {
          edits: [{ type: "compact_20260112" }],
        },
        container: "container_123",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: "abc" } },
              { type: "tool_reference", tool_use_id: "tool_1", name: "Read" },
            ],
          },
        ],
      });
    });

    expect(findDebugMessage("[AnthropicCompat] Unknown content block types")).toEqual({
      blockTypes: ["document", "tool_reference"],
    });
  });

  it("tracks ignored advanced Anthropic features in debug logs without leaking metadata upstream", () => {
    let translated: Record<string, unknown> | undefined;

    withDebugAnthropicCompat(() => {
      translated = translateAnthropicToCodexRequest({
        ...BASE_REQUEST,
        context_management: {
          clear_function_results: false,
          edits: [{ type: "compact_20260112" }],
        },
        container: {
          id: "container_123",
          type: "session",
        },
        inference_geo: "us",
        mcp_servers: [{ type: "url", url: "https://example.com/mcp" }],
      } as any) as Record<string, unknown>;
    });

    expect(translated).toMatchObject({
      stream: true,
      store: false,
    });
    expect(typeof translated?.model).toBe("string");
    expect((translated?.model as string).length).toBeGreaterThan(0);
    expect(translated).not.toHaveProperty("context_management");
    expect(translated).not.toHaveProperty("container");
    expect(translated).not.toHaveProperty("inference_geo");
    expect(translated).not.toHaveProperty("__compatibility");
    expect(findDebugMessage("[AnthropicCompat] Ignored request features")).toEqual({
      topLevelFields: ["container", "context_management", "inference_geo", "mcp_servers"],
      contentBlockTypes: [],
    });
  });

  it("tracks unsupported content blocks in debug logs without leaking metadata upstream", () => {
    let translated: Record<string, unknown> | undefined;

    withDebugAnthropicCompat(() => {
      translated = translateAnthropicToCodexRequest({
        ...BASE_REQUEST,
        container: "container_123",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              { type: "tool_reference", tool_use_id: "tool_1", name: "Read" },
              { type: "container_upload", file_id: "file_123" },
              { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "hello" } },
            ],
          },
        ],
      } as any) as Record<string, unknown>;
    });

    expect(translated).not.toHaveProperty("__compatibility");
    expect(findDebugMessage("[AnthropicCompat] Ignored request features")).toEqual({
      topLevelFields: ["container"],
      contentBlockTypes: ["container_upload", "tool_reference"],
    });
  });

  it("downgrades unsupported user content blocks into Codex-visible text notes", () => {
    const translated = translateAnthropicToCodexRequest({
      ...BASE_REQUEST,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "thinking", thinking: "internal", signature: "sig_1" },
            { type: "redacted_thinking", data: "opaque" },
            { type: "tool_reference", tool_name: "Read" },
            { type: "container_upload", file_id: "file_123" },
            { type: "server_tool_use", name: "web_search" },
          ],
        },
      ],
    } as any);

    expect(translated.input).toEqual([
      {
        role: "user",
        content: [
          "hi",
          "[Anthropic compatibility note] thinking block with signature was downgraded to text.",
          "[Anthropic compatibility note] redacted_thinking block was downgraded to text.",
          "[Anthropic compatibility note] tool_reference block for tool \"Read\" was downgraded to text.",
          "[Anthropic compatibility note] container_upload block for file \"file_123\" was downgraded to text.",
          "[Anthropic compatibility note] server_tool_use block for tool \"web_search\" was downgraded to text.",
        ].join("\n"),
      },
    ]);
  });

  it("downgrades unsupported tool_result blocks into output text without redundant follow-up notes", () => {
    const translated = translateAnthropicToCodexRequest({
      ...BASE_REQUEST,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: [
                { type: "text", text: "done" },
                { type: "thinking", thinking: "internal", signature: "sig_1" },
                { type: "redacted_thinking", data: "opaque" },
                { type: "tool_reference", tool_name: "Read" },
                { type: "container_upload", file_id: "file_123" },
                { type: "server_tool_use", name: "web_search" },
              ],
            },
          ],
        },
      ],
    } as any);

    expect(translated.input).toEqual([
      {
        type: "function_call_output",
        call_id: "tool_1",
        output: [
          "done",
          "[Anthropic compatibility note] thinking block with signature was downgraded to text.",
          "[Anthropic compatibility note] redacted_thinking block was downgraded to text.",
          "[Anthropic compatibility note] tool_reference block for tool \"Read\" was downgraded to text.",
          "[Anthropic compatibility note] container_upload block for file \"file_123\" was downgraded to text.",
          "[Anthropic compatibility note] server_tool_use block for tool \"web_search\" was downgraded to text.",
        ].join("\n"),
      },
    ]);
  });

  it("treats thinking-style compatibility blocks as explicit downgrades instead of unknown block types", () => {
    withDebugAnthropicCompat(() => {
      const translated = translateAnthropicToCodexRequest({
        ...BASE_REQUEST,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "checking" },
              { type: "thinking", thinking: "internal", signature: "sig_1" },
              { type: "redacted_thinking", data: "opaque" },
              { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "x" } },
            ],
          },
        ],
      } as any);

      expect(translated.input).toEqual([
        {
          role: "assistant",
          content: [
            "checking",
            "[Anthropic compatibility note] thinking block with signature was downgraded to text.",
            "[Anthropic compatibility note] redacted_thinking block was downgraded to text.",
            "[Anthropic compatibility note] server_tool_use block for tool \"web_search\" was downgraded to text.",
          ].join("\n"),
        },
      ]);
    });

    expect(findDebugMessage("[AnthropicCompat] Unknown content block types")).toBeUndefined();
  });

  it("preserves assistant tool_use followed by user tool_result and follow-up text", () => {
    const translated = translateAnthropicToCodexRequest({
      ...BASE_REQUEST,
      messages: [
        { role: "user", content: "Open the file" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll inspect it." },
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
                { type: "text", text: "file contents" },
                { type: "tool_reference", tool_name: "Read" },
              ],
            },
            { type: "text", text: "Now summarize it." },
          ],
        },
      ],
    } as any);

    expect(translated.input).toEqual([
      { role: "user", content: "Open the file" },
      { role: "assistant", content: "I'll inspect it." },
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
          "file contents",
          "[Anthropic compatibility note] tool_reference block for tool \"Read\" was downgraded to text.",
        ].join("\n"),
      },
      {
        role: "user",
        content: "Now summarize it.",
      },
    ]);
  });

  it("preserves user text before tool_result when blocks appear in that order", () => {
    const translated = translateAnthropicToCodexRequest({
      ...BASE_REQUEST,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "First inspect this result." },
            {
              type: "tool_result",
              tool_use_id: "toolu_2",
              content: [{ type: "text", text: "ok" }],
            },
          ],
        },
      ],
    } as any);

    expect(translated.input).toEqual([
      { role: "user", content: "First inspect this result." },
      {
        type: "function_call_output",
        call_id: "toolu_2",
        output: "ok",
      },
    ]);
  });

  it("keeps image follow-up parts for tool_result while avoiding duplicate compatibility notes", () => {
    const translated = translateAnthropicToCodexRequest({
      ...BASE_REQUEST,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_2",
              content: [
                { type: "text", text: "see image" },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "abc" },
                },
                { type: "container_upload", file_id: "file_123" },
              ],
            },
          ],
        },
      ],
    } as any);

    expect(translated.input).toEqual([
      {
        type: "function_call_output",
        call_id: "tool_2",
        output: [
          "see image",
          "[Anthropic compatibility note] container_upload block for file \"file_123\" was downgraded to text.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "data:image/png;base64,abc",
          },
        ],
      },
    ]);
  });

  it("emits SSE stream summaries with tool_use sequence details", async () => {
    const adapter = makeMockAdapter([
      makeCreatedEvent("resp_1"),
      makeToolStartEvent("item_1", "call_1", "bash"),
      makeToolDeltaEvent("item_1", '{"cmd":"ls"}'),
      makeToolDoneEvent("item_1", '{"cmd":"ls"}', "bash"),
      makeCompletedEvent("resp_1", 12, 7, 3),
    ]);

    const chunks = await withDebugAnthropicCompat(async () => collectStreamChunks(
      streamCodexToAnthropic(adapter, new Response(), "claude-opus-4-5"),
    ));
    expect(chunks.join("")).toContain("input_json_delta");

    const extra = findDebugMessage("[AnthropicCompat] SSE stream summary");
    expect(extra).toEqual({
      model: "claude-opus-4-5",
      wantThinking: false,
      hasToolUse: true,
      sequence: [
        "content_block_delta:tool_usex1",
        "content_block_start:tool_usex1",
        "content_block_stop:tool_usex1",
        "message_deltax1",
        "message_startx1",
        "message_stopx1",
      ],
      usage: { input_tokens: 12, output_tokens: 7, cached_tokens: 3 },
    });
  });

  it("logs collected response summaries with content block types", async () => {
    const adapter = makeMockAdapter([
      makeCreatedEvent("resp_2"),
      makeReasoningDeltaEvent("Think"),
      makeTextDeltaEvent("Hello"),
      makeCompletedEvent("resp_2", 9, 4, 2),
    ]);

    const result = await withDebugAnthropicCompat(async () => collectCodexToAnthropicResponse(
      adapter,
      new Response(),
      "claude-opus-4-5",
      true,
    ));

    expect(result.response.content.map((block) => block.type)).toEqual(["thinking", "text"]);
    expect(findDebugMessage("[AnthropicCompat] Collected response summary")).toEqual({
      model: "claude-opus-4-5",
      wantThinking: true,
      hasToolUse: false,
      contentTypes: ["thinking", "text"],
      usage: { input_tokens: 9, output_tokens: 4, cached_tokens: 2 },
    });
  });

  it("preserves stop metadata from completed events in streamed Anthropic output", async () => {
    const adapter = makeMockAdapter([
      makeCreatedEvent("resp_pause"),
      makeTextDeltaEvent("partial answer"),
      makeCompletedEvent("resp_pause", 4, 6, 1, "pause_turn", "resume_later"),
    ]);

    const chunks = await collectStreamChunks(
      streamCodexToAnthropic(adapter, new Response(), "claude-opus-4-5"),
    );
    const joined = chunks.join("");

    expect(joined).toContain("event: message_delta");
    expect(joined).toContain('"stop_reason":"pause_turn"');
    expect(joined).toContain('"stop_sequence":"resume_later"');
    expect(joined).toContain('"cache_read_input_tokens":1');
  });

  it("keeps message_start usage at zero until message_delta arrives", async () => {
    const adapter = makeMockAdapter([
      makeCreatedEvent("resp_usage", makeResponseUsage(12, 0, 5)),
      makeTextDeltaEvent("hello"),
      makeCompletedEvent("resp_usage", 12, 7, 5),
    ]);

    const chunks = await collectStreamChunks(
      streamCodexToAnthropic(adapter, new Response(), "claude-opus-4-5"),
    );
    const joined = chunks.join("");

    expect(joined).toContain('event: message_start\ndata: {"type":"message_start","message":{"id":');
    expect(joined).toContain('"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0}');
    expect(joined).toContain('event: message_delta');
    expect(joined).toContain('"usage":{"input_tokens":12,"cache_creation_input_tokens":0,"cache_read_input_tokens":5,"output_tokens":7}');
  });

  it("ignores keepalive SSE events in Anthropic translation", async () => {
    const adapter = makeMockAdapter([
      makeCreatedEvent("resp_keepalive"),
      makeResponseEvent("keepalive", {}),
      makeTextDeltaEvent("hello"),
      makeCompletedEvent("resp_keepalive", 3, 2),
    ]);

    const chunks = await withDebugAnthropicCompat(async () => collectStreamChunks(
      streamCodexToAnthropic(adapter, new Response(), "claude-opus-4-5"),
    ));
    const joined = chunks.join("");

    expect(joined).toContain('"text":"hello"');
    expect(findDebugMessage("[AnthropicCompat] SSE stream summary")).toEqual({
      model: "claude-opus-4-5",
      wantThinking: false,
      hasToolUse: false,
      sequence: [
        "content_block_delta:textx1",
        "content_block_start:textx1",
        "content_block_stop:textx1",
        "message_deltax1",
        "message_startx1",
        "message_stopx1",
      ],
      usage: { input_tokens: 3, output_tokens: 2 },
    });
  });

  it("preserves stop metadata from completed events in collected Anthropic responses", async () => {
    const adapter = makeMockAdapter([
      makeCreatedEvent("resp_refusal"),
      makeTextDeltaEvent("cannot comply"),
      makeCompletedEvent("resp_refusal", 2, 3, undefined, "refusal", null),
    ]);

    const result = await collectCodexToAnthropicResponse(
      adapter,
      new Response(),
      "claude-opus-4-5",
      false,
    );

    expect(result.response.stop_reason).toBe("refusal");
    expect(result.response.stop_sequence).toBeNull();
  });
});
