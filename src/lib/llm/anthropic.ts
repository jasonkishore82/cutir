import Anthropic from "@anthropic-ai/sdk";
import { OllamaError, type ChatMessage, type RawOllamaCall, type StreamChunk } from "../ollama";

/**
 * Client for Anthropic's Messages API (Claude), through the official SDK.
 * The key is the user's own and requests go straight from this browser to Anthropic, like the other cloud providers.
 */

const DEFAULT_BASE = "https://api.anthropic.com";

function client(baseUrl: string, apiKey: string): Anthropic {
  const base = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  return new Anthropic({
    apiKey: apiKey.trim(),
    baseURL: base || DEFAULT_BASE,
    dangerouslyAllowBrowser: true, // the user's own key, used in their own browser; nothing is served to anyone else
    maxRetries: 1,
  });
}

/** SDK errors -> the app's error type, with short readable messages. */
function translate(e: unknown): Error {
  if (e instanceof Anthropic.APIUserAbortError) return new DOMException("Aborted", "AbortError");
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
    return new OllamaError(`Anthropic rejected the API key: ${e.message} Check it in Settings.`, "http");
  if (e instanceof Anthropic.RateLimitError) return new OllamaError(`Rate limit or quota reached: ${e.message}`, "http");
  if (e instanceof Anthropic.NotFoundError) return new OllamaError(`Not found (check the model name): ${e.message}`, "http");
  if (e instanceof Anthropic.APIConnectionError) return new OllamaError("Could not reach Anthropic. Check the base URL and your connection.", "connection");
  if (e instanceof Anthropic.APIError) return new OllamaError(`${e.message}${e.status ? ` (HTTP ${e.status})` : ""}`, "http");
  return e instanceof Error ? e : new Error(String(e));
}

/** Model ids, newest first (the order the API returns them). */
export async function listAnthropicModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const ids: string[] = [];
    for await (const m of client(baseUrl, apiKey).models.list({ limit: 100 }, { signal })) ids.push(m.id);
    return ids;
  } catch (e) {
    throw translate(e);
  }
}

const mimeOf = (b64: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" =>
  b64.startsWith("/9j/") ? "image/jpeg" : b64.startsWith("R0lGOD") ? "image/gif" : b64.startsWith("UklGR") ? "image/webp" : "image/png";

/** System messages go to the top-level `system`; the conversation must start with a user turn. */
function toAnthropic(messages: ChatMessage[]): { system: string; messages: Anthropic.Beta.BetaMessageParam[] } {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const turns = messages.filter((m) => m.role !== "system");
  while (turns.length && turns[0].role !== "user") turns.shift();
  return {
    system,
    messages: turns.map((m) =>
      m.images?.length && m.role === "user"
        ? {
            role: "user" as const,
            content: [
              ...m.images.map((data) => ({ type: "image" as const, source: { type: "base64" as const, media_type: mimeOf(data), data } })),
              { type: "text" as const, text: m.content || "(image)" },
            ],
          }
        : { role: m.role as "user" | "assistant", content: m.content || "OK." }
    ),
  };
}

type OpenAITool = { function?: { name?: string; description?: string; parameters?: unknown } };

/** The app's tools are in OpenAI/Ollama format: {type:"function", function:{name, description, parameters}}. */
function toAnthropicTools(tools: unknown[]): Anthropic.Beta.BetaTool[] {
  return (tools as OpenAITool[])
    .filter((t) => t.function?.name)
    .map((t) => ({
      name: t.function!.name!,
      description: t.function!.description ?? "",
      input_schema: (t.function!.parameters ?? { type: "object", properties: {} }) as Anthropic.Beta.BetaTool.InputSchema,
      eager_input_streaming: true,
    }));
}

/** Models that accept the server-side refusal fallback (another model finishes the reply if this one declines). */
const FALLBACK_MODELS = /^claude-(fable-5-2|fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

/** Streams one reply; yields the same StreamChunk shape as the Ollama and OpenAI clients. */
export async function* streamAnthropicChat(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  signal?: AbortSignal;
}): AsyncGenerator<StreamChunk> {
  const { system, messages } = toAnthropic(opts.messages);
  const params: Anthropic.Beta.MessageCreateParamsStreaming = {
    model: opts.model,
    max_tokens: 64000,
    messages,
    stream: true,
  };
  if (system) params.system = system;
  if (opts.tools?.length) params.tools = toAnthropicTools(opts.tools);
  if (FALLBACK_MODELS.test(opts.model)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }

  let final: Anthropic.Beta.BetaMessage;
  try {
    const stream = client(opts.baseUrl, opts.apiKey).beta.messages.stream(params, { signal: opts.signal });
    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") yield { content: event.delta.text };
        else if (event.delta.type === "thinking_delta") yield { thinking: event.delta.thinking };
      } else if (event.type === "message_delta") {
        yield { evalCount: event.usage.output_tokens };
      }
    }
    final = await stream.finalMessage();
  } catch (e) {
    throw translate(e);
  }

  if (final.stop_reason === "refusal") {
    yield { content: "\n\nClaude declined this request.", done: true };
    return;
  }
  // a reply cut off by max_tokens can hold a half-written tool call: don't run it
  const toolCalls: RawOllamaCall[] =
    final.stop_reason === "max_tokens"
      ? []
      : final.content.filter((b) => b.type === "tool_use").map((b) => ({ function: { name: b.name, arguments: b.input } }));
  yield { toolCalls: toolCalls.length ? toolCalls : undefined, done: true, evalCount: final.usage.output_tokens };
}
