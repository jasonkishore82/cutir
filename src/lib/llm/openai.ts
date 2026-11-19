import { OllamaError, type ChatMessage, type RawOllamaCall, type StreamChunk } from "../ollama";

/** Client for OpenAI-compatible APIs (OpenAI, Groq, OpenRouter, Together, Mistral, LM Studio, ...). */

const trimUrl = (u: string) => u.trim().replace(/\/+$/, "");

const NO_TOOLS = /(does not|doesn'?t|do not|not) support.{0,40}tool|tool.{0,40}(not supported|unsupported)|support tool use|tools? (is|are) not (enabled|available)|function calling.{0,30}not (supported|enabled)/i;

const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

function headers(apiKey: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey.trim()) h.Authorization = `Bearer ${apiKey.trim()}`;
  return h;
}

async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new OllamaError(
      `Could not reach ${hostOf(url)}. Check the base URL and your connection. Some providers block requests made directly from a browser (CORS); OpenRouter and Groq allow them.`,
      "connection"
    );
  }
}

/** Turn an error response into a short, readable message. */
async function failure(res: Response): Promise<OllamaError> {
  let detail = "";
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      const e = j?.error;
      detail = (typeof e === "string" ? e : e?.message ?? j?.message ?? "") || "";
      if (!detail && Array.isArray(j) && j[0]?.error?.message) detail = j[0].error.message; // Gemini wraps errors in an array
    } catch {
      detail = text.slice(0, 200);
    }
  } catch {
    /* no body */
  }
  if (NO_TOOLS.test(detail)) return new OllamaError(detail, "no-tools");
  if (res.status === 401 || res.status === 403) return new OllamaError(`The provider rejected the API key${detail ? `: ${detail}` : "."} Check it in Settings.`, "http");
  if (res.status === 429) return new OllamaError(`Rate limit or quota reached${detail ? `: ${detail}` : "."}`, "http");
  return new OllamaError(detail ? `${detail} (HTTP ${res.status})` : `The provider answered HTTP ${res.status}.`, "http");
}

/** GET {base}/models -> model ids. Gemini prefixes ids with "models/"; chat wants them without. */
export async function listOpenAIModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const res = await request(`${trimUrl(baseUrl)}/models`, { headers: headers(apiKey), signal });
  if (!res.ok) throw await failure(res);
  const j = (await res.json()) as { data?: { id?: string }[]; models?: { id?: string; name?: string }[] };
  const raw = j.data ?? j.models ?? [];
  const ids = raw.map((m) => ("id" in m && m.id ? m.id : "name" in m && m.name ? m.name : "")).filter(Boolean) as string[];
  return [...new Set(ids.map((id) => id.replace(/^models\//, "")))].sort();
}

/** Models that cannot do chat completions (embeddings, speech, image generation...). */
export const NON_CHAT = /embed|whisper|tts|dall-e|moderation|davinci|babbage|transcribe|realtime|audio|rerank|guard|image-gen|stable-diffusion|flux/i;

const mimeOf = (b64: string) =>
  b64.startsWith("/9j/") ? "image/jpeg" : b64.startsWith("iVBOR") ? "image/png" : b64.startsWith("R0lGOD") ? "image/gif" : b64.startsWith("UklGR") ? "image/webp" : "image/png";

function toOpenAIMessages(messages: ChatMessage[]) {
  return messages.map((m) =>
    m.images?.length
      ? {
          role: m.role,
          content: [
            { type: "text", text: m.content },
            ...m.images.map((b64) => ({ type: "image_url", image_url: { url: `data:${mimeOf(b64)};base64,${b64}` } })),
          ],
        }
      : { role: m.role, content: m.content }
  );
}

/** POST {base}/chat/completions with stream:true; yields the same StreamChunk shape as the Ollama client. */
export async function* streamOpenAIChat(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  signal?: AbortSignal;
}): AsyncGenerator<StreamChunk> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: toOpenAIMessages(opts.messages),
    stream: true,
    temperature: 0.2,
  };
  if (opts.tools?.length) body.tools = opts.tools;

  const res = await request(`${trimUrl(opts.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: headers(opts.apiKey),
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) throw await failure(res);
  if (!res.body) throw new OllamaError("The provider sent an empty response.", "http");

  // tool calls arrive in fragments: id/name first, then the JSON arguments in pieces, keyed by index
  const calls = new Map<number, { name: string; args: string }>();
  const flushCalls = (): RawOllamaCall[] =>
    [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, c]) => c.name)
      .map(([, c]) => {
        let args: unknown = {};
        if (c.args.trim()) {
          try {
            args = JSON.parse(c.args);
          } catch {
            args = c.args; // applyCalls tries to repair string arguments and reports bad ones
          }
        }
        return { function: { name: c.name, arguments: args } };
      });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let finished = false;

  const parse = (line: string): StreamChunk | null => {
    const t = line.trim();
    if (!t.startsWith("data:")) return null;
    const data = t.slice(5).trim();
    if (!data) return null;
    if (data === "[DONE]") {
      finished = true;
      return null;
    }
    const j = JSON.parse(data);
    if (j.error) {
      const msg = typeof j.error === "string" ? j.error : j.error.message ?? "The provider returned an error.";
      throw new OllamaError(msg, NO_TOOLS.test(msg) ? "no-tools" : "http");
    }
    const choice = j.choices?.[0];
    const delta = choice?.delta;
    for (const tc of delta?.tool_calls ?? []) {
      const i = typeof tc.index === "number" ? tc.index : 0;
      const cur = calls.get(i) ?? { name: "", args: "" };
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      calls.set(i, cur);
    }
    const content: string | undefined = typeof delta?.content === "string" ? delta.content : undefined;
    const thinking: string | undefined = delta?.reasoning_content ?? delta?.reasoning ?? undefined;
    if (choice?.finish_reason) finished = true;
    const evalCount: number | undefined = j.usage?.completion_tokens;
    if (!content && !thinking && !delta?.tool_calls && evalCount === undefined) return null;
    return { content, thinking, evalCount };
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const chunk = parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (chunk) yield chunk;
    }
  }
  const last = parse(buf);
  if (last) yield last;
  void finished;
  const toolCalls = flushCalls();
  yield { toolCalls: toolCalls.length ? toolCalls : undefined, done: true };
}
