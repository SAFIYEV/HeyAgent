export type AuthType = "api_key" | "oauth" | "none";

/** Mirrors OpenClaw model.compat for OpenAI-completions transport. */
export type MaxTokensField = "max_completion_tokens" | "max_tokens";

export interface ModelCompat {
  maxTokensField?: MaxTokensField;
  /** Explicit input modalities. Omitted models are treated conservatively. */
  inputModalities?: Array<"text" | "image">;
}

export interface ModelEntry {
  id: string;
  compat?: ModelCompat;
}

export interface ModelProvider {
  id: string;
  name: string;
  authType: AuthType;
  baseUrl?: string;
  /** OpenClaw-style: openai-completions | anthropic-messages */
  api?: "openai-completions" | "anthropic-messages";
  models: ModelEntry[];
  envKey?: string;
  /** Provider-level default compat (OpenClaw detectOpenAICompletionsCompat). */
  compat?: ModelCompat;
}

export interface ModelRef {
  provider: string;
  model: string;
}

export interface ChatImage {
  mimeType: string;
  /** Raw base64 without data: prefix */
  data: string;
  detail?: "low" | "high" | "auto";
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    /** Provider-specific opaque metadata that must round-trip unchanged. */
    providerData?: { google?: { thoughtSignature?: string } };
  }[];
  /** Multimodal images for vision models (screen.see) */
  images?: ChatImage[];
}

export function modelSupportsImages(ref: ModelRef): boolean {
  const explicit = getModelEntry(ref.provider, ref.model)?.compat?.inputModalities;
  if (explicit) return explicit.includes("image");
  const model = ref.model.toLowerCase();
  if (ref.provider === "anthropic" || /^anthropic\./.test(model)) return true;
  if (ref.provider === "google" && /gemini/.test(model)) return true;
  if (ref.provider === "openai" && /^(gpt-4o|gpt-4\.1)/.test(model)) return true;
  if (ref.provider === "openrouter" && /(gpt-4o|gpt-4\.1|claude-3|claude-sonnet-4)/.test(model)) {
    return true;
  }
  return false;
}

/**
 * Preserve text/tool history but remove binary image parts for text-only
 * candidates. This is applied independently for every failover candidate.
 */
export function adaptMessagesForModel(ref: ModelRef, messages: ChatMessage[]): ChatMessage[] {
  if (modelSupportsImages(ref)) return messages;
  return messages.map((message) => {
    if (!message.images?.length) return message;
    return {
      ...message,
      content: [
        message.content,
        `[${message.images.length} screen image(s) omitted: ${ref.provider}/${ref.model} accepts text input only. Use accessibility/DOM/tool evidence.]`,
      ].filter(Boolean).join("\n"),
      images: undefined,
    };
  });
}

export interface ChatResponse {
  content: string;
  model: string;
  provider: string;
  usage?: { promptTokens: number; completionTokens: number };
}

/**
 * OpenClaw defaults (packages/ai/.../openai-completions-compat.ts):
 * - default openai-compatible → max_completion_tokens
 * - mistral / zai / together / chutes → max_tokens
 * - ollama/local and many proxies still accept max_tokens; we keep OpenClaw default
 *   and only force max_tokens for the known families below.
 */
const MAX_TOKENS_PROVIDERS = new Set([
  "mistral",
  "zai",
  "together",
  "chutes",
  "groq",
  "bedrock",
  "google",
]);

export function resolveMaxTokensField(
  providerId: string,
  _modelId: string,
  providerCompat?: ModelCompat,
  modelCompat?: ModelCompat,
): MaxTokensField {
  if (modelCompat?.maxTokensField) return modelCompat.maxTokensField;
  if (providerCompat?.maxTokensField) return providerCompat.maxTokensField;
  if (MAX_TOKENS_PROVIDERS.has(providerId)) return "max_tokens";
  // OpenClaw default for openai-public / openai-completions
  return "max_completion_tokens";
}

export const PROVIDERS: ModelProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    authType: "api_key",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    compat: { maxTokensField: "max_completion_tokens" },
    models: [
      { id: "o3", compat: { maxTokensField: "max_completion_tokens" } },
      { id: "o3-mini", compat: { maxTokensField: "max_completion_tokens" } },
      { id: "gpt-4o", compat: { maxTokensField: "max_completion_tokens" } },
      { id: "gpt-4o-mini", compat: { maxTokensField: "max_completion_tokens" } },
      { id: "gpt-4.1", compat: { maxTokensField: "max_completion_tokens" } },
      { id: "gpt-4.1-mini", compat: { maxTokensField: "max_completion_tokens" } },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    authType: "api_key",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    envKey: "ANTHROPIC_API_KEY",
    models: [
      { id: "claude-opus-4-6" },
      { id: "claude-sonnet-4-6" },
      { id: "claude-opus-4-5-20251101" },
      { id: "claude-sonnet-4-5-20250929" },
      { id: "claude-haiku-4-5-20251001" },
      { id: "claude-sonnet-4-20250514" },
      { id: "claude-3-5-haiku-20241022" },
    ],
  },
  {
    id: "google",
    name: "Google",
    authType: "api_key",
    api: "openai-completions",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GOOGLE_API_KEY",
    compat: { maxTokensField: "max_tokens" },
    models: [{ id: "gemini-2.0-flash" }, { id: "gemini-2.5-pro-preview" }],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    authType: "api_key",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com/v1",
    envKey: "DEEPSEEK_API_KEY",
    compat: { maxTokensField: "max_completion_tokens" },
    models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    authType: "api_key",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    compat: { maxTokensField: "max_completion_tokens" },
    models: [{ id: "openai/gpt-4.1" }, { id: "anthropic/claude-sonnet-4" }],
  },
  {
    id: "deepinfra",
    name: "DeepInfra",
    authType: "api_key",
    api: "openai-completions",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    envKey: "DEEPINFRA_API_KEY",
    compat: { maxTokensField: "max_completion_tokens" },
    models: [
      { id: "meta-llama/Llama-3.3-70B-Instruct" },
      { id: "Qwen/Qwen2.5-72B-Instruct" },
    ],
  },
  {
    id: "novita",
    name: "Novita AI",
    authType: "api_key",
    api: "openai-completions",
    baseUrl: "https://api.novita.ai/openai/v1",
    envKey: "NOVITA_API_KEY",
    compat: { maxTokensField: "max_tokens" },
    models: [{ id: "deepseek/deepseek-v4-pro" }],
  },
  {
    id: "groq",
    name: "Groq",
    authType: "api_key",
    api: "openai-completions",
    baseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    compat: { maxTokensField: "max_tokens" },
    models: [
      { id: "llama-3.3-70b-versatile", compat: { maxTokensField: "max_tokens" } },
      { id: "llama-3.1-8b-instant", compat: { maxTokensField: "max_tokens" } },
      { id: "openai/gpt-oss-120b", compat: { maxTokensField: "max_tokens" } },
      { id: "openai/gpt-oss-20b", compat: { maxTokensField: "max_tokens" } },
      { id: "qwen/qwen3-32b", compat: { maxTokensField: "max_tokens" } },
      { id: "meta-llama/llama-4-scout-17b-16e-instruct", compat: { maxTokensField: "max_tokens" } },
      { id: "moonshotai/kimi-k2-instruct", compat: { maxTokensField: "max_tokens" } },
    ],
  },
  {
    id: "mistral",
    name: "Mistral",
    authType: "api_key",
    api: "openai-completions",
    baseUrl: "https://api.mistral.ai/v1",
    envKey: "MISTRAL_API_KEY",
    compat: { maxTokensField: "max_tokens" },
    models: [{ id: "mistral-large-latest" }, { id: "mistral-small-latest" }],
  },
  {
    id: "ollama",
    name: "Ollama (Local)",
    authType: "none",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:11434/v1",
    // local endpoints: OpenClaw still defaults to max_completion_tokens for openai-completions;
    // Ollama accepts both; keep OpenClaw default for parity.
    compat: { maxTokensField: "max_completion_tokens" },
    models: [{ id: "llama3.2" }, { id: "qwen2.5" }, { id: "mistral" }],
  },
   {
     id: "bedrock",
     name: "AWS Bedrock",
     authType: "api_key",
     api: "openai-completions",
     // OpenAI-compatible Mantle endpoint; region overridden via credentials.baseUrl / AWS_REGION
     baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
     envKey: "AWS_BEARER_TOKEN_BEDROCK",
     compat: { maxTokensField: "max_tokens" },
     // Available Mantle models (verified via /v1/models API and /v1/chat/completions)
     // NOTE: Anthropic Claude models require /anthropic/v1/messages endpoint (auto-detected in index.ts)
     models: [
       // Anthropic Claude (auto-routed to /anthropic/v1/messages by index.ts)
       { id: "anthropic.claude-opus-5", compat: { maxTokensField: "max_tokens" } },
       { id: "anthropic.claude-opus-4-8", compat: { maxTokensField: "max_tokens" } },
       { id: "anthropic.claude-opus-4-7", compat: { maxTokensField: "max_tokens" } },
       { id: "anthropic.claude-sonnet-5", compat: { maxTokensField: "max_tokens" } },
       { id: "anthropic.claude-haiku-4-5", compat: { maxTokensField: "max_tokens" } },
       { id: "anthropic.claude-fable-5", compat: { maxTokensField: "max_tokens" } },
       // OpenAI (via /v1/chat/completions - Bedrock Mantle routing)
       { id: "openai.gpt-5.6-sol", compat: { maxTokensField: "max_tokens" } },
       { id: "openai.gpt-5.6-terra", compat: { maxTokensField: "max_tokens" } },
       { id: "openai.gpt-5.6-luna", compat: { maxTokensField: "max_tokens" } },
       { id: "openai.gpt-5.5", compat: { maxTokensField: "max_tokens" } },
       { id: "openai.gpt-5.5-2026-04-23", compat: { maxTokensField: "max_tokens" } },
       { id: "openai.gpt-5.4", compat: { maxTokensField: "max_tokens" } },
       { id: "openai.gpt-5.4-2026-03-05", compat: { maxTokensField: "max_tokens" } },
       // DeepSeek (works with /v1/chat/completions)
       { id: "deepseek.v3.2", compat: { maxTokensField: "max_tokens" } },
       { id: "deepseek.v3.1", compat: { maxTokensField: "max_tokens" } },
       // Google Gemma (works with /v1/chat/completions)
       { id: "google.gemma-4-31b", compat: { maxTokensField: "max_tokens" } },
       { id: "google.gemma-3-27b-it", compat: { maxTokensField: "max_tokens" } },
       { id: "google.gemma-3-12b-it", compat: { maxTokensField: "max_tokens" } },
       { id: "google.gemma-3-4b-it", compat: { maxTokensField: "max_tokens" } },
       // Mistral
       { id: "mistral.mistral-large-3-675b-instruct", compat: { maxTokensField: "max_tokens" } },
       // Qwen
       { id: "qwen.qwen3-32b", compat: { maxTokensField: "max_tokens" } },
     ],
   },
  {
    id: "custom",
    name: "Custom OpenAI-compatible",
    authType: "api_key",
    api: "openai-completions",
    envKey: "CUSTOM_API_KEY",
    compat: { maxTokensField: "max_tokens" },
    models: [{ id: "default" }],
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs (TTS replies)",
    authType: "api_key",
    api: "openai-completions",
    envKey: "ELEVENLABS_API_KEY",
    models: [{ id: "eleven_multilingual_v2" }],
  },
];

export function getProvider(id: string): ModelProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function getModelEntry(providerId: string, modelId: string): ModelEntry | undefined {
  return getProvider(providerId)?.models.find((m) => m.id === modelId);
}

export function listModelIds(provider: ModelProvider): string[] {
  return provider.models.map((m) => m.id);
}

export function parseModelRef(ref: string): ModelRef {
  const slash = ref.indexOf("/");
  if (slash === -1) {
    return { provider: "openai", model: ref };
  }
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

/**
 * Friendly shortcuts → provider/model (Bedrock Mantle Chat Completions IDs).
 * Examples: fable5, opus5, opus4.8, sonnet5, haiku45, gpt5.6
 */
const MODEL_ALIASES: Record<string, string> = {
  // Anthropic via Bedrock (available)
  opus5: "bedrock/anthropic.claude-opus-5",
  "opus-5": "bedrock/anthropic.claude-opus-5",
  opus48: "bedrock/anthropic.claude-opus-4-8",
  "opus-4.8": "bedrock/anthropic.claude-opus-4-8",
  "claude-opus-4-8": "bedrock/anthropic.claude-opus-4-8",
  opus47: "bedrock/anthropic.claude-opus-4-7",
  "opus-4.7": "bedrock/anthropic.claude-opus-4-7",
  sonnet5: "bedrock/anthropic.claude-sonnet-5",
  "sonnet-5": "bedrock/anthropic.claude-sonnet-5",
  haiku45: "bedrock/anthropic.claude-haiku-4-5",
  haiku: "bedrock/anthropic.claude-haiku-4-5",
  fable5: "bedrock/anthropic.claude-fable-5",

  // OpenAI via Bedrock
  gpt56sol: "bedrock/openai.gpt-5.6-sol",
  "gpt-5.6-sol": "bedrock/openai.gpt-5.6-sol",
  gpt56terra: "bedrock/openai.gpt-5.6-terra",
  "gpt-5.6-terra": "bedrock/openai.gpt-5.6-terra",
  gpt56luna: "bedrock/openai.gpt-5.6-luna",
  "gpt-5.6-luna": "bedrock/openai.gpt-5.6-luna",
  gpt55: "bedrock/openai.gpt-5.5",
  "gpt-5.5": "bedrock/openai.gpt-5.5",
  gpt54: "bedrock/openai.gpt-5.4",
  "gpt-5.4": "bedrock/openai.gpt-5.4",

  // DeepSeek via Bedrock
  deepseekv3: "bedrock/deepseek.v3.2",
  "deepseek-v3": "bedrock/deepseek.v3.2",

  // Direct OpenAI
  "gpt-4.1": "openai/gpt-4.1",
  gpt41: "openai/gpt-4.1",
  "gpt-4o": "openai/gpt-4o",
  gpt4o: "openai/gpt-4o",
  o3: "openai/o3",
  "o3-mini": "openai/o3-mini",
};

/** Resolve alias or full provider/model string. */
export function resolveModelRef(input: string): ModelRef {
  const raw = input.trim();
  const aliasKey = raw.toLowerCase().replace(/\s+/g, "");
  const mapped = MODEL_ALIASES[aliasKey] || MODEL_ALIASES[raw.toLowerCase()];
  return parseModelRef(mapped || raw);
}

export function listModelAliases(): string[] {
  return Object.keys(MODEL_ALIASES).sort();
}

/** AWS Marketplace product IDs — user must Accept offer in console (agent cannot). */
export const BEDROCK_MARKETPLACE_OFFERS: {
  name: string;
  productId: string;
  modelHint: string;
}[] = [
  { name: "Claude Fable 5", productId: "prod-h6swdfybvty7y", modelHint: "bedrock/anthropic.claude-fable-5" },
  { name: "Claude Opus 5", productId: "prod-if5d653ow7ehg", modelHint: "bedrock/anthropic.claude-opus-5" },
  { name: "Claude Opus 4.8", productId: "prod-bk5rjg4eo2pke", modelHint: "bedrock/anthropic.claude-opus-4-8" },
  { name: "Claude Sonnet 5", productId: "prod-4ezhkeia6k2cs", modelHint: "bedrock/anthropic.claude-sonnet-5" },
  { name: "Claude Opus 4.5", productId: "prod-jhuafngbly644", modelHint: "bedrock/anthropic.claude-opus-4-5" },
  { name: "Claude Sonnet 4.5", productId: "prod-mxcfnwvpd6kb4", modelHint: "bedrock/anthropic.claude-sonnet-4-5" },
  { name: "Claude Haiku 4.5", productId: "prod-xdkflymybwmvi", modelHint: "bedrock/anthropic.claude-haiku-4-5" },
];

export function bedrockMarketplaceUrl(productId: string): string {
  return `https://aws.amazon.com/marketplace/pp?sku=${productId}`;
}
