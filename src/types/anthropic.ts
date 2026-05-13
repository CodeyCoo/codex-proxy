/**
 * Anthropic Messages API types for /v1/messages compatibility
 */
import { z } from "zod";

// --- Request ---

const AnthropicCacheControlSchema = z.object({
  type: z.string(),
}).passthrough();

const AnthropicOutputConfigSchema = z.object({
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().optional(),
  format: z.object({
    type: z.string(),
    schema: z.record(z.unknown()).optional(),
  }).passthrough().nullable().optional(),
}).passthrough();

const AnthropicTextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  cache_control: AnthropicCacheControlSchema.optional(),
  citations: z.array(z.object({ type: z.string() }).passthrough()).nullable().optional(),
}).passthrough();

const AnthropicImageContentSchema = z.object({
  type: z.literal("image"),
  source: z.union([
    z.object({
      type: z.literal("base64"),
      media_type: z.string(),
      data: z.string(),
    }),
    z.object({
      type: z.literal("url"),
      url: z.string(),
    }),
  ]),
  cache_control: AnthropicCacheControlSchema.optional(),
}).passthrough();

const AnthropicDocumentSourceContentSchema = z.discriminatedUnion("type", [
  AnthropicTextContentSchema,
  AnthropicImageContentSchema,
]);

const AnthropicDocumentSourceSchema = z.union([
  z.object({
    type: z.literal("base64"),
    media_type: z.string(),
    data: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("text"),
    media_type: z.string().optional(),
    data: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("content"),
    content: z.union([
      z.string(),
      z.array(AnthropicDocumentSourceContentSchema),
    ]),
  }).passthrough(),
  z.object({
    type: z.literal("url"),
    url: z.string(),
  }).passthrough(),
  z.object({
    type: z.literal("file"),
    file_id: z.string(),
  }).passthrough(),
  z.object({ type: z.string() }).passthrough(),
]);

const AnthropicCitationsConfigSchema = z.object({
  enabled: z.boolean().optional(),
}).passthrough();

const AnthropicDocumentContentSchema = z.object({
  type: z.literal("document"),
  source: AnthropicDocumentSourceSchema,
  cache_control: AnthropicCacheControlSchema.optional(),
  citations: AnthropicCitationsConfigSchema.nullable().optional(),
  context: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
}).passthrough();

const AnthropicSearchResultContentSchema = z.object({
  type: z.literal("search_result"),
  source: z.string(),
  title: z.string(),
  content: z.array(AnthropicTextContentSchema),
  cache_control: AnthropicCacheControlSchema.optional(),
  citations: AnthropicCitationsConfigSchema.optional(),
}).passthrough();

const AnthropicToolReferenceContentSchema = z.object({
  type: z.literal("tool_reference"),
  tool_name: z.string(),
  cache_control: AnthropicCacheControlSchema.optional(),
}).passthrough();

const AnthropicToolUseContentSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
  cache_control: AnthropicCacheControlSchema.optional(),
});

const AnthropicServerToolUseContentSchema = z.object({
  type: z.literal("server_tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
  caller: z.unknown().optional(),
  cache_control: AnthropicCacheControlSchema.optional(),
}).passthrough();

const AnthropicToolResultContentBlockSchema = z.discriminatedUnion("type", [
  AnthropicTextContentSchema,
  AnthropicImageContentSchema,
  AnthropicDocumentContentSchema,
  AnthropicSearchResultContentSchema,
  AnthropicToolReferenceContentSchema,
]);

const AnthropicToolResultContentSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(AnthropicToolResultContentBlockSchema)]).optional(),
  is_error: z.boolean().optional(),
  cache_control: AnthropicCacheControlSchema.optional(),
});

const AnthropicServerToolResultContentSchema = z.object({
  type: z.enum([
    "web_search_tool_result",
    "web_fetch_tool_result",
    "bash_code_execution_tool_result",
    "text_editor_code_execution_tool_result",
    "tool_search_tool_result",
    "code_execution_tool_result",
  ]),
  tool_use_id: z.string(),
  content: z.unknown(),
  caller: z.unknown().optional(),
  cache_control: AnthropicCacheControlSchema.optional(),
}).passthrough();

// Extended thinking content blocks (sent back in conversation history)
const AnthropicThinkingContentSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional(),
  cache_control: AnthropicCacheControlSchema.optional(),
});

const AnthropicRedactedThinkingContentSchema = z.object({
  type: z.literal("redacted_thinking"),
  data: z.string(),
  cache_control: AnthropicCacheControlSchema.optional(),
});

const AnthropicContentBlockSchema = z.union([
  z.discriminatedUnion("type", [
    AnthropicTextContentSchema,
    AnthropicImageContentSchema,
    AnthropicDocumentContentSchema,
    AnthropicSearchResultContentSchema,
    AnthropicToolReferenceContentSchema,
    AnthropicToolUseContentSchema,
    AnthropicServerToolUseContentSchema,
    AnthropicToolResultContentSchema,
    AnthropicServerToolResultContentSchema,
    AnthropicThinkingContentSchema,
    AnthropicRedactedThinkingContentSchema,
  ]),
  // Catch-all: forward-compatibility for new content block types (e.g. "document")
  // introduced by Claude Code updates. Translation may downgrade these to
  // safe text summaries when Codex has no native equivalent.
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
    .passthrough()
    .optional(),
  cache_control: AnthropicCacheControlSchema.nullable().optional(),
  container: z.union([z.string(), AnthropicContainerObjectSchema, z.null()]).optional(),
  context_management: z.union([AnthropicContextManagementSchema, z.null()]).optional(),
  inference_geo: z.string().nullable().optional(),
  output_config: AnthropicOutputConfigSchema.optional(),
  service_tier: z.enum(["auto", "standard_only"]).optional(),
  thinking: z
    .union([
      AnthropicThinkingEnabledSchema,
      AnthropicThinkingDisabledSchema,
      AnthropicThinkingAdaptiveSchema,
    ])
    .optional(),
  // Tool-related fields. Custom tools are converted to Codex function tools;
  // Anthropic hosted web search is converted to Codex hosted web_search.
  tools: z.array(z.union([
    z.object({
      name: z.string(),
      description: z.string().optional(),
      input_schema: z.record(z.unknown()).optional(),
    }).passthrough(),
    z.object({
      type: z.enum(["web_search_20250305", "web_search"]),
      name: z.string().optional(),
      max_uses: z.number().int().positive().optional(),
      allowed_domains: z.array(z.string()).optional(),
      blocked_domains: z.array(z.string()).optional(),
      user_location: z.record(z.unknown()).optional(),
    }).passthrough(),
    z.object({
      type: z.string(),
    }).passthrough(),
  ])).optional(),
  tool_choice: z.union([
    z.object({ type: z.literal("auto"), disable_parallel_tool_use: z.boolean().optional() }),
    z.object({ type: z.literal("any"), disable_parallel_tool_use: z.boolean().optional() }),
    z.object({ type: z.literal("none") }),
    z.object({ type: z.literal("tool"), name: z.string(), disable_parallel_tool_use: z.boolean().optional() }),
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
  inference_geo: z.string().nullable().optional(),
  mcp_servers: z.array(z.object({ type: z.string() }).passthrough()).optional(),
  output_config: AnthropicOutputConfigSchema.optional(),
  output_format: z.record(z.unknown()).optional(),
  service_tier: z.enum(["auto", "standard_only"]).optional(),
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
    z.object({ type: z.literal("auto"), disable_parallel_tool_use: z.boolean().optional() }),
    z.object({ type: z.literal("any"), disable_parallel_tool_use: z.boolean().optional() }),
    z.object({ type: z.literal("none") }),
    z.object({ type: z.literal("tool"), name: z.string(), disable_parallel_tool_use: z.boolean().optional() }),
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
