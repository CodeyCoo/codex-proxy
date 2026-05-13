import { describe, it, expect } from "vitest";
import { AnthropicMessagesRequestSchema } from "@src/types/anthropic.js";

const BASE_REQUEST = {
  model: "claude-opus-4-5",
  max_tokens: 1024,
  messages: [
    { role: "user", content: "Hello" },
  ],
};

describe("AnthropicMessagesRequestSchema", () => {
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
    // Simulate a future type not yet modeled by this proxy.
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
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

  it("accepts document and search_result input blocks", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              title: "Release notes",
              context: "User attached changelog",
              citations: { enabled: true },
              source: {
                type: "text",
                media_type: "text/plain",
                data: "Added new CLI support.",
              },
            },
            {
              type: "document",
              title: "Spec",
              source: {
                type: "content",
                content: [
                  { type: "text", text: "Spec section" },
                  { type: "image", source: { type: "url", url: "https://example.com/diagram.png" } },
                ],
              },
            },
            {
              type: "search_result",
              title: "Anthropic docs",
              source: "https://docs.anthropic.com/",
              content: [
                { type: "text", text: "Documents and search results are content blocks." },
              ],
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts document, search_result, and tool_reference inside tool_result content", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [
                {
                  type: "document",
                  title: "Tool document",
                  source: { type: "url", url: "https://example.com/file.pdf" },
                },
                {
                  type: "search_result",
                  title: "Search hit",
                  source: "https://example.com/hit",
                  content: [{ type: "text", text: "Hit body" }],
                },
                { type: "tool_reference", tool_name: "WebSearch" },
              ],
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts latest top-level request fields and server tool definitions", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
      cache_control: { type: "ephemeral" },
      inference_geo: "us",
      output_config: {
        format: {
          type: "json_schema",
          schema: { type: "object", properties: { answer: { type: "string" } } },
        },
      },
      service_tier: "auto",
      tools: [
        { type: "code_execution_20260120", name: "code_execution" },
        { type: "memory_20250818", name: "memory" },
      ],
      tool_choice: { type: "none" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts URL image blocks", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this" },
            { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts server-side tool use and result blocks", () => {
    const result = AnthropicMessagesRequestSchema.safeParse({
      ...BASE_REQUEST,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "srv_1",
              name: "web_search",
              input: { query: "codex" },
            },
            {
              type: "web_search_tool_result",
              tool_use_id: "srv_1",
              content: [
                {
                  type: "web_search_result",
                  title: "Codex",
                  url: "https://example.com/codex",
                  encrypted_content: "opaque",
                },
              ],
            },
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
});
