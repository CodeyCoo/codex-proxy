/**
 * Local token counting using js-tiktoken.
 *
 * Uses cl100k_base encoding (closest available to Claude/Codex tokenizers)
 * to provide accurate input token estimates before streaming begins.
 */

import { encodingForModel } from "js-tiktoken";
import type { CodexResponsesRequest, CodexInputItem } from "../proxy/codex-api.js";

let encoder: ReturnType<typeof encodingForModel> | null = null;

function getEncoder() {
  if (!encoder) {
    encoder = encodingForModel("gpt-4o");
  }
  return encoder;
}

/** Count tokens in a string. */
function countStringTokens(text: string): number {
  if (!text) return 0;
  return getEncoder().encode(text).length;
}

/** Extract all text from a CodexInputItem for tokenization. */
function extractItemText(item: CodexInputItem): string {
  if ("role" in item) {
    if (typeof item.content === "string") return item.content;
    if (Array.isArray(item.content)) {
      return item.content
        .filter((p) => p.type === "input_text")
        .map((p) => (p as { text: string }).text)
        .join("\n");
    }
    return "";
  }
  if (item.type === "function_call") {
    return `${item.name}\n${item.arguments}`;
  }
  if (item.type === "function_call_output") {
    return item.output;
  }
  return "";
}

/**
 * Count the approximate input tokens for a Codex request.
 *
 * Tokenizes instructions, all input items, and tool definitions.
 * The count closely matches what the upstream model will report.
 */
export function countRequestInputTokens(req: CodexResponsesRequest): number {
  let total = 0;

  // Instructions / system prompt
  if (req.instructions) {
    total += countStringTokens(req.instructions);
  }

  // Input items (messages, function calls, function outputs)
  for (const item of req.input) {
    total += countStringTokens(extractItemText(item));
    // Per-message overhead (role tokens, separators, etc.)
    total += 4;
  }

  // Tool definitions
  if (req.tools?.length) {
    total += countStringTokens(JSON.stringify(req.tools));
  }

  // Base overhead for request framing
  total += 10;

  return total;
}
