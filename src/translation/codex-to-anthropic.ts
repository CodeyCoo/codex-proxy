/**
 * Translate Codex Responses API SSE stream → Anthropic Messages API format.
 *
 * Codex SSE events:
 *   response.created → extract response ID
 *   response.reasoning_summary_text.delta → thinking block (if wantThinking)
 *   response.output_text.delta → content_block_delta (text_delta)
 *   response.completed → content_block_stop + message_delta + message_stop
 *
 * Non-streaming: collect all text, return Anthropic message response.
 */

import { randomUUID } from "crypto";
import type { UpstreamAdapter } from "../proxy/upstream-adapter.js";
import type {
  AnthropicContentBlock,
  AnthropicMessagesResponse,
  AnthropicUsage,
} from "../types/anthropic.js";
import {
  iterateCodexEvents,
  EmptyResponseError,
  type UsageInfo,
} from "./codex-event-extractor.js";
import { log } from "../utils/logger.js";

/** Format an Anthropic SSE event with named event type */
function formatSSE(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

function shouldLogAnthropicCompatibilityDebug(): boolean {
  return process.env.DEBUG_ANTHROPIC_COMPAT === "1";
}

function summarizeAnthropicSseSequence(events: string[]): string[] {
  const counts = new Map<string, number>();

  for (const event of events) {
    counts.set(event, (counts.get(event) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([event, count]) => `${event}x${count}`)
    .sort();
}

function logAnthropicStreamDebug(extra: {
  model: string;
  wantThinking: boolean;
  hasToolCalls: boolean;
  sequence: string[];
  usage?: UsageInfo;
}): void {
  if (!shouldLogAnthropicCompatibilityDebug()) return;

  log.debug("[AnthropicCompat] SSE stream summary", {
    model: extra.model,
    wantThinking: extra.wantThinking,
    hasToolUse: extra.hasToolCalls,
    sequence: summarizeAnthropicSseSequence(extra.sequence),
    usage: extra.usage,
  });
}

function logAnthropicCollectDebug(extra: {
  model: string;
  wantThinking: boolean;
  hasToolCalls: boolean;
  contentTypes: string[];
  usage: UsageInfo;
}): void {
  if (!shouldLogAnthropicCompatibilityDebug()) return;

  log.debug("[AnthropicCompat] Collected response summary", {
    model: extra.model,
    wantThinking: extra.wantThinking,
    hasToolUse: extra.hasToolCalls,
    contentTypes: extra.contentTypes,
    usage: extra.usage,
  });
}

function pushSequenceEvent(sequence: string[], event: string): void {
  if (!shouldLogAnthropicCompatibilityDebug()) return;
  sequence.push(event);
}

/**
 * Stream Codex Responses API events as Anthropic Messages SSE.
 * Yields string chunks ready to write to the HTTP response.
 *
 * When wantThinking is true, reasoning summary deltas are emitted as
 * thinking content blocks before the text block.
 */
export async function* streamCodexToAnthropic(
  codexApi: UpstreamAdapter,
  rawResponse: Response,
  model: string,
  onUsage?: (usage: UsageInfo) => void,
  onResponseId?: (id: string) => void,
  wantThinking?: boolean,
  precomputedInputTokens?: number,
): AsyncGenerator<string> {
  const msgId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  let outputTokens = 0;
  let inputTokens = 0;
  let cachedTokens: number | undefined;
  let hasToolCalls = false;
  let hasContent = false;
  let contentIndex = 0;
  let textBlockStarted = false;
  let thinkingBlockStarted = false;
  let stopReason: AnthropicMessagesResponse["stop_reason"] | undefined;
  let stopSequence: string | null = null;
  const callIdsWithDeltas = new Set<string>();
  const sseSequence: string[] = [];

  // Helper: close an open block and advance the index
  function* closeBlock(blockType: "thinking" | "text"): Generator<string> {
    pushSequenceEvent(sseSequence, `content_block_stop:${blockType}`);
    yield formatSSE("content_block_stop", {
      type: "content_block_stop",
      index: contentIndex,
    });
    contentIndex++;
    if (blockType === "thinking") thinkingBlockStarted = false;
    else textBlockStarted = false;
  }

  // Helper: ensure thinking block is closed before a non-thinking block
  function* closeThinkingIfOpen(): Generator<string> {
    if (thinkingBlockStarted) yield* closeBlock("thinking");
  }

  // Helper: ensure text block is closed
  function* closeTextIfOpen(): Generator<string> {
    if (textBlockStarted) yield* closeBlock("text");
  }

  // Helper: ensure a text block is open
  function* ensureTextBlock(): Generator<string> {
    if (!textBlockStarted) {
      pushSequenceEvent(sseSequence, "content_block_start:text");
      yield formatSSE("content_block_start", {
        type: "content_block_start",
        index: contentIndex,
        content_block: { type: "text", text: "" },
      });
      textBlockStarted = true;
    }
  }

  // 0. ping (official Anthropic API sends this before message_start)
  yield "event: ping\ndata: {}\n\n";

  // 1. message_start
  pushSequenceEvent(sseSequence, "message_start");
  yield formatSSE("message_start", {
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: precomputedInputTokens ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
      service_tier: "standard",
    },
  });

  // Don't eagerly open a text block — wait for actual content so thinking can come first

  // 2. Process Codex stream events
  for await (const evt of iterateCodexEvents(codexApi, rawResponse)) {
    if (evt.responseId) onResponseId?.(evt.responseId);

    // Handle upstream error events
    if (evt.error) {
      yield* closeThinkingIfOpen();
      yield* ensureTextBlock();
      pushSequenceEvent(sseSequence, "content_block_delta:text");
      yield formatSSE("content_block_delta", {
        type: "content_block_delta",
        index: contentIndex,
        delta: { type: "text_delta", text: `[Error] ${evt.error.code}: ${evt.error.message}` },
      });
      yield* closeBlock("text");
      pushSequenceEvent(sseSequence, "error");
      yield formatSSE("error", {
        type: "error",
        error: { type: "api_error", message: `${evt.error.code}: ${evt.error.message}` },
      });
      pushSequenceEvent(sseSequence, "message_stop");
      yield formatSSE("message_stop", { type: "message_stop" });
      logAnthropicStreamDebug({
        model,
        wantThinking: Boolean(wantThinking),
        hasToolCalls,
        sequence: sseSequence,
        usage: inputTokens || outputTokens || cachedTokens != null
          ? { input_tokens: inputTokens, output_tokens: outputTokens, cached_tokens: cachedTokens }
          : undefined,
      });
      return;
    }

    // Codex reasoning is intentionally dropped — the proxy cannot produce a
    // valid Anthropic `thinking.signature`, so emitting a thinking block would
    // poison the client's history and cause `Invalid signature` 400s when the
    // conversation is later sent back to official Claude.
    if (evt.reasoningDelta) {
      continue;
    }

    // Handle function call start → close open blocks, open tool_use block
    if (evt.functionCallStart) {
      hasToolCalls = true;
      hasContent = true;

      yield* closeThinkingIfOpen();
      yield* closeTextIfOpen();

      // Start tool_use block
      pushSequenceEvent(sseSequence, "content_block_start:tool_use");
      yield formatSSE("content_block_start", {
        type: "content_block_start",
        index: contentIndex,
        content_block: {
          type: "tool_use",
          id: evt.functionCallStart.callId,
          name: evt.functionCallStart.name,
          input: {},
        },
      });
      continue;
    }

    if (evt.functionCallDelta) {
      callIdsWithDeltas.add(evt.functionCallDelta.callId);
      pushSequenceEvent(sseSequence, "content_block_delta:tool_use");
      yield formatSSE("content_block_delta", {
        type: "content_block_delta",
        index: contentIndex,
        delta: { type: "input_json_delta", partial_json: evt.functionCallDelta.delta },
      });
      continue;
    }

    if (evt.functionCallDone) {
      // Emit full arguments if no deltas were streamed
      if (!callIdsWithDeltas.has(evt.functionCallDone.callId)) {
        pushSequenceEvent(sseSequence, "content_block_delta:tool_use");
        yield formatSSE("content_block_delta", {
          type: "content_block_delta",
          index: contentIndex,
          delta: { type: "input_json_delta", partial_json: evt.functionCallDone.arguments },
        });
      }
      // Close this tool_use block
      pushSequenceEvent(sseSequence, "content_block_stop:tool_use");
      yield formatSSE("content_block_stop", {
        type: "content_block_stop",
        index: contentIndex,
      });
      contentIndex++;
      continue;
    }

    switch (evt.typed.type) {
      case "response.output_text.delta": {
        if (evt.textDelta) {
          hasContent = true;
          // Close thinking block if open (transition from thinking → text)
          yield* closeThinkingIfOpen();
          // Open a text block if not already open
          yield* ensureTextBlock();
          pushSequenceEvent(sseSequence, "content_block_delta:text");
          yield formatSSE("content_block_delta", {
            type: "content_block_delta",
            index: contentIndex,
            delta: { type: "text_delta", text: evt.textDelta },
          });
        }
        break;
      }

      case "response.completed": {
        if (evt.usage) {
          inputTokens = evt.usage.input_tokens;
          outputTokens = evt.usage.output_tokens;
          cachedTokens = evt.usage.cached_tokens;
          onUsage?.({ input_tokens: inputTokens, output_tokens: outputTokens, cached_tokens: cachedTokens, reasoning_tokens: evt.usage.reasoning_tokens });
        }
        stopReason = evt.typed.response.stop_reason as AnthropicMessagesResponse["stop_reason"];
        stopSequence = evt.typed.response.stop_sequence ?? null;
        // Inject error text if stream completed with no content
        if (!hasContent) {
          yield* ensureTextBlock();
          pushSequenceEvent(sseSequence, "content_block_delta:text");
          yield formatSSE("content_block_delta", {
            type: "content_block_delta",
            index: contentIndex,
            delta: { type: "text_delta", text: "[Error] Codex returned an empty response. Please retry." },
          });
        }
        break;
      }
    }
  }

  // 3. Close any open blocks
  yield* closeThinkingIfOpen();
  yield* closeTextIfOpen();

  // 4. message_delta with stop_reason and usage
  pushSequenceEvent(sseSequence, "message_delta");
  yield formatSSE("message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: stopReason ?? (hasToolCalls ? "tool_use" : "end_turn"),
      stop_sequence: stopSequence,
    },
    usage: {
      input_tokens: inputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cachedTokens ?? 0,
      output_tokens: outputTokens,
    },
  });

  // 5. message_stop
  pushSequenceEvent(sseSequence, "message_stop");
  yield formatSSE("message_stop", {
    type: "message_stop",
  });

  logAnthropicStreamDebug({
    model,
    wantThinking: Boolean(wantThinking),
    hasToolCalls,
    sequence: sseSequence,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      ...(cachedTokens != null ? { cached_tokens: cachedTokens } : {}),
    },
  });
}

/**
 * Consume a Codex Responses SSE stream and build a non-streaming
 * Anthropic Messages response.
 */
export async function collectCodexToAnthropicResponse(
  codexApi: UpstreamAdapter,
  rawResponse: Response,
  model: string,
  wantThinking?: boolean,
  precomputedInputTokens?: number,
): Promise<{
  response: AnthropicMessagesResponse;
  usage: UsageInfo;
  responseId: string | null;
}> {
  const id = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  let fullText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens: number | undefined;
  let responseId: string | null = null;
  let stopReason: AnthropicMessagesResponse["stop_reason"] | undefined;
  let stopSequence: string | null = null;

  // Collect tool calls
  const toolUseBlocks: AnthropicContentBlock[] = [];

  for await (const evt of iterateCodexEvents(codexApi, rawResponse)) {
    if (evt.responseId) responseId = evt.responseId;
    if (evt.error) {
      throw new Error(`Codex API error: ${evt.error.code}: ${evt.error.message}`);
    }
    if (evt.textDelta) fullText += evt.textDelta;
    // Codex reasoning is intentionally dropped (see below) — don't accumulate.
    if (evt.usage) {
      inputTokens = evt.usage.input_tokens;
      outputTokens = evt.usage.output_tokens;
      cachedTokens = evt.usage.cached_tokens;
    }
    if (evt.typed.type === "response.completed") {
      stopReason = (evt.typed.response.stop_reason as AnthropicMessagesResponse["stop_reason"]) ?? stopReason;
      stopSequence = evt.typed.response.stop_sequence ?? stopSequence;
    }
    if (evt.functionCallDone) {
      let parsedInput: Record<string, unknown> = {};
      try {
        parsedInput = JSON.parse(evt.functionCallDone.arguments) as Record<string, unknown>;
      } catch { /* use empty object */ }
      toolUseBlocks.push({
        type: "tool_use",
        id: evt.functionCallDone.callId,
        name: evt.functionCallDone.name,
        input: parsedInput,
      });
    }
  }

  // Detect empty response (HTTP 200 but no content)
  if (!fullText && toolUseBlocks.length === 0 && outputTokens === 0) {
    throw new EmptyResponseError(responseId, { input_tokens: inputTokens, output_tokens: outputTokens });
  }

  const hasToolCalls = toolUseBlocks.length > 0;
  const content: AnthropicContentBlock[] = [];
  // Codex reasoning is intentionally dropped — the proxy cannot produce a
  // valid Anthropic `thinking.signature`, so emitting a thinking block would
  // poison the client's history and cause `Invalid signature` 400s when the
  // conversation is later sent back to official Claude.
  if (fullText) {
    content.push({ type: "text", text: fullText });
  }
  content.push(...toolUseBlocks);
  // Ensure at least one content block
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  const finalInputTokens = inputTokens || precomputedInputTokens || 0;
  const usage: AnthropicUsage = {
    input_tokens: finalInputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cachedTokens ?? 0,
  };

  logAnthropicCollectDebug({
    model,
    wantThinking: Boolean(wantThinking),
    hasToolCalls,
    contentTypes: content.map((block) => block.type),
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      ...(cachedTokens != null ? { cached_tokens: cachedTokens } : {}),
    },
  });

  return {
    response: {
      id,
      type: "message",
      role: "assistant",
      content,
      model,
      stop_reason: stopReason ?? (hasToolCalls ? "tool_use" : "end_turn"),
      stop_sequence: stopSequence,
      usage,
      service_tier: "standard",
    },
    usage,
    responseId,
  };
}
