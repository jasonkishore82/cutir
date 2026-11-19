import { listModelInfo, normalizeUrl, streamChat as streamOllama, type ChatMessage, type StreamChunk } from "../ollama";
import { NON_CHAT, listOpenAIModels, streamOpenAIChat } from "./openai";
import type { Provider } from "./providers";

/** The connection settings of the active provider. */
export type LlmConfig = { provider: Provider; baseUrl: string; apiKey: string; model: string };

export type ModelList = { models: string[]; noToolModels: string[]; hidden: number };

/** Chat-capable models of a provider. Ollama also reports which of them cannot call tools. */
export async function listChatModels(cfg: LlmConfig, signal?: AbortSignal): Promise<ModelList> {
  if (cfg.provider.kind === "ollama") {
    const infos = await listModelInfo(cfg.baseUrl, signal);
    // embedding-only models cannot chat; without capability info fall back to their names
    const chat = infos.filter((i) => (i.capabilities ? i.capabilities.includes("completion") : !/embed|bge-|nomic/i.test(i.name)));
    return {
      models: chat.map((i) => i.name),
      noToolModels: chat.filter((i) => i.capabilities && !i.capabilities.includes("tools")).map((i) => i.name),
      hidden: infos.length - chat.length,
    };
  }
  const all = await listOpenAIModels(cfg.baseUrl, cfg.apiKey, signal);
  const models = all.filter((m) => !NON_CHAT.test(m));
  return { models, noToolModels: [], hidden: all.length - models.length };
}

export function streamChat(
  cfg: LlmConfig,
  opts: { messages: ChatMessage[]; tools?: unknown[]; signal?: AbortSignal }
): AsyncGenerator<StreamChunk> {
  return cfg.provider.kind === "ollama"
    ? streamOllama({ baseUrl: normalizeUrl(cfg.baseUrl), model: cfg.model, ...opts })
    : streamOpenAIChat({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, ...opts });
}

/** Why a provider cannot be used yet, or "" when it is ready. */
export function configProblem(cfg: LlmConfig): string {
  if (!cfg.baseUrl.trim()) return "Enter the provider's base URL in Settings.";
  if (cfg.provider.needsKey && !cfg.apiKey.trim()) return `Add your ${cfg.provider.name} API key in Settings (Settings menu, AI models).`;
  return "";
}
