export const DEFAULT_OLLAMA_URL = "http://localhost:11434";

export const CONNECTION_HELP =
  "Could not reach Ollama. Start Ollama with OLLAMA_ORIGINS=* (or your dev URL) so the browser can reach it.";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string; images?: string[] };
export type RawOllamaCall = { function?: { name?: string; arguments?: unknown } };

export class OllamaError extends Error {
  constructor(message: string, public kind: "connection" | "http" | "no-tools") {
    super(message);
  }
}

export const normalizeUrl = (u: string) => u.trim().replace(/\/+$/, "") || DEFAULT_OLLAMA_URL;

async function request(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new OllamaError(CONNECTION_HELP, "connection");
  }
}

export async function listModels(baseUrl: string, signal?: AbortSignal): Promise<string[]> {
  const res = await request(`${normalizeUrl(baseUrl)}/api/tags`, { signal });
  if (!res.ok) throw new OllamaError(`Ollama answered ${res.status} on /api/tags`, "http");
  const data = (await res.json()) as { models?: { name: string }[] };
  return (data.models ?? []).map((m) => m.name).sort();
}

export type ModelInfo = { name: string; capabilities?: string[] };

/**
 * Installed models with their capabilities (completion, tools, vision, embedding...) from /api/show.
 * Capabilities are missing on older Ollama versions; callers must cope with `undefined`.
 */
export async function listModelInfo(baseUrl: string, signal?: AbortSignal): Promise<ModelInfo[]> {
  const names = await listModels(baseUrl, signal);
  return Promise.all(
    names.map(async (name): Promise<ModelInfo> => {
      try {
        const res = await fetch(`${normalizeUrl(baseUrl)}/api/show`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: name }),
          signal,
        });
        if (!res.ok) return { name };
        const j = await res.json();
        return { name, capabilities: Array.isArray(j.capabilities) ? (j.capabilities as string[]) : undefined };
      } catch {
        return { name };
      }
    })
  );
}

export type StreamChunk = { content?: string; thinking?: string; toolCalls?: RawOllamaCall[]; done?: boolean; evalCount?: number };

/** POST /api/chat with stream:true; yields parsed NDJSON chunks. */
export async function* streamChat(opts: {
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  signal?: AbortSignal;
}): AsyncGenerator<StreamChunk> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    options: { temperature: 0.2 },
  };
  if (opts.tools) body.tools = opts.tools;
  if (/qwen3/i.test(opts.model)) body.think = false; // skip slow reasoning for quick edits

  const res = await request(`${normalizeUrl(opts.baseUrl)}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    let msg = `Ollama answered ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = String(j.error);
    } catch {
      /* keep default message */
    }
    if (/does not support tools/i.test(msg)) throw new OllamaError(msg, "no-tools");
    throw new OllamaError(msg, "http");
  }
  if (!res.body) throw new OllamaError("Ollama sent an empty response", "http");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const parse = (line: string): StreamChunk | null => {
    if (!line.trim()) return null;
    const j = JSON.parse(line);
    if (j.error) throw new OllamaError(String(j.error), /does not support tools/i.test(j.error) ? "no-tools" : "http");
    return { content: j.message?.content, thinking: j.message?.thinking, toolCalls: j.message?.tool_calls, done: j.done, evalCount: j.eval_count };
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
}

/** Hide <think>…</think> reasoning (including an unfinished block while streaming). */
export function stripThink(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "").trim();
}
