import { Icon } from "./ui";
import { useEffect, useRef, useState } from "react";
import { PROVIDERS, providerById } from "../lib/llm/providers";
import { configProblem, listChatModels } from "../lib/llm";
import { OllamaError } from "../lib/ollama";
import { configFor, useSettings } from "../store/settings";

type Test = { state: "idle" | "checking" | "ok" | "warn" | "error"; text: string };

const CUSTOM = "__custom__";

/** Pick the AI provider, enter its API key and choose a model. Changes apply immediately. */
export default function SettingsDialog() {
  const open = useSettings((s) => s.dialogOpen);
  const provider = providerById(useSettings((s) => s.provider));
  const byProvider = useSettings((s) => s.byProvider);
  const rememberKeys = useSettings((s) => s.rememberKeys);
  const { setProvider, patch, setRememberKeys, closeDialog } = useSettings.getState();

  const cfg = configFor({ byProvider }, provider.id);
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [customModel, setCustomModel] = useState(false);
  const [test, setTest] = useState<Test>({ state: "idle", text: "" });
  const abortRef = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const runTest = async () => {
    abortRef.current?.abort();
    const problem = configProblem(cfg);
    if (problem) {
      setModels([]);
      setTest({ state: "warn", text: problem });
      return;
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setTest({ state: "checking", text: "Connecting" });
    try {
      const list = await listChatModels(cfg, ac.signal);
      if (ac.signal.aborted) return;
      setModels(list.models);
      setTest({ state: "ok", text: list.models.length ? `Connected, ${list.models.length} models` : "Connected, but no chat models were listed. Type a model name." });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setModels([]);
      setTest({ state: "error", text: e instanceof OllamaError ? e.message : (e as Error).message });
    }
  };

  // re-check shortly after the provider, URL or key changes
  useEffect(() => {
    if (!open) return;
    setModels([]);
    setCustomModel(false);
    const t = setTimeout(runTest, 500);
    return () => {
      clearTimeout(t);
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, provider.id, cfg.baseUrl, cfg.apiKey]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>("select, input")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeDialog();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeDialog]);

  if (!open) return null;

  const modelInList = !cfg.model || models.includes(cfg.model);
  const showSelect = models.length > 0 && !customModel && modelInList;
  const local = PROVIDERS.filter((p) => p.local);
  const cloud = PROVIDERS.filter((p) => !p.local);
  const label = "mb-1 block text-[11px] uppercase tracking-wide text-gray-500";
  const toneClass = { idle: "text-gray-500", checking: "text-gray-400", ok: "text-green-400", warn: "text-yellow-400", error: "text-red-400" }[test.state];

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && closeDialog()}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="AI models and API keys"
        className="max-h-[92vh] w-[520px] max-w-full overflow-y-auto rounded-2xl border border-white/10 bg-panel shadow-2xl shadow-black/60"
      >
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 className="text-sm font-medium text-gray-100">AI models &amp; API keys</h2>
          <button onClick={closeDialog} aria-label="Close" className="h-6 w-6 rounded text-lg leading-none text-gray-400 hover:bg-edge hover:text-gray-100">
            <Icon name="close" className="mx-auto h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-4">
          <div>
            <label className={label} htmlFor="llm-provider">Provider</label>
            <select id="llm-provider" className="field" value={provider.id} onChange={(e) => setProvider(e.target.value as typeof provider.id)}>
              <optgroup label="Runs on your computer">
                {local.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </optgroup>
              <optgroup label="Cloud (needs an API key)">
                {cloud.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </optgroup>
            </select>
            {provider.note && <p className="mt-1.5 text-[11px] text-gray-500">{provider.note}</p>}
          </div>

          <div>
            <div className="flex items-baseline justify-between">
              <label className={label} htmlFor="llm-url">Base URL</label>
              {cfg.baseUrl !== provider.baseUrl && provider.baseUrl && (
                <button className="text-[11px] text-gray-500 hover:text-accent" onClick={() => patch(provider.id, { baseUrl: provider.baseUrl })}>
                  Reset to default
                </button>
              )}
            </div>
            <input
              id="llm-url"
              className="field"
              value={cfg.baseUrl}
              onChange={(e) => patch(provider.id, { baseUrl: e.target.value })}
              placeholder={provider.id === "custom" ? "https://your-server.example.com/v1" : provider.baseUrl}
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          {provider.kind === "openai" && (
            <div>
              <div className="flex items-baseline justify-between">
                <label className={label} htmlFor="llm-key">API key{provider.needsKey ? "" : " (optional)"}</label>
                {provider.keyUrl && (
                  <a className="text-[11px] text-gray-500 hover:text-accent" href={provider.keyUrl} target="_blank" rel="noreferrer">
                    Get a key
                  </a>
                )}
              </div>
              <div className="flex gap-2">
                <input
                  id="llm-key"
                  className="field"
                  type={showKey ? "text" : "password"}
                  value={cfg.apiKey}
                  onChange={(e) => patch(provider.id, { apiKey: e.target.value.trim() })}
                  placeholder={provider.needsKey ? "Paste your API key" : "Leave empty if the server needs none"}
                  spellCheck={false}
                  autoComplete="off"
                  data-1p-ignore
                />
                <button className="rounded border border-edge px-2 text-xs hover:bg-edge" onClick={() => setShowKey((v) => !v)} aria-pressed={showKey}>
                  {showKey ? "Hide" : "Show"}
                </button>
              </div>
            </div>
          )}

          <div>
            <label className={label} htmlFor="llm-model">Model</label>
            {showSelect ? (
              <select
                id="llm-model"
                className="field"
                value={cfg.model}
                onChange={(e) => (e.target.value === CUSTOM ? setCustomModel(true) : patch(provider.id, { model: e.target.value }))}
              >
                {!cfg.model && <option value="">Choose a model</option>}
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
                <option value={CUSTOM}>Other (type a name)</option>
              </select>
            ) : (
              <input
                id="llm-model"
                className="field"
                value={cfg.model}
                onChange={(e) => patch(provider.id, { model: e.target.value.trim() })}
                placeholder={provider.defaultModel ?? "model name"}
                spellCheck={false}
                autoComplete="off"
              />
            )}
            <p className="mt-1.5 text-[11px] text-gray-500">Models without tool calling fall back to JSON replies.</p>
          </div>

          <div className="flex items-start justify-between gap-3">
            <p className={`min-w-0 break-words text-xs ${toneClass}`} role="status" aria-live="polite">{test.text}</p>
            <button className="shrink-0 rounded border border-edge px-2.5 py-1 text-xs hover:bg-edge" onClick={runTest} disabled={test.state === "checking"}>
              Test connection
            </button>
          </div>

          <div className="space-y-2 border-t border-edge pt-3">
            <label className="flex items-center gap-2 text-xs text-gray-300">
              <input type="checkbox" checked={rememberKeys} onChange={(e) => setRememberKeys(e.target.checked)} className="accent-[#5b9dff]" />
              Remember API keys on this device
            </label>
            <p className="text-[11px] leading-relaxed text-gray-500">
              Keys stay in this browser. Turn the box off to keep them only until the tab closes. Requests go straight to the provider you choose.
            </p>
          </div>
        </div>

        <div className="flex justify-end border-t border-edge px-4 py-3">
          <button className="btn-primary rounded-lg px-5 py-1.5 text-xs" onClick={closeDialog}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
