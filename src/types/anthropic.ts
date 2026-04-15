/**
 * Anthropic Messages API types for /v1/messages compatibility
 */
import { z } from "zod";

// --- Request ---

const AnthropicTextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const AnthropicImageContentSchema = z.object({
  type: z.literal("image"),
  source: z.object({
    type: z.literal("base64"),
    media_type: z.string(),
    data: z.string(),
  }),
});

const AnthropicToolUseContentSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
});

const AnthropicToolResultContentBlockSchema = z.discriminatedUnion("type", [
  AnthropicTextContentSchema,
  AnthropicImageContentSchema,
]);

const AnthropicToolResultContentSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(AnthropicToolResultContentBlockSchema)]).optional(),
  is_error: z.boolean().optional(),
});

// Extended thinking content blocks (sent back in conversation history)
const AnthropicThinkingContentSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional(),
});

const AnthropicRedactedThinkingContentSchema = z.object({
  type: z.literal("redacted_thinking"),
  data: z.string(),
});

const AnthropicContentBlockSchema = z.union([
  z.discriminatedUnion("type", [
    AnthropicTextContentSchema,
    AnthropicImageContentSchema,
    AnthropicToolUseContentSchema,
    AnthropicToolResultContentSchema,
    AnthropicThinkingContentSchema,
    AnthropicRedactedThinkingContentSchema,
  ]),
  // Catch-all: forward-compatibility for new content block types (e.g. "document")
  // introduced by Claude Code updates. Unknown types are passed through and ignored
  // by translation functions.
  z.object({ type: z.string() }).passthrough(),
]);

const AnthropicContentSchema = z.union([
  z.string(),
  z.array(AnthropicContentBlockSchema),
]);

const AnthropicMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: AnthropicContentSchema,
});

const AnthropicThinkingEnabledSchema = z.object({
  type: z.literal("enabled"),
  budget_tokens: z.number().int().positive(),
});

const AnthropicThinkingDisabledSchema = z.object({
  type: z.literal("disabled"),
});

const AnthropicThinkingAdaptiveSchema = z.object({
  type: z.literal("adaptive"),
  budget_tokens: z.number().int().positive().optional(),
});

const AnthropicContainerSkillSchema = z.object({
  type: z.string(),
}).passthrough();

const AnthropicContainerObjectSchema = z.object({
  type: z.string().optional(),
  id: z.string().optional(),
  skills: z.array(AnthropicContainerSkillSchema).optional(),
}).passthrough();

const AnthropicContextManagementSchema = z.object({
  clear_function_results: z.boolean().optional(),
  edits: z.array(z.object({
    type: z.string(),
  }).passthrough()).optional(),
}).passthrough();

export const AnthropicMessagesRequestSchema = z.object({
  model: z.string(),
  max_tokens: z.number().int().positive(),
  messages: z.array(AnthropicMessageSchema).min(1),
  system: z
    .union([z.string(), z.array(AnthropicTextContentSchema)])
    .optional(),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  metadata: z
    .object({
      user_id: z.string().optional(),
    })
    .optional(),
  container: z.union([z.string(), AnthropicContainerObjectSchema, z.null()]).optional(),
  context_management: z.union([AnthropicContextManagementSchema, z.null()]).optional(),
  thinking: z
    .union([
      AnthropicThinkingEnabledSchema,
      AnthropicThinkingDisabledSchema,
      AnthropicThinkingAdaptiveSchema,
    ])
    .optional(),
  // Tool-related fields (accepted for compatibility, not forwarded to Codex)
  tools: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.record(z.unknown()).optional(),
  }).passthrough()).optional(),
  tool_choice: z.union([
    z.object({ type: z.literal("auto") }),
    z.object({ type: z.literal("any") }),
    z.object({ type: z.literal("tool"), name: z.string() }),
  ]).optional(),
}).passthrough();

export const AnthropicMessageCountTokensRequestSchema = z.object({
  model: z.string(),
  messages: z.array(AnthropicMessageSchema).min(1),
  system: z
    .union([z.string(), z.array(AnthropicTextContentSchema)])
    .optional(),
  cache_control: z.object({ type: z.string() }).passthrough().optional(),
  container: z.union([z.string(), AnthropicContainerObjectSchema, z.null()]).optional(),
  context_management: z.union([AnthropicContextManagementSchema, z.null()]).optional(),
  mcp_servers: z.array(z.object({ type: z.string() }).passthrough()).optional(),
  output_config: z.record(z.unknown()).optional(),
  output_format: z.record(z.unknown()).optional(),
  speed: z.enum(["standard", "fast"]).optional(),
  thinking: z
    .union([
      AnthropicThinkingEnabledSchema,
      AnthropicThinkingDisabledSchema,
      AnthropicThinkingAdaptiveSchema,
    ])
    .optional(),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.record(z.unknown()).optional(),
  }).passthrough()).optional(),
  tool_choice: z.union([
    z.object({ type: z.literal("auto") }),
    z.object({ type: z.literal("any") }),
    z.object({ type: z.literal("tool"), name: z.string() }),
  ]).optional(),
}).passthrough();

export type AnthropicMessagesRequest = z.infer<
  typeof AnthropicMessagesRequestSchema
>;

export type AnthropicMessageCountTokensRequest = z.infer<
  typeof AnthropicMessageCountTokensRequestSchema
>;

export interface AnthropicMessageTokensCountResponse {
  input_tokens: number;
  context_management?: {
    original_input_tokens: number;
  } | null;
}

// --- Response ---

export interface AnthropicContentBlock {
  type: "text" | "thinking" | "tool_use";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "pause_turn" | "refusal" | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
  service_tier?: "standard" | "priority" | "batch" | null;
}

// --- Error ---

export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error";

export interface AnthropicErrorBody {
  type: "error";
  error: {
    type: AnthropicErrorType;
    message: string;
  };
}
