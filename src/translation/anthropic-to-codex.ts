/**
 * Translate Anthropic Messages API request → Codex Responses API request.
 */

import type { AnthropicMessagesRequest } from "../types/anthropic.js";
import type {
  CodexResponsesRequest,
  CodexInputItem,
  CodexContentPart,
} from "../proxy/codex-api.js";
import { parseModelName, getModelInfo } from "../models/model-store.js";
import { getConfig } from "../config.js";
import { buildInstructions, budgetToEffort } from "./shared-utils.js";
import type { ModelConfigOverride } from "./shared-utils.js";
import {
  anthropicToolsToCodex,
  anthropicToolChoiceToCodex,
  type AnthropicToolConversionOptions,
} from "./tool-format.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasHostedWebSearchTool(tools: unknown[]): boolean {
  return tools.some((tool) => isRecord(tool) && tool.type === "web_search");
}

const TOOL_CALL_BLOCK_TYPES = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);
const TOOL_RESULT_BLOCK_TYPES = new Set([
  "tool_result",
  "web_search_tool_result",
  "web_fetch_tool_result",
  "bash_code_execution_tool_result",
  "text_editor_code_execution_tool_result",
  "tool_search_tool_result",
  "code_execution_tool_result",
]);

function getStringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : null;
}

function getRawStringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" ? field : null;
}

function getNumberField(value: Record<string, unknown>, key: string): number | null {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

function isThinkingBlock(block: Record<string, unknown>): boolean {
  return block.type === "thinking" || block.type === "redacted_thinking";
}

function isToolCallBlock(block: Record<string, unknown>): boolean {
  return typeof block.type === "string" && TOOL_CALL_BLOCK_TYPES.has(block.type);
}

function isToolResultBlock(block: Record<string, unknown>): boolean {
  return typeof block.type === "string" && TOOL_RESULT_BLOCK_TYPES.has(block.type);
}

function summarizeUnsupportedBlock(block: Record<string, unknown>): string | null {
  if (isThinkingBlock(block)) return null;

  const type = getStringField(block, "type") ?? "unknown";
  const parts = [`type=${type}`];
  for (const key of ["id", "name", "tool_use_id", "source", "title"]) {
    const value = getStringField(block, key);
    if (value) parts.push(`${key}=${value}`);
  }
  if (typeof block.is_error === "boolean") {
    parts.push(`is_error=${block.is_error}`);
  }
  return `[Anthropic content block not directly supported by Codex: ${parts.join(", ")}]`;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function anthropicImageBlockToCodexPart(block: Record<string, unknown>): CodexContentPart | null {
  const source = block.source as Record<string, unknown> | undefined;
  if (source?.type === "base64" && source.media_type && source.data) {
    return {
      type: "input_image",
      image_url: `data:${source.media_type};base64,${source.data}`,
    };
  }
  if (source?.type === "url" && typeof source.url === "string") {
    return {
      type: "input_image",
      image_url: source.url,
    };
  }
  return null;
}

function textContentBlockToText(block: Record<string, unknown>): string | null {
  const text = getRawStringField(block, "text");
  return text && text.trim() ? text : null;
}

function documentBlockToText(block: Record<string, unknown>): string {
  const lines: string[] = ["Document:"];
  const title = getStringField(block, "title");
  const context = getStringField(block, "context");
  if (title) lines.push(`Title: ${title}`);
  if (context) lines.push(`Context: ${context}`);

  const source = block.source;
  if (isRecord(source)) {
    const sourceType = getStringField(source, "type");
    if (sourceType) lines.push(`Source type: ${sourceType}`);
    const mediaType = getStringField(source, "media_type");
    if (mediaType) lines.push(`Media type: ${mediaType}`);
    const url = getStringField(source, "url");
    if (url) lines.push(`URL: ${url}`);
    const fileId = getStringField(source, "file_id");
    if (fileId) lines.push(`File ID: ${fileId}`);
    if (sourceType === "text") {
      const data = getRawStringField(source, "data");
      if (data && data.trim()) lines.push("Content:", data);
    } else if (sourceType === "content") {
      const content = source.content;
      if (typeof content === "string") {
        if (content.trim()) lines.push("Content:", content);
      } else if (Array.isArray(content)) {
        const text = content
          .map((part) => {
            if (!isRecord(part)) return null;
            if (part.type === "text") return textContentBlockToText(part);
            if (part.type === "image") return "[Image content omitted]";
            return summarizeUnsupportedBlock(part);
          })
          .filter((part): part is string => Boolean(part))
          .join("\n");
        if (text) lines.push("Content:", text);
      }
    } else if (sourceType === "base64") {
      const data = getRawStringField(source, "data");
      if (data) lines.push(`Base64 data omitted (${data.length} chars)`);
    }
  }

  return lines.join("\n");
}

function searchResultBlockToText(block: Record<string, unknown>): string {
  const lines: string[] = ["Search result:"];
  const title = getStringField(block, "title");
  const source = getStringField(block, "source");
  if (title) lines.push(`Title: ${title}`);
  if (source) lines.push(`Source: ${source}`);

  const content = block.content;
  if (Array.isArray(content)) {
    const text = content
      .filter(isRecord)
      .map(textContentBlockToText)
      .filter((part): part is string => Boolean(part))
      .join("\n");
    if (text) lines.push("Content:", text);
  }

  return lines.join("\n");
}

function toolReferenceBlockToText(block: Record<string, unknown>): string | null {
  const toolName = getStringField(block, "tool_name");
  return toolName ? `Tool reference: ${toolName}` : "Tool reference";
}

function richContextBlockToText(block: Record<string, unknown>): string | null {
  switch (block.type) {
    case "document":
      return documentBlockToText(block);
    case "search_result":
      return searchResultBlockToText(block);
    case "tool_reference":
      return toolReferenceBlockToText(block);
    default:
      return null;
  }
}

function contentBlockToPromptText(block: Record<string, unknown>): string | null {
  if (block.type === "text") return textContentBlockToText(block);
  const richText = richContextBlockToText(block);
  if (richText) return richText;
  if (block.type === "image" || isToolCallBlock(block) || isToolResultBlock(block)) return null;
  return summarizeUnsupportedBlock(block);
}

function formatServerToolError(content: Record<string, unknown>, label: string): string | null {
  const errorCode = getStringField(content, "error_code");
  if (!errorCode) return null;
  const errorMessage = getStringField(content, "error_message");
  return `${label} error: ${errorCode}${errorMessage ? ` - ${errorMessage}` : ""}`;
}

function formatWebSearchResultContent(content: unknown): string {
  if (Array.isArray(content)) {
    const lines = content.flatMap((item, index) => {
      if (!isRecord(item)) return [`${index + 1}. ${String(item)}`];
      const title = getStringField(item, "title") ?? "(untitled)";
      const url = getStringField(item, "url");
      const pageAge = getStringField(item, "page_age");
      return [
        `${index + 1}. ${title}`,
        ...(url ? [`   URL: ${url}`] : []),
        ...(pageAge ? [`   Page age: ${pageAge}`] : []),
      ];
    });
    return lines.length ? `Web search results:\n${lines.join("\n")}` : "Web search returned no results.";
  }
  if (isRecord(content)) {
    return formatServerToolError(content, "Web search") ?? prettyJson(content);
  }
  return String(content ?? "");
}

function formatWebFetchResultContent(content: unknown): string {
  if (!isRecord(content)) return String(content ?? "");
  const error = formatServerToolError(content, "Web fetch");
  if (error) return error;

  const lines: string[] = ["Web fetch result:"];
  const url = getStringField(content, "url");
  const retrievedAt = getStringField(content, "retrieved_at");
  if (url) lines.push(`URL: ${url}`);
  if (retrievedAt) lines.push(`Retrieved at: ${retrievedAt}`);
  if (isRecord(content.content)) {
    lines.push(documentBlockToText(content.content));
  }
  return lines.join("\n");
}

function formatBashCodeExecutionResultContent(content: unknown): string {
  if (!isRecord(content)) return String(content ?? "");
  const error = formatServerToolError(content, "Bash code execution");
  if (error) return error;

  const lines: string[] = [];
  const returnCode = getNumberField(content, "return_code");
  lines.push(`Bash code execution result${returnCode !== null ? ` (return_code=${returnCode})` : ""}:`);
  const stdout = getStringField(content, "stdout");
  const stderr = getStringField(content, "stderr");
  if (stdout) lines.push(`stdout:\n${stdout}`);
  if (stderr) lines.push(`stderr:\n${stderr}`);
  if (Array.isArray(content.content) && content.content.length > 0) {
    lines.push("output files:");
    for (const item of content.content) {
      if (isRecord(item) && item.type === "bash_code_execution_output") {
        lines.push(`- file_id=${getStringField(item, "file_id") ?? "unknown"}`);
      }
    }
  }
  return lines.join("\n");
}

function formatTextEditorCodeExecutionResultContent(content: unknown): string {
  if (!isRecord(content)) return String(content ?? "");
  const error = formatServerToolError(content, "Text editor code execution");
  if (error) return error;

  switch (content.type) {
    case "text_editor_code_execution_view_result": {
      const lines = ["Text editor view result:"];
      const fileType = getStringField(content, "file_type");
      const startLine = getNumberField(content, "start_line");
      const numLines = getNumberField(content, "num_lines");
      const totalLines = getNumberField(content, "total_lines");
      if (fileType) lines.push(`File type: ${fileType}`);
      if (startLine !== null) lines.push(`Start line: ${startLine}`);
      if (numLines !== null) lines.push(`Lines returned: ${numLines}`);
      if (totalLines !== null) lines.push(`Total lines: ${totalLines}`);
      const text = getStringField(content, "content");
      if (text) lines.push(text);
      return lines.join("\n");
    }
    case "text_editor_code_execution_create_result":
      return `Text editor create result: is_file_update=${content.is_file_update === true}`;
    case "text_editor_code_execution_str_replace_result": {
      const lines = ["Text editor str_replace result:"];
      for (const key of ["old_start", "old_lines", "new_start", "new_lines"]) {
        const value = getNumberField(content, key);
        if (value !== null) lines.push(`${key}: ${value}`);
      }
      if (Array.isArray(content.lines) && content.lines.length > 0) {
        lines.push(content.lines.map(String).join("\n"));
      }
      return lines.join("\n");
    }
    default:
      return prettyJson(content);
  }
}

function formatToolSearchResultContent(content: unknown): string {
  if (!isRecord(content)) return String(content ?? "");
  const error = formatServerToolError(content, "Tool search");
  if (error) return error;
  if (content.type === "tool_search_tool_search_result" && Array.isArray(content.tool_references)) {
    const refs = content.tool_references
      .filter(isRecord)
      .map((ref) => `- ${getStringField(ref, "tool_name") ?? "unknown"}`)
      .join("\n");
    return refs ? `Tool search results:\n${refs}` : "Tool search returned no results.";
  }
  return prettyJson(content);
}

function formatServerToolResultBlock(block: Record<string, unknown>): string {
  const content = block.content;
  switch (block.type) {
    case "web_search_tool_result":
      return formatWebSearchResultContent(content);
    case "web_fetch_tool_result":
      return formatWebFetchResultContent(content);
    case "bash_code_execution_tool_result":
    case "code_execution_tool_result":
      return formatBashCodeExecutionResultContent(content);
    case "text_editor_code_execution_tool_result":
      return formatTextEditorCodeExecutionResultContent(content);
    case "tool_search_tool_result":
      return formatToolSearchResultContent(content);
    default:
      return prettyJson(content ?? block);
  }
}

/**
 * Map Anthropic thinking budget_tokens to Codex reasoning effort.
 */
function mapThinkingToEffort(
  thinking: AnthropicMessagesRequest["thinking"],
): string | undefined {
  if (!thinking || thinking.type === "disabled") return undefined;
  if (thinking.type === "adaptive") {
    // adaptive: use budget_tokens if provided, otherwise let Codex decide
    return thinking.budget_tokens ? budgetToEffort(thinking.budget_tokens) : undefined;
  }
  return budgetToEffort(thinking.budget_tokens);
}

/**
 * Extract text-only content from Anthropic blocks.
 */
function extractTextContent(
  content: string | Array<Record<string, unknown>>,
): string {
  if (typeof content === "string") return content;
  return content
    .map(contentBlockToPromptText)
    .filter((text): text is string => Boolean(text))
    .join("\n");
}

const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

function normalizeSystemInstructionText(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith(BILLING_HEADER_PREFIX) ? "" : trimmed;
}

/**
 * Build multimodal content (text + images) from Anthropic blocks.
 * Returns plain string if text-only, or CodexContentPart[] if images present.
 */
function extractMultimodalContent(
  content: Array<Record<string, unknown>>,
): string | CodexContentPart[] {
  const hasImage = content.some((b) => b.type === "image");
  if (!hasImage) return extractTextContent(content);

  const parts: CodexContentPart[] = [];
  for (const block of content) {
    if (block.type === "text") {
      const text = textContentBlockToText(block);
      if (text) parts.push({ type: "input_text", text });
    } else if (block.type === "image") {
      const part = anthropicImageBlockToCodexPart(block);
      if (part) parts.push(part);
    } else if (!isToolCallBlock(block) && !isToolResultBlock(block)) {
      const text = contentBlockToPromptText(block);
      if (text) parts.push({ type: "input_text", text });
    }
  }
  return parts.length > 0 ? parts : "";
}

function mapAnthropicOutputConfigToCodexText(
  outputConfig: AnthropicMessagesRequest["output_config"],
): CodexResponsesRequest["text"] | undefined {
  const format = outputConfig?.format;
  if (!isRecord(format) || format.type !== "json_schema" || !isRecord(format.schema)) {
    return undefined;
  }

  return {
    format: {
      type: "json_schema",
      schema: format.schema,
      ...(typeof format.name === "string" ? { name: format.name } : {}),
      ...(typeof format.strict === "boolean" ? { strict: format.strict } : {}),
    },
  };
}

/**
 * Convert Anthropic message content blocks into native Codex input items.
 * Handles text, image, tool_use, and tool_result blocks.
 */
function contentToInputItems(
  role: "user" | "assistant",
  content: string | Array<Record<string, unknown>>,
): CodexInputItem[] {
  if (typeof content === "string") {
    return [{ role, content }];
  }

  const items: CodexInputItem[] = [];

  // Build content (text or multimodal) for the message itself
  const hasToolBlocks = content.some((b) => isToolCallBlock(b) || isToolResultBlock(b));
  if (role === "user") {
    const extracted = extractMultimodalContent(content);
    if (extracted || !hasToolBlocks) {
      items.push({ role: "user", content: extracted || "" });
    }
  } else {
    // Assistant messages: text-only (Codex doesn't support structured assistant content)
    const text = extractTextContent(content);
    if (text || !hasToolBlocks) {
      items.push({ role: "assistant", content: text });
    }
  }

  for (const block of content) {
    if (isToolCallBlock(block)) {
      const name = typeof block.name === "string" ? block.name : "unknown";
      const id = typeof block.id === "string" ? block.id : `tc_${name}`;
      items.push({
        type: "function_call",
        call_id: id,
        name,
        arguments: safeJsonStringify(block.input ?? {}),
      });
    } else if (block.type === "tool_result") {
      const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "unknown";
      let resultText = "";
      const outputParts: CodexContentPart[] = [];
      if (typeof block.content === "string") {
        resultText = block.content;
      } else if (Array.isArray(block.content)) {
        const blocks = block.content as Array<Record<string, unknown>>;
        resultText = blocks
          .map(contentBlockToPromptText)
          .filter((text): text is string => Boolean(text))
          .join("\n");
        // Codex now accepts input_text/input_image content arrays in tool outputs.
        for (const b of blocks) {
          if (b.type === "image") {
            const part = anthropicImageBlockToCodexPart(b);
            if (part) outputParts.push(part);
          }
        }
      }
      if (block.is_error) {
        resultText = `Error: ${resultText}`;
      }
      items.push({
        type: "function_call_output",
        call_id: toolUseId,
        output: outputParts.length > 0
          ? [
              ...(resultText ? [{ type: "input_text" as const, text: resultText }] : []),
              ...outputParts,
            ]
          : resultText,
      });
    } else if (isToolResultBlock(block)) {
      const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "unknown";
      items.push({
        type: "function_call_output",
        call_id: toolUseId,
        output: formatServerToolResultBlock(block),
      });
    }
  }

  return items;
}

/**
 * Convert an AnthropicMessagesRequest to a CodexResponsesRequest.
 *
 * Mapping:
 *   - system (top-level) → instructions field
 *   - messages → input array
 *   - model → resolved model ID
 *   - thinking → reasoning.effort
 */
export function translateAnthropicToCodexRequest(
  req: AnthropicMessagesRequest,
  modelConfig?: ModelConfigOverride,
  options?: { injectHostedWebSearch?: boolean; mapClaudeCodeWebSearch?: boolean },
): CodexResponsesRequest {
  // Extract system instructions
  let userInstructions: string;
  if (req.system) {
    if (typeof req.system === "string") {
      userInstructions = normalizeSystemInstructionText(req.system);
    } else {
      userInstructions = req.system
        .map((b) => normalizeSystemInstructionText(b.text))
        .filter(Boolean)
        .join("\n\n");
    }
  } else {
    userInstructions = "You are a helpful assistant.";
  }
  const cfg = modelConfig ?? getConfig().model;
  const instructions = buildInstructions(userInstructions, cfg);

  // Build input items from messages
  const input: CodexInputItem[] = [];
  for (const msg of req.messages) {
    const items = contentToInputItems(
      msg.role as "user" | "assistant",
      msg.content as string | Array<Record<string, unknown>>,
    );
    input.push(...items);
  }

  // Ensure at least one input message
  if (input.length === 0) {
    input.push({ role: "user", content: "" });
  }

  // Resolve model (suffix parsing extracts service_tier and reasoning_effort)
  const parsed = parseModelName(req.model);
  const modelId = parsed.modelId;
  const modelInfo = getModelInfo(modelId);

  // Convert tools to Codex format
  const toolConversionOptions: AnthropicToolConversionOptions | undefined =
    options?.mapClaudeCodeWebSearch === true ? { mapClaudeCodeWebSearch: true } : undefined;
  const codexTools = req.tools?.length
    ? toolConversionOptions
      ? anthropicToolsToCodex(req.tools, toolConversionOptions)
      : anthropicToolsToCodex(req.tools)
    : [];
  // Claude Code 在非 Anthropic 官方 base URL 下会禁用自身 ToolSearch。
  // 只有走本地 Codex 后端时才默认交给 Codex hosted web_search。
  if (options?.injectHostedWebSearch === true && !hasHostedWebSearchTool(codexTools)) {
    codexTools.push({ type: "web_search" });
  }
  const codexToolChoice = toolConversionOptions
    ? anthropicToolChoiceToCodex(req.tool_choice, req.tools, toolConversionOptions)
    : anthropicToolChoiceToCodex(req.tool_choice, req.tools);
  const disableParallelToolUse =
    req.tool_choice &&
    "disable_parallel_tool_use" in req.tool_choice &&
    req.tool_choice.disable_parallel_tool_use === true;

  // Build request
  const request: CodexResponsesRequest = {
    model: modelId,
    instructions,
    input,
    stream: true,
    store: false,
    tools: codexTools,
    tool_choice: codexToolChoice ?? "auto",
    parallel_tool_calls: !disableParallelToolUse,
  };

  // Reasoning effort: thinking config > suffix > config default
  const thinkingEffort = mapThinkingToEffort(req.thinking);
  const effort =
    thinkingEffort ??
    parsed.reasoningEffort ??
    cfg.default_reasoning_effort;
  if (effort) {
    request.reasoning = { effort, summary: "auto" };
    request.include = ["reasoning.encrypted_content"];
  }

  const text = mapAnthropicOutputConfigToCodexText(req.output_config);
  if (text) request.text = text;

  // Service tier: suffix > config default
  const serviceTier =
    parsed.serviceTier ??
    cfg.default_service_tier ??
    null;
  if (serviceTier) {
    request.service_tier = serviceTier;
  }

  return request;
}
