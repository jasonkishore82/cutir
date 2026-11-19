/**
 * LLM providers the chat can talk to.
 * Everything except Ollama speaks the OpenAI "chat completions" protocol, so adding another
 * OpenAI-compatible service is one entry here (or the user picks "Custom" and types a URL).
 */

export type ProviderId =
  | "ollama"
  | "lmstudio"
  | "openai"
  | "groq"
  | "openrouter"
  | "together"
  | "mistral"
  | "deepseek"
  | "xai"
  | "gemini"
  | "cerebras"
  | "fireworks"
  | "custom";

export type Provider = {
  id: ProviderId;
  name: string;
  /** "ollama" uses Ollama's native API; "openai" is any OpenAI-compatible /chat/completions API. */
  kind: "ollama" | "openai";
  baseUrl: string;
  local: boolean;
  needsKey: boolean;
  /** Where the user creates a key. */
  keyUrl?: string;
  /** Pre-selected when the provider's model list contains it. */
  defaultModel?: string;
  /** One line shown under the form. */
  note?: string;
};

export const PROVIDERS: Provider[] = [
  { id: "ollama", name: "Ollama (local)", kind: "ollama", baseUrl: "http://localhost:11434", local: true, needsKey: false, defaultModel: "qwen3:8b", note: "Runs on your computer. Start Ollama with OLLAMA_ORIGINS=* so the browser can reach it." },
  { id: "lmstudio", name: "LM Studio (local)", kind: "openai", baseUrl: "http://localhost:1234/v1", local: true, needsKey: false, note: "Start the local server in LM Studio and enable CORS in its server settings." },
  { id: "openai", name: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", local: false, needsKey: true, keyUrl: "https://platform.openai.com/api-keys", defaultModel: "gpt-4o-mini" },
  { id: "groq", name: "Groq", kind: "openai", baseUrl: "https://api.groq.com/openai/v1", local: false, needsKey: true, keyUrl: "https://console.groq.com/keys", defaultModel: "llama-3.3-70b-versatile" },
  { id: "openrouter", name: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", local: false, needsKey: true, keyUrl: "https://openrouter.ai/keys", defaultModel: "openai/gpt-4o-mini", note: "One key for hundreds of models. Model names look like vendor/model." },
  { id: "together", name: "Together AI", kind: "openai", baseUrl: "https://api.together.xyz/v1", local: false, needsKey: true, keyUrl: "https://api.together.ai/settings/api-keys", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  { id: "mistral", name: "Mistral", kind: "openai", baseUrl: "https://api.mistral.ai/v1", local: false, needsKey: true, keyUrl: "https://console.mistral.ai/api-keys", defaultModel: "mistral-small-latest" },
  { id: "deepseek", name: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com/v1", local: false, needsKey: true, keyUrl: "https://platform.deepseek.com/api_keys", defaultModel: "deepseek-chat" },
  { id: "xai", name: "xAI (Grok)", kind: "openai", baseUrl: "https://api.x.ai/v1", local: false, needsKey: true, keyUrl: "https://console.x.ai", defaultModel: "grok-3-mini" },
  { id: "gemini", name: "Google Gemini", kind: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", local: false, needsKey: true, keyUrl: "https://aistudio.google.com/apikey", defaultModel: "gemini-2.0-flash", note: "Uses Google's OpenAI-compatible endpoint." },
  { id: "cerebras", name: "Cerebras", kind: "openai", baseUrl: "https://api.cerebras.ai/v1", local: false, needsKey: true, keyUrl: "https://cloud.cerebras.ai", defaultModel: "llama-3.3-70b" },
  { id: "fireworks", name: "Fireworks AI", kind: "openai", baseUrl: "https://api.fireworks.ai/inference/v1", local: false, needsKey: true, keyUrl: "https://fireworks.ai/account/api-keys", defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct" },
  { id: "custom", name: "Custom (OpenAI-compatible)", kind: "openai", baseUrl: "", local: false, needsKey: false, note: "Any server with an OpenAI-style /chat/completions endpoint. Enter its base URL, usually ending in /v1." },
];

export const providerById = (id: string): Provider => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
