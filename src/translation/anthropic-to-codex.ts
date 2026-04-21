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
import { anthropicToolsToCodex, anthropicToolChoiceToCodex } from "./tool-format.js";
import { log } from "../utils/logger.js";

function shouldLogAnthropicCompatibilityDebug(): boolean {
  return process.env.DEBUG_ANTHROPIC_COMPAT === "1";
}

function collectUnknownAnthropicBlockTypes(
  messages: AnthropicMessagesRequest["messages"],
): string[] {
  const knownTypes = new Set([
    "text",
    "image",
    "tool_use",
    "tool_result",
    "thinking",
    "redacted_thinking",
    "server_tool_use",
  ]);
  const unknown = new Set<string>();

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (typeof block?.type === "string" && !knownTypes.has(block.type)) {
        unknown.add(block.type);
      }
    }
  }

  return [...unknown].sort();
}

function collectIgnoredAnthropicTopLevelFields(
  req: AnthropicMessagesRequest,
): string[] {
  const explicitlyIgnored = [
    "cache_control",
    "container",
    "context_management",
    "inference_geo",
    "mcp_servers",
  ];
  const knownRequestKeys = new Set([
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
    "thinking",
    "tools",
    "tool_choice",
    ...explicitlyIgnored,
  ]);

  const presentIgnored = explicitlyIgnored.filter((key) => key in req && req[key as keyof AnthropicMessagesRequest] != null);
  const futureFields = Object.keys(req).filter((key) => !knownRequestKeys.has(key));

  return [...new Set([...presentIgnored, ...futureFields])].sort();
}

function logIgnoredAnthropicRequestFeatures(extra: {
  topLevelFields: string[];
  contentBlockTypes: string[];
}): void {
  if (!shouldLogAnthropicCompatibilityDebug()) return;
  if (extra.topLevelFields.length === 0 && extra.contentBlockTypes.length === 0) return;

  log.debug("[AnthropicCompat] Ignored request features", {
    topLevelFields: extra.topLevelFields,
    contentBlockTypes: extra.contentBlockTypes,
  });
}

function collectCompatibilityAnnotations(
  req: AnthropicMessagesRequest,
): {
  ignoredTopLevelFields: string[];
  unsupportedBlockTypes: string[];
} {
  return {
    ignoredTopLevelFields: collectIgnoredAnthropicTopLevelFields(req),
    unsupportedBlockTypes: collectUnknownAnthropicBlockTypes(req.messages),
  };
}

function attachCompatibilitySystemNote(
  instructions: string,
  annotations: {
    ignoredTopLevelFields: string[];
    unsupportedBlockTypes: string[];
  },
): string {
  if (
    annotations.ignoredTopLevelFields.length === 0
    && annotations.unsupportedBlockTypes.length === 0
  ) {
    return instructions;
  }

  const notes: string[] = [];
  if (annotations.ignoredTopLevelFields.length > 0) {
    notes.push(`Ignored Anthropic top-level fields: ${annotations.ignoredTopLevelFields.join(", ")}.`);
  }
  if (annotations.unsupportedBlockTypes.length > 0) {
    notes.push(`Ignored Anthropic content block types: ${annotations.unsupportedBlockTypes.join(", ")}.`);
  }

  return `${instructions}\n\n[Anthropic compatibility note]\n${notes.join("\n")}`;
}

function shouldAttachCompatibilitySystemNote(): boolean {
  return process.env.ANTHROPIC_COMPAT_SYSTEM_NOTES === "1";
}

function buildAnthropicCompatibilityInstructions(
  instructions: string,
  annotations: {
    ignoredTopLevelFields: string[];
    unsupportedBlockTypes: string[];
  },
): string {
  if (!shouldAttachCompatibilitySystemNote()) return instructions;
  return attachCompatibilitySystemNote(instructions, annotations);
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
function makeUnsupportedBlockNote(block: Record<string, unknown>): string | null {
  switch (block.type) {
    // thinking / redacted_thinking: the proxy cannot forward reasoning to
    // Codex. Any cross-model reasoning transplant has uncertain benefit and
    // real risk (style drift, token bloat), and the proxy cannot produce a
    // valid `thinking.signature` either. So thinking blocks are silently
    // dropped on the inbound side — no compat note, no token waste, Codex
    // simply doesn't see them. Client history (which is authoritative) is
    // untouched; any signed thinking blocks there remain intact for when the
    // conversation is sent back to official Claude.
    case "thinking":
    case "redacted_thinking": {
      return null;
    }
    case "tool_reference": {
      const toolName = typeof block.tool_name === "string"
        ? block.tool_name
        : typeof block.name === "string"
          ? block.name
          : "unknown";
      return `[Anthropic compatibility note] tool_reference block for tool "${toolName}" was downgraded to text.`;
    }
    case "container_upload": {
      const fileId = typeof block.file_id === "string" ? block.file_id : "unknown";
      return `[Anthropic compatibility note] container_upload block for file "${fileId}" was downgraded to text.`;
    }
    case "server_tool_use": {
      const toolName = typeof block.name === "string" ? block.name : "unknown";
      return `[Anthropic compatibility note] server_tool_use block for tool "${toolName}" was downgraded to text.`;
    }
    default:
      return null;
  }
}

function extractTextContent(
  content: string | Array<Record<string, unknown>>,
): string {
  if (typeof content === "string") return content;
  return content
    .flatMap((b) => {
      if (b.type === "text" && typeof b.text === "string") return [b.text as string];
      const note = makeUnsupportedBlockNote(b);
      return note ? [note] : [];
    })
    .join("\n");
}

function extractUnsupportedTextNotes(
  content: Array<Record<string, unknown>>,
): string[] {
  return content
    .map((block) => makeUnsupportedBlockNote(block))
    .filter((note): note is string => Boolean(note));
}

function mergeTextWithUnsupportedNotes(
  text: string,
  content: Array<Record<string, unknown>>,
): string {
  const notes = extractUnsupportedTextNotes(content);
  if (notes.length === 0) return text;
  return [text, ...notes].filter(Boolean).join("\n");
}

function hasRenderableUserContent(content: Array<Record<string, unknown>>): boolean {
  return content.some((block) => {
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) return true;
    if (block.type === "image") return true;
    return makeUnsupportedBlockNote(block) != null;
  });
}

function hasRenderableAssistantContent(content: Array<Record<string, unknown>>): boolean {
  return content.some((block) => {
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) return true;
    return makeUnsupportedBlockNote(block) != null;
  });
}

function extractMultimodalTextParts(content: Array<Record<string, unknown>>): CodexContentPart[] {
  const parts: CodexContentPart[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "input_text", text: block.text });
      continue;
    }
    const note = makeUnsupportedBlockNote(block);
    if (note) {
      parts.push({ type: "input_text", text: note });
    }
  }
  return parts;
}

function mergePartsWithUnsupportedNotes(
  parts: CodexContentPart[],
  content: Array<Record<string, unknown>>,
): CodexContentPart[] {
  const notes = extractUnsupportedTextNotes(content).map((text) => ({
    type: "input_text" as const,
    text,
  }));
  return [...parts, ...notes];
}

function extractToolResultText(
  content: string | Array<Record<string, unknown>> | undefined,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .flatMap((block) => {
      if (block.type === "text" && typeof block.text === "string") return [block.text as string];
      const note = makeUnsupportedBlockNote(block);
      return note ? [note] : [];
    })
    .join("\n");
}

function extractToolResultImages(
  content: Array<Record<string, unknown>>,
): CodexContentPart[] {
  const imageParts: CodexContentPart[] = [];
  for (const b of content) {
    if (b.type === "image") {
      const source = b.source as
        | { type: string; media_type: string; data: string }
        | undefined;
      if (source?.type === "base64" && source.media_type && source.data) {
        imageParts.push({
          type: "input_image",
          image_url: `data:${source.media_type};base64,${source.data}`,
        });
      }
    }
  }
  return imageParts;
}

function extractToolResultFollowupParts(
  content: Array<Record<string, unknown>>,
): CodexContentPart[] {
  return extractToolResultImages(content);
}

function extractTextOnlyAssistantContent(content: Array<Record<string, unknown>>): string {
  return extractTextContent(content);
}

function extractRenderableUserContent(content: Array<Record<string, unknown>>): string | CodexContentPart[] {
  return extractMultimodalContent(content);
}

function extractMultimodalContent(
  content: Array<Record<string, unknown>>,
): string | CodexContentPart[] {
  const hasImage = content.some((b) => b.type === "image");
  if (!hasImage) return extractTextContent(content);

  const parts: CodexContentPart[] = extractMultimodalTextParts(content);
  for (const block of content) {
    if (block.type === "image") {
      // Anthropic format: source: { type: "base64", media_type: "image/png", data: "..." }
      const source = block.source as
        | { type: string; media_type: string; data: string }
        | undefined;
      if (source?.type === "base64" && source.media_type && source.data) {
        parts.push({
          type: "input_image",
          image_url: `data:${source.media_type};base64,${source.data}`,
        });
      }
    }
  }
  return parts.length > 0 ? parts : "";
}

/**
 * Build multimodal content (text + images) from Anthropic blocks.
 * Returns plain string if text-only, or CodexContentPart[] if images present.
 */

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
  let pendingBlocks: Array<Record<string, unknown>> = [];

  function flushPendingBlocks(): void {
    if (pendingBlocks.length === 0) return;

    if (role === "user") {
      const extracted = extractRenderableUserContent(pendingBlocks);
      if (hasRenderableUserContent(pendingBlocks)) {
        items.push({ role: "user", content: extracted || "" });
      }
    } else {
      const text = extractTextOnlyAssistantContent(pendingBlocks);
      if (hasRenderableAssistantContent(pendingBlocks)) {
        items.push({ role: "assistant", content: text });
      }
    }

    pendingBlocks = [];
  }

  for (const block of content) {
    if (block.type !== "tool_use" && block.type !== "tool_result") {
      pendingBlocks.push(block);
      continue;
    }

    flushPendingBlocks();

    if (block.type === "tool_use") {
      const name = typeof block.name === "string" ? block.name : "unknown";
      const id = typeof block.id === "string" ? block.id : `tc_${name}`;
      let args: string;
      try {
        args = JSON.stringify(block.input ?? {});
      } catch {
        args = "{}";
      }
      items.push({
        type: "function_call",
        call_id: id,
        name,
        arguments: args,
      });
      continue;
    }

    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "unknown";
    let resultText = extractToolResultText(block.content as string | Array<Record<string, unknown>> | undefined);
    let followupParts: CodexContentPart[] = [];
    if (Array.isArray(block.content)) {
      const blocks = block.content as Array<Record<string, unknown>>;
      followupParts = extractToolResultFollowupParts(blocks);
    }
    if (block.is_error) {
      resultText = `Error: ${resultText}`;
    }
    items.push({
      type: "function_call_output",
      call_id: toolUseId,
      output: resultText,
    });
    if (followupParts.length > 0) {
      items.push({ role: "user", content: followupParts });
    }
  }

  flushPendingBlocks();

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
): CodexResponsesRequest {
  // Extract system instructions
  let userInstructions: string;
  if (req.system) {
    if (typeof req.system === "string") {
      userInstructions = req.system;
    } else {
      userInstructions = req.system.map((b) => b.text).join("\n\n");
    }
  } else {
    userInstructions = "You are a helpful assistant.";
  }
  const cfg = modelConfig ?? getConfig().model;
  const annotations = collectCompatibilityAnnotations(req);
  const instructions = buildAnthropicCompatibilityInstructions(
    buildInstructions(userInstructions, cfg),
    annotations,
  );

  if (shouldLogAnthropicCompatibilityDebug()) {
    if (annotations.unsupportedBlockTypes.length > 0) {
      log.debug("[AnthropicCompat] Unknown content block types", {
        blockTypes: annotations.unsupportedBlockTypes,
      });
    }
    logIgnoredAnthropicRequestFeatures({
      topLevelFields: annotations.ignoredTopLevelFields,
      contentBlockTypes: annotations.unsupportedBlockTypes,
    });
  }

  // Note: advanced Anthropic features are accepted at the schema layer, but
  // Codex has no native equivalents for them here yet. We surface them via
  // compatibility annotations/logging instead of silently dropping them.

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
  const codexTools = req.tools?.length ? anthropicToolsToCodex(req.tools) : [];
  const codexToolChoice = anthropicToolChoiceToCodex(req.tool_choice);

  // Build request
  const request: CodexResponsesRequest = {
    model: modelId,
    instructions,
    input,
    stream: true,
    store: false,
    tools: codexTools,
  };

  // Add tool_choice if specified
  if (codexToolChoice) {
    request.tool_choice = codexToolChoice;
  }

  // Reasoning effort: thinking config > suffix > config default
  const thinkingEffort = mapThinkingToEffort(req.thinking);
  const effort =
    thinkingEffort ??
    parsed.reasoningEffort ??
    cfg.default_reasoning_effort;
  if (effort) {
    request.reasoning = { effort, summary: "auto" };
  }

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
