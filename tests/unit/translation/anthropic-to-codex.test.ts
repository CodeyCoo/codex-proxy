/**
 * Tests for translateAnthropicToCodexRequest — Anthropic Messages → Codex format.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@src/config.js", () => ({
  getConfig: vi.fn(() => ({
    model: {
      default: "gpt-5.3-codex",
      default_reasoning_effort: null,
      default_service_tier: null,
      suppress_desktop_directives: false,
    },
  })),
}));

vi.mock("@src/paths.js", () => ({
  getConfigDir: vi.fn(() => "/tmp/test-config"),
}));

vi.mock("@src/translation/shared-utils.js", () => ({
  buildInstructions: vi.fn((text: string) => text),
  budgetToEffort: vi.fn((budget: number | undefined) => {
    if (!budget || budget <= 0) return undefined;
    if (budget < 2000) return "low";
    if (budget < 8000) return "medium";
    if (budget < 20000) return "high";
    return "xhigh";
  }),
}));

vi.mock("@src/translation/tool-format.js", () => ({
  anthropicToolsToCodex: vi.fn((tools: unknown[]) => tools),
  anthropicToolChoiceToCodex: vi.fn(() => undefined),
}));

vi.mock("@src/models/model-store.js", () => ({
  parseModelName: vi.fn((input: string) => {
    if (input === "codex") return { modelId: "gpt-5.4", serviceTier: null, reasoningEffort: null };
    if (input === "gpt-5.4-fast") return { modelId: "gpt-5.4", serviceTier: "fast", reasoningEffort: null };
    if (input === "gpt-5.4-high") return { modelId: "gpt-5.4", serviceTier: null, reasoningEffort: "high" };
    return { modelId: input, serviceTier: null, reasoningEffort: null };
  }),
  getModelInfo: vi.fn((id: string) => {
    if (id === "gpt-5.4") return { defaultReasoningEffort: "medium" };
    return undefined;
  }),
}));

import { translateAnthropicToCodexRequest } from "@src/translation/anthropic-to-codex.js";
import { anthropicToolsToCodex, anthropicToolChoiceToCodex } from "@src/translation/tool-format.js";
import type { AnthropicMessagesRequest } from "@src/types/anthropic.js";

function makeRequest(overrides: Partial<AnthropicMessagesRequest> = {}): AnthropicMessagesRequest {
  return {
    model: "gpt-5.4",
    max_tokens: 4096,
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  } as AnthropicMessagesRequest;
}

describe("translateAnthropicToCodexRequest", () => {
  it("does not forward max_tokens to Codex", () => {
    const result = translateAnthropicToCodexRequest(
      makeRequest({ max_tokens: 8192 }),
    );
    expect(result).not.toHaveProperty("max_output_tokens");
  });

  // ── System instructions ──────────────────────────────────────────────

  describe("system instructions", () => {
    it("uses string system as instructions", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ system: "Be concise." }),
      );
      expect(result.instructions).toBe("Be concise.");
    });

    it("joins text block array system into instructions", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          system: [
            { type: "text" as const, text: "First paragraph." },
            { type: "text" as const, text: "Second paragraph." },
          ],
        }),
      );
      expect(result.instructions).toBe("First paragraph.\n\nSecond paragraph.");
    });

    it("strips Claude billing header noise from system blocks", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          system: [
            {
              type: "text" as const,
              text: "x-anthropic-billing-header: cc_version=2.1.100.db0; cch=abcd1;",
            },
            { type: "text" as const, text: "Keep answers short." },
          ],
        }),
      );
      expect(result.instructions).toBe("Keep answers short.");
    });

    it("falls back to default instructions when no system provided", () => {
      const result = translateAnthropicToCodexRequest(makeRequest());
      expect(result.instructions).toBe("You are a helpful assistant.");
    });
  });

  // ── Messages ─────────────────────────────────────────────────────────

  describe("messages", () => {
    it("converts user text string to input item", () => {
      const result = translateAnthropicToCodexRequest(makeRequest());
      expect(result.input).toHaveLength(1);
      expect(result.input[0]).toEqual({ role: "user", content: "Hello" });
    });

    it("converts user with array content (text blocks) to text string", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                { type: "text" as const, text: "Line one" },
                { type: "text" as const, text: "Line two" },
              ],
            },
          ],
        }),
      );
      expect(result.input).toHaveLength(1);
      expect(result.input[0]).toEqual({ role: "user", content: "Line one\nLine two" });
    });

    it("converts image block to input_image content part", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                { type: "text" as const, text: "Describe this" },
                {
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: "image/png",
                    data: "iVBOR...",
                  },
                },
              ],
            },
          ],
        }),
      );
      expect(result.input).toHaveLength(1);
      const item = result.input[0];
      expect(Array.isArray(item.content)).toBe(true);
      const parts = item.content as Array<Record<string, unknown>>;
      expect(parts).toHaveLength(2);
      expect(parts[0]).toEqual({ type: "input_text", text: "Describe this" });
      expect(parts[1]).toEqual({
        type: "input_image",
        image_url: "data:image/png;base64,iVBOR...",
      });
    });

    it("converts URL image block to input_image content part", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                { type: "text" as const, text: "Describe this" },
                {
                  type: "image" as const,
                  source: {
                    type: "url" as const,
                    url: "https://example.com/image.png",
                  },
                },
              ],
            },
          ],
        }),
      );
      const item = result.input[0];
      const parts = item.content as Array<Record<string, unknown>>;
      expect(parts[1]).toEqual({
        type: "input_image",
        image_url: "https://example.com/image.png",
      });
    });

    it("converts text document block to structured input_text", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                { type: "text" as const, text: "Use this document" },
                {
                  type: "document",
                  title: "Release notes",
                  context: "Attached by user",
                  source: {
                    type: "text",
                    media_type: "text/plain",
                    data: "Fixed prompt caching for Codex.",
                  },
                },
              ] as unknown as AnthropicMessagesRequest["messages"][number]["content"],
            },
          ],
        }),
      );

      expect(result.input).toHaveLength(1);
      const content = (result.input[0] as { content: string }).content;
      expect(content).toContain("Use this document");
      expect(content).toContain("Document:");
      expect(content).toContain("Title: Release notes");
      expect(content).toContain("Context: Attached by user");
      expect(content).toContain("Media type: text/plain");
      expect(content).toContain("Fixed prompt caching for Codex.");
    });

    it("converts PDF document metadata without forwarding base64 payload", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "document",
                  title: "Spec PDF",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: "JVBERi0xLjQ=",
                  },
                },
              ] as unknown as AnthropicMessagesRequest["messages"][number]["content"],
            },
          ],
        }),
      );

      const content = (result.input[0] as { content: string }).content;
      expect(content).toContain("Title: Spec PDF");
      expect(content).toContain("Source type: base64");
      expect(content).toContain("Media type: application/pdf");
      expect(content).toContain("Base64 data omitted (12 chars)");
      expect(content).not.toContain("JVBERi0xLjQ=");
    });

    it("converts content-source documents and records omitted embedded images", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "document",
                  title: "Mixed document",
                  source: {
                    type: "content",
                    content: [
                      { type: "text", text: "First paragraph" },
                      {
                        type: "image",
                        source: { type: "url", url: "https://example.com/chart.png" },
                      },
                      { type: "text", text: "Second paragraph" },
                    ],
                  },
                },
              ] as unknown as AnthropicMessagesRequest["messages"][number]["content"],
            },
          ],
        }),
      );

      const content = (result.input[0] as { content: string }).content;
      expect(content).toContain("Title: Mixed document");
      expect(content).toContain("First paragraph");
      expect(content).toContain("[Image content omitted]");
      expect(content).toContain("Second paragraph");
    });

    it("converts search_result block to structured input_text", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "search_result",
                  title: "Codex release",
                  source: "https://example.com/codex-release",
                  content: [
                    { type: "text", text: "Codex added a new response event." },
                    { type: "text", text: "The event carries a completed item." },
                  ],
                },
              ] as unknown as AnthropicMessagesRequest["messages"][number]["content"],
            },
          ],
        }),
      );

      const content = (result.input[0] as { content: string }).content;
      expect(content).toContain("Search result:");
      expect(content).toContain("Title: Codex release");
      expect(content).toContain("Source: https://example.com/codex-release");
      expect(content).toContain("Codex added a new response event.");
      expect(content).toContain("The event carries a completed item.");
    });

    it("keeps document and search_result as input_text parts when mixed with images", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image" as const,
                  source: { type: "url" as const, url: "https://example.com/a.png" },
                },
                {
                  type: "search_result",
                  title: "Search hit",
                  source: "https://example.com/hit",
                  content: [{ type: "text", text: "Hit body" }],
                },
              ] as unknown as AnthropicMessagesRequest["messages"][number]["content"],
            },
          ],
        }),
      );

      const parts = (result.input[0] as { content: Array<Record<string, unknown>> }).content;
      expect(parts).toEqual([
        { type: "input_image", image_url: "https://example.com/a.png" },
        {
          type: "input_text",
          text: "Search result:\nTitle: Search hit\nSource: https://example.com/hit\nContent:\nHit body",
        },
      ]);
    });

    it("converts tool_use block to function_call input item", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use" as const,
                  id: "toolu_01",
                  name: "search",
                  input: { query: "test" },
                },
              ],
            },
          ],
        }),
      );
      const fcItem = result.input.find(
        (i) => "type" in i && i.type === "function_call",
      );
      expect(fcItem).toBeDefined();
      expect(fcItem).toMatchObject({
        type: "function_call",
        call_id: "toolu_01",
        name: "search",
        arguments: '{"query":"test"}',
      });
    });

    it("converts server_tool_use block to function_call input item", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "server_tool_use",
                  id: "srv_01",
                  name: "web_search",
                  input: { query: "codex responses" },
                },
              ] as unknown as AnthropicMessagesRequest["messages"][number]["content"],
            },
          ],
        }),
      );
      const fcItem = result.input.find(
        (i) => "type" in i && i.type === "function_call",
      );
      expect(fcItem).toMatchObject({
        type: "function_call",
        call_id: "srv_01",
        name: "web_search",
        arguments: '{"query":"codex responses"}',
      });
    });

    it("converts web_search_tool_result to readable function_call_output", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "server_tool_use",
                  id: "srv_web",
                  name: "web_search",
                  input: { query: "codex" },
                },
                {
                  type: "web_search_tool_result",
                  tool_use_id: "srv_web",
                  content: [
                    {
                      type: "web_search_result",
                      title: "Codex docs",
                      url: "https://example.com/codex",
                      page_age: "1 day",
                      encrypted_content: "opaque",
                    },
                  ],
                },
              ] as unknown as AnthropicMessagesRequest["messages"][number]["content"],
            },
          ],
        }),
      );
      const outputItem = result.input.find(
        (i) => "type" in i && i.type === "function_call_output",
      );
      const output = (outputItem as Record<string, unknown>).output as string;
      expect(output).toContain("Web search results:");
      expect(output).toContain("Codex docs");
      expect(output).toContain("https://example.com/codex");
      expect(output).not.toContain("opaque");
    });

    it("converts bash_code_execution_tool_result to readable function_call_output", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "bash_code_execution_tool_result",
                  tool_use_id: "srv_bash",
                  content: {
                    type: "bash_code_execution_result",
                    return_code: 0,
                    stdout: "42\n",
                    stderr: "",
                    content: [
                      { type: "bash_code_execution_output", file_id: "file_123" },
                    ],
                  },
                },
              ] as unknown as AnthropicMessagesRequest["messages"][number]["content"],
            },
          ],
        }),
      );
      const outputItem = result.input.find(
        (i) => "type" in i && i.type === "function_call_output",
      );
      const output = (outputItem as Record<string, unknown>).output as string;
      expect(output).toContain("return_code=0");
      expect(output).toContain("stdout:\n42");
      expect(output).toContain("file_id=file_123");
    });

    it("converts web_fetch and text editor server tool results", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "web_fetch_tool_result",
                  tool_use_id: "srv_fetch",
                  content: {
                    type: "web_fetch_result",
                    url: "https://example.com/page",
                    retrieved_at: "2026-05-13T00:00:00Z",
                    content: {
                      type: "document",
                      title: "Fetched page",
                      source: {
                        type: "text",
                        media_type: "text/plain",
                        data: "Fetched body",
                      },
                    },
                  },
                },
                {
                  type: "text_editor_code_execution_tool_result",
                  tool_use_id: "srv_edit",
                  content: {
                    type: "text_editor_code_execution_view_result",
                    file_type: "text",
                    start_line: 1,
                    num_lines: 1,
                    total_lines: 1,
                    content: "hello",
                  },
                },
              ] as unknown as AnthropicMessagesRequest["messages"][number]["content"],
            },
          ],
        }),
      );
      const outputs = result.input
        .filter((i) => "type" in i && i.type === "function_call_output")
        .map((i) => (i as Record<string, unknown>).output as string);
      expect(outputs[0]).toContain("Web fetch result:");
      expect(outputs[0]).toContain("Fetched body");
      expect(outputs[1]).toContain("Text editor view result:");
      expect(outputs[1]).toContain("hello");
    });

    it("converts tool_search_tool_result errors to readable output", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_search_tool_result",
                  tool_use_id: "srv_tool_search",
                  content: {
                    type: "tool_search_tool_result_error",
                    error_code: "unavailable",
                    error_message: "index not ready",
                  },
                },
              ] as unknown as AnthropicMessagesRequest["messages"][number]["content"],
            },
          ],
        }),
      );
      const outputItem = result.input.find(
        (i) => "type" in i && i.type === "function_call_output",
      );
      expect((outputItem as Record<string, unknown>).output).toBe(
        "Tool search error: unavailable - index not ready",
      );
    });

    it("converts tool_result block to function_call_output input item", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: "toolu_01",
                  content: "result data",
                },
              ],
            },
          ],
        }),
      );
      const outputItem = result.input.find(
        (i) => "type" in i && i.type === "function_call_output",
      );
      expect(outputItem).toBeDefined();
      expect(outputItem).toMatchObject({
        type: "function_call_output",
        call_id: "toolu_01",
        output: "result data",
      });
    });

    it("prepends 'Error: ' to tool_result output when is_error is true", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: "toolu_02",
                  content: "something went wrong",
                  is_error: true,
                },
              ],
            },
          ],
        }),
      );
      const outputItem = result.input.find(
        (i) => "type" in i && i.type === "function_call_output",
      );
      expect(outputItem).toBeDefined();
      expect((outputItem as Record<string, unknown>).output).toBe(
        "Error: something went wrong",
      );
    });
  });

  // ── Thinking → reasoning effort ──────────────────────────────────────

  describe("thinking to reasoning effort", () => {
    it("maps enabled thinking with budget_tokens to effort", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          thinking: { type: "enabled", budget_tokens: 5000 },
        }),
      );
      // budgetToEffort(5000) → "medium"
      expect(result.reasoning?.effort).toBe("medium");
      expect(result.include).toEqual(["reasoning.encrypted_content"]);
    });

    it("maps enabled thinking with small budget to low effort", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          thinking: { type: "enabled", budget_tokens: 500 },
        }),
      );
      expect(result.reasoning?.effort).toBe("low");
    });

    it("maps disabled thinking to undefined effort", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          thinking: { type: "disabled" },
        }),
      );
      // disabled → undefined, no config default → no effort set
      expect(result.reasoning?.effort).toBeUndefined();
    });

    it("maps adaptive thinking with budget_tokens to effort", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          thinking: { type: "adaptive", budget_tokens: 15000 },
        }),
      );
      // budgetToEffort(15000) → "high"
      expect(result.reasoning?.effort).toBe("high");
    });

    it("maps adaptive thinking without budget_tokens to undefined", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          thinking: { type: "adaptive" },
        }),
      );
      // adaptive without budget → undefined, no config default → no effort set
      expect(result.reasoning?.effort).toBeUndefined();
    });
  });

  // ── Model parsing ────────────────────────────────────────────────────

  describe("model parsing", () => {
    it("resolves 'codex' alias via parseModelName", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ model: "codex" }),
      );
      expect(result.model).toBe("gpt-5.4");
    });

    it("extracts service_tier from -fast suffix", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ model: "gpt-5.4-fast" }),
      );
      expect(result.service_tier).toBe("fast");
    });

    it("extracts reasoning effort from -high suffix", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ model: "gpt-5.4-high" }),
      );
      expect(result.reasoning?.effort).toBe("high");
    });
  });

  // ── Tools ────────────────────────────────────────────────────────────

  describe("tools", () => {
    it("delegates tools array to anthropicToolsToCodex", () => {
      const tools = [
        { name: "search", description: "Search the web", input_schema: {} },
      ];
      translateAnthropicToCodexRequest(makeRequest({ tools }));

      expect(anthropicToolsToCodex).toHaveBeenCalledWith(tools);
    });

    it("delegates tool_choice to anthropicToolChoiceToCodex", () => {
      const toolChoice = { type: "auto" as const };
      translateAnthropicToCodexRequest(makeRequest({ tool_choice: toolChoice }));

      expect(anthropicToolChoiceToCodex).toHaveBeenCalledWith(toolChoice, undefined);
    });

    it("passes tools context when converting tool_choice", () => {
      const tools = [
        { name: "web_search", description: "Custom search", input_schema: {} },
      ];
      const toolChoice = { type: "tool" as const, name: "web_search" };
      translateAnthropicToCodexRequest(makeRequest({ tools, tool_choice: toolChoice }));

      expect(anthropicToolChoiceToCodex).toHaveBeenCalledWith(toolChoice, tools);
    });

    it("passes Claude Code WebSearch mapping option when requested", () => {
      const tools = [
        { name: "WebSearch", description: "Search the web", input_schema: {} },
      ];
      const toolChoice = { type: "tool" as const, name: "WebSearch" };
      translateAnthropicToCodexRequest(
        makeRequest({ tools, tool_choice: toolChoice }),
        undefined,
        { mapClaudeCodeWebSearch: true },
      );

      expect(anthropicToolsToCodex).toHaveBeenCalledWith(
        tools,
        { mapClaudeCodeWebSearch: true },
      );
      expect(anthropicToolChoiceToCodex).toHaveBeenCalledWith(
        toolChoice,
        tools,
        { mapClaudeCodeWebSearch: true },
      );
    });

    it("does not inject hosted web_search by default", () => {
      const result = translateAnthropicToCodexRequest(makeRequest());

      expect(result.tools).toEqual([]);
    });

    it("injects hosted web_search when explicitly requested", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest(),
        undefined,
        { injectHostedWebSearch: true },
      );

      expect(result.tools).toEqual([{ type: "web_search" }]);
    });

    it("does not duplicate hosted web_search when injected and already present", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ tools: [{ type: "web_search" as const, name: "web_search" }] }),
        undefined,
        { injectHostedWebSearch: true },
      );

      expect(result.tools).toEqual([{ type: "web_search", name: "web_search" }]);
    });
  });

  // ── Fixed fields ─────────────────────────────────────────────────────

  describe("fixed fields", () => {
    it("always sets stream to true", () => {
      const result = translateAnthropicToCodexRequest(makeRequest());
      expect(result.stream).toBe(true);
    });

    it("always sets store to false", () => {
      const result = translateAnthropicToCodexRequest(makeRequest());
      expect(result.store).toBe(false);
    });

    it("sets Codex request defaults expected by current Responses API", () => {
      const result = translateAnthropicToCodexRequest(makeRequest());
      expect(result.tool_choice).toBe("auto");
      expect(result.parallel_tool_calls).toBe(true);
    });

    it("does not set reasoning when no effort is configured or requested", () => {
      const result = translateAnthropicToCodexRequest(makeRequest());
      expect(result.reasoning).toBeUndefined();
    });

    it("maps output_config.format json_schema to Codex text.format", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          output_config: {
            format: {
              type: "json_schema",
              schema: {
                type: "object",
                properties: { answer: { type: "string" } },
              },
            },
          },
        }),
      );
      expect(result.text).toEqual({
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
          },
        },
      });
    });
  });

  // ── Empty messages ───────────────────────────────────────────────────

  describe("empty messages", () => {
    it("ensures at least one input item when messages produce no items", () => {
      // All thinking blocks get filtered out, producing no items
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                { type: "thinking" as const, thinking: "internal thought" },
              ],
            },
          ],
        }),
      );
      expect(result.input.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── tool_result with array content ─────────────────────────────────

  describe("tool_result with array content", () => {
    it("converts tool_result with array text content to joined string", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: "toolu_arr",
                  content: [
                    { type: "text" as const, text: "Line 1" },
                    { type: "text" as const, text: "Line 2" },
                  ],
                },
              ],
            },
          ],
        }),
      );
      const outputItem = result.input.find(
        (i) => "type" in i && i.type === "function_call_output",
      );
      expect(outputItem).toBeDefined();
      expect((outputItem as Record<string, unknown>).output).toBe("Line 1\nLine 2");
    });

    it("converts document, search_result, and tool_reference blocks in tool_result output", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: "toolu_rich",
                  content: [
                    {
                      type: "document",
                      title: "Fetched PDF",
                      source: { type: "url", url: "https://example.com/file.pdf" },
                    },
                    {
                      type: "search_result",
                      title: "Search hit",
                      source: "https://example.com/hit",
                      content: [{ type: "text", text: "Search body" }],
                    },
                    { type: "tool_reference", tool_name: "WebSearch" },
                  ],
                },
              ] as unknown as AnthropicMessagesRequest["messages"][number]["content"],
            },
          ],
        }),
      );

      const outputItem = result.input.find(
        (i) => "type" in i && i.type === "function_call_output",
      );
      const output = (outputItem as Record<string, unknown>).output as string;
      expect(output).toContain("Document:");
      expect(output).toContain("Title: Fetched PDF");
      expect(output).toContain("URL: https://example.com/file.pdf");
      expect(output).toContain("Search result:");
      expect(output).toContain("Search body");
      expect(output).toContain("Tool reference: WebSearch");
    });
  });

  // ── tool_result with image content (screenshot scenario) ───────────

  describe("tool_result with image content", () => {
    it("keeps images in function_call_output content array", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: "toolu_img",
                  content: [
                    { type: "text" as const, text: "Screenshot captured" },
                    {
                      type: "image" as const,
                      source: {
                        type: "base64" as const,
                        media_type: "image/png",
                        data: "iVBORw0KGgo=",
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );

      const outputItem = result.input.find(
        (i) => "type" in i && i.type === "function_call_output",
      );
      expect(outputItem).toBeDefined();
      const output = (outputItem as Record<string, unknown>).output as Array<Record<string, unknown>>;
      expect(output).toEqual([
        { type: "input_text", text: "Screenshot captured" },
        { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
      ]);
    });

    it("handles tool_result with image-only content (no text)", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: "toolu_img2",
                  content: [
                    {
                      type: "image" as const,
                      source: {
                        type: "base64" as const,
                        media_type: "image/jpeg",
                        data: "/9j/4AAQ",
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );

      const outputItem = result.input.find(
        (i) => "type" in i && i.type === "function_call_output",
      );
      expect(outputItem).toBeDefined();
      const output = (outputItem as Record<string, unknown>).output as Array<Record<string, unknown>>;
      expect(output).toEqual([
        { type: "input_image", image_url: "data:image/jpeg;base64,/9j/4AAQ" },
      ]);
    });

    it("handles tool_result with multiple images", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result" as const,
                  tool_use_id: "toolu_multi",
                  content: [
                    { type: "text" as const, text: "Two screenshots" },
                    {
                      type: "image" as const,
                      source: { type: "base64" as const, media_type: "image/png", data: "img1" },
                    },
                    {
                      type: "image" as const,
                      source: { type: "base64" as const, media_type: "image/png", data: "img2" },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );

      const outputItem = result.input.find(
        (i) => "type" in i && i.type === "function_call_output",
      );
      const parts = (outputItem as { output: Array<Record<string, unknown>> }).output;
      expect(parts).toHaveLength(3);
      expect(parts[0]).toEqual({ type: "input_text", text: "Two screenshots" });
      expect(parts[1].image_url).toBe("data:image/png;base64,img1");
      expect(parts[2].image_url).toBe("data:image/png;base64,img2");
    });
  });

  // ── Mixed assistant content ────────────────────────────────────────

  describe("mixed assistant content", () => {
    it("converts assistant text block to assistant input item", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text" as const, text: "Here is the result" },
              ],
            },
          ],
        }),
      );
      const assistantItem = result.input.find(
        (i) => "role" in i && i.role === "assistant",
      );
      expect(assistantItem).toBeDefined();
      expect((assistantItem as Record<string, unknown>).content).toBe("Here is the result");
    });

    it("handles assistant with both text and tool_use blocks", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text" as const, text: "Let me search" },
                {
                  type: "tool_use" as const,
                  id: "toolu_mixed",
                  name: "search",
                  input: { query: "test" },
                },
              ],
            },
          ],
        }),
      );
      const assistantItem = result.input.find(
        (i) => "role" in i && i.role === "assistant",
      );
      const fcItem = result.input.find(
        (i) => "type" in i && i.type === "function_call",
      );
      expect(assistantItem).toBeDefined();
      expect(fcItem).toBeDefined();
    });

    it("converts multiple tool_use blocks in single assistant message", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use" as const,
                  id: "toolu_1",
                  name: "search",
                  input: { query: "a" },
                },
                {
                  type: "tool_use" as const,
                  id: "toolu_2",
                  name: "fetch",
                  input: { url: "https://example.com" },
                },
              ],
            },
          ],
        }),
      );
      const fcItems = result.input.filter(
        (i) => "type" in i && i.type === "function_call",
      );
      expect(fcItems).toHaveLength(2);
    });
  });

  // ── Thinking block filtering ──────────────────────────────────────

  describe("thinking block handling", () => {
    it("filters out thinking blocks from assistant text content", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                { type: "thinking" as const, thinking: "internal thought" },
                { type: "text" as const, text: "visible answer" },
              ],
            },
          ],
        }),
      );
      const assistantItem = result.input.find(
        (i) => "role" in i && i.role === "assistant",
      );
      expect(assistantItem).toBeDefined();
      expect((assistantItem as Record<string, unknown>).content).toBe("visible answer");
    });

    it("filters out redacted_thinking blocks from assistant content", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                { type: "redacted_thinking" as const, data: "encrypted" },
                { type: "text" as const, text: "answer" },
              ],
            },
          ],
        }),
      );
      const assistantItem = result.input.find(
        (i) => "role" in i && i.role === "assistant",
      );
      expect(assistantItem).toBeDefined();
      expect((assistantItem as Record<string, unknown>).content).toBe("answer");
    });

    it("adds safe notes for unsupported non-thinking blocks", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "container_upload",
                  file_id: "file_123",
                  hidden: "not forwarded",
                },
                { type: "text" as const, text: "visible answer" },
              ] as unknown as AnthropicMessagesRequest["messages"][number]["content"],
            },
          ],
        }),
      );
      const assistantItem = result.input.find(
        (i) => "role" in i && i.role === "assistant",
      );
      expect((assistantItem as Record<string, unknown>).content).toContain("container_upload");
      expect((assistantItem as Record<string, unknown>).content).not.toContain("file_123");
      expect((assistantItem as Record<string, unknown>).content).not.toContain("hidden");
    });
  });

  // ── System instruction edge cases ─────────────────────────────────

  describe("system instruction edge cases", () => {
    it("uses default instructions for empty system string", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({ system: "" }),
      );
      expect(result.instructions).toBe("You are a helpful assistant.");
    });

    it("handles single text block system", () => {
      const result = translateAnthropicToCodexRequest(
        makeRequest({
          system: [{ type: "text" as const, text: "Only one block." }],
        }),
      );
      expect(result.instructions).toBe("Only one block.");
    });
  });
});
