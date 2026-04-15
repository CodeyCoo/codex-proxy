import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnthropicUpstream } from "../anthropic-upstream.js";
import type { CodexResponsesRequest } from "../codex-types.js";
import type { CodexSSEEvent } from "../codex-types.js";

function makeRequest(overrides?: Partial<CodexResponsesRequest>): CodexResponsesRequest {
  return {
    model: "claude-opus-4-6",
    instructions: "test",
    input: [{ role: "user", content: "hello" }],
    stream: true,
    tools: [],
    ...overrides,
  };
}

async function collectEvents(stream: AsyncGenerator<CodexSSEEvent>): Promise<CodexSSEEvent[]> {
  const events: CodexSSEEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("AnthropicUpstream headers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards anthropic-version and anthropic-beta headers when provided", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response("event: message_start\ndata: {}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const upstream = new AnthropicUpstream("test-key");
    await upstream.createResponse(makeRequest(), new AbortController().signal, {
      "anthropic-version": "2024-10-22",
      "anthropic-beta": "files-api-2025-04-14,context-management-2025-06-27",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["anthropic-version"]).toBe("2024-10-22");
    expect(headers["anthropic-beta"]).toBe("files-api-2025-04-14,context-management-2025-06-27");
  });

  it("omits anthropic-beta header when not provided", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response("event: message_start\ndata: {}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const upstream = new AnthropicUpstream("test-key");
    await upstream.createResponse(makeRequest(), new AbortController().signal);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-beta"]).toBeUndefined();
  });

  it("forwards count_tokens requests with anthropic headers", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(JSON.stringify({ input_tokens: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const upstream = new AnthropicUpstream("test-key");
    const result = await upstream.countTokens!(
      {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "hello" }],
      },
      new AbortController().signal,
      {
        "anthropic-version": "2024-10-22",
        "anthropic-beta": "token-counting-2024-11-01,context-management-2025-06-27",
      },
      { beta: true },
    );

    expect(result).toEqual({ input_tokens: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/messages/count_tokens?beta=true");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["anthropic-version"]).toBe("2024-10-22");
    expect(headers["anthropic-beta"]).toBe("token-counting-2024-11-01,context-management-2025-06-27");
  });

  it("uses the non-beta count_tokens endpoint by default", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(JSON.stringify({ input_tokens: 7 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const upstream = new AnthropicUpstream("test-key");
    await upstream.countTokens!(
      {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "hello" }],
      },
      new AbortController().signal,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/messages/count_tokens");
  });

  it("throws on count_tokens HTTP errors", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const upstream = new AnthropicUpstream("test-key");
    await expect(upstream.countTokens!(
      {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "hello" }],
      },
      new AbortController().signal,
    )).rejects.toThrow("Codex API error (400)");
  });

  it("normalizes missing original_input_tokens by preserving input_tokens only", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(JSON.stringify({ input_tokens: 42, context_management: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const upstream = new AnthropicUpstream("test-key");
    const result = await upstream.countTokens!(
      {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "hello" }],
      },
      new AbortController().signal,
      undefined,
      { beta: true },
    );

    expect(result).toEqual({ input_tokens: 42, context_management: {} });
  });

  it("normalizes cached tokens and stop metadata from message_delta", async () => {
    const upstream = new AnthropicUpstream("test-key");
    const sse = [
      {
        event: "message_start",
        data: { message: { id: "msg_123", usage: { input_tokens: 11 } } },
      },
      {
        event: "content_block_start",
        data: { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Read" } },
      },
      {
        event: "content_block_delta",
        data: { index: 0, delta: { type: "input_json_delta", partial_json: '{"file":"a' } },
      },
      {
        event: "content_block_delta",
        data: { index: 0, delta: { type: "input_json_delta", partial_json: '.ts"}' } },
      },
      {
        event: "content_block_stop",
        data: { index: 0 },
      },
      {
        event: "message_delta",
        data: {
          delta: { stop_reason: "tool_use", stop_sequence: "END" },
          usage: { output_tokens: 7, cache_read_input_tokens: 5 },
        },
      },
      {
        event: "message_stop",
        data: {},
      },
    ];
    const response = new Response(
      sse.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}`).join("\n\n") + "\n\n",
      {
        headers: { "content-type": "text/event-stream" },
      },
    );

    const events = await collectEvents(upstream.parseStream(response));

    expect(events).toEqual([
      {
        event: "response.created",
        data: { response: { id: "msg_123" } },
      },
      {
        event: "response.output_item.added",
        data: {
          output_index: 0,
          item: {
            type: "function_call",
            id: "item_0",
            call_id: "toolu_1",
            name: "Read",
          },
        },
      },
      {
        event: "response.function_call_arguments.delta",
        data: {
          call_id: "toolu_1",
          delta: '{"file":"a',
          output_index: 0,
        },
      },
      {
        event: "response.function_call_arguments.delta",
        data: {
          call_id: "toolu_1",
          delta: '.ts"}',
          output_index: 0,
        },
      },
      {
        event: "response.function_call_arguments.done",
        data: {
          call_id: "toolu_1",
          name: "Read",
          arguments: '{"file":"a.ts"}',
          output_index: 0,
        },
      },
      {
        event: "response.completed",
        data: {
          response: {
            id: "msg_123",
            status: "completed",
            usage: {
              input_tokens: 11,
              output_tokens: 7,
              input_tokens_details: { cached_tokens: 5 },
              output_tokens_details: {},
            },
            stop_reason: "tool_use",
            stop_sequence: "END",
          },
        },
      },
    ]);
  });
});
