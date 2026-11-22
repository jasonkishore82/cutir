import { useEffect, useRef, useState } from "react";
import ProxyCacheCard from "./ProxyCacheCard";
import ClaudeControlCard from "./ClaudeControlCard";
import { PROVIDERS, providerById } from "../lib/llm/providers";
import { configProblem, listChatModels } from "../lib/llm";
import { OllamaError } from "../lib/ollama";
import { configFor, useSettings, type SettingsTab } from "../store/settings";
import { useLibrary } from "../store/library";
import { useChat } from "../store/chat";
import { Card, Icon, Segmented, type IconName } from "./ui";
import { setTheme, useTheme, type ThemeChoice } from "../lib/theme";
import ShortcutsEditor from "./ShortcutsEditor";
import AssistantTab from "./AssistantTab";
import ProjectDataTab from "./ProjectDataTab";
import SystemTab from "./SystemTab";
import { TEXT_SCALES, usePrefs, type Contrast, type Motion } from "../store/prefs";
import { LAYOUT_PRESETS, PAGES } from "../lib/workspace/pages";
import { useWorkspace } from "../store/workspace";
import { downloadBlob } from "../lib/exporter";

const TABS: { id: SettingsTab; label: string; icon: IconName }[] = [
  { id: "ai", label: "AI models", icon: "ai" },
  { id: "assistant", label: "Assistant", icon: "ai" },
  { id: "editor", label: "Editor", icon: "sliders" },
  { id: "storage", label: "Storage", icon: "storage" },
  { id: "project", label: "Project data", icon: "archive" },
  { id: "system", label: "Plugins and system", icon: "effects" },
  { id: "shortcuts", label: "Shortcuts", icon: "keyboard" },
];

type Test = { state: "idle" | "checking" | "ok" | "warn" | "error"; text: string };
const CUSTOM = "__custom__";
const label = "mb-1.5 block text-[11px] font-medium text-gray-400";

/* ---------------- AI models ---------------- */

function AiTab() {
  const provider = providerById(useSettings((s) => s.provider));
  const byProvider = useSettings((s) => s.byProvider);
  const rememberKeys = useSettings((s) => s.rememberKeys);
  const { setProvider, patch, setRememberKeys } = useSettings.getState();

  const cfg = configFor({ byProvider }, provider.id);
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [customModel, setCustomModel] = useState(false);
  const [test, setTest] = useState<Test>({ state: "idle", text: "" });
  const abortRef = useRef<AbortController | null>(null);

  const runTest = async () => {
    abortRef.current?.abort();
    if (provider.id === "none") return;
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
    setModels([]);
    setCustomModel(false);
    setTest({ state: "idle", text: "" });
    const t = setTimeout(runTest, 500);
    return () => {
      clearTimeout(t);
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id, cfg.baseUrl, cfg.apiKey]);

  const modelInList = !cfg.model || models.includes(cfg.model);
  const showSelect = models.length > 0 && !customModel && modelInList;
  const local = PROVIDERS.filter((p) => p.local);
  const cloud = PROVIDERS.filter((p) => !p.local);
  const tone = { idle: "text-gray-500", checking: "text-gray-400", ok: "text-green-400", warn: "text-yellow-400", error: "text-red-400" }[test.state];

  return (
    <div className="space-y-4">
      <Card title="Provider">
        <div>
          <label className={label} htmlFor="llm-provider">Service</label>
          <select id="llm-provider" className="field" value={provider.id} onChange={(e) => setProvider(e.target.value as typeof provider.id)}>
            {provider.id === "none" && <option value="none" disabled>Choose a provider</option>}
            <optgroup label="Runs on your computer">
              {local.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </optgroup>
            <optgroup label="Cloud (needs an API key)">
              {cloud.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </optgroup>
          </select>
          {provider.note && <p className="mt-1.5 text-[11px] text-gray-500">{provider.note}</p>}
        </div>
      </Card>

      {provider.id !== "none" && (
        <>
          <Card title="Connection">
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

            {provider.kind !== "ollama" && (
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
                  <button className="rounded-lg border border-edge px-3 text-xs hover:bg-raised" onClick={() => setShowKey((v) => !v)} aria-pressed={showKey}>
                    {showKey ? "Hide" : "Show"}
                  </button>
                </div>
              </div>
            )}

            <div className="flex items-start justify-between gap-3">
              <p className={`min-w-0 break-words text-xs ${tone}`} role="status" aria-live="polite">{test.text}</p>
              <button className="shrink-0 rounded-lg border border-edge px-3 py-1 text-xs hover:bg-raised disabled:opacity-40" onClick={runTest} disabled={test.state === "checking"}>
                Test connection
              </button>
            </div>
          </Card>

          <Card title="Model">
            <div>
              <label className={label} htmlFor="llm-model">Model used by the assistant</label>
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
          </Card>
        </>
      )}

      <Card title="API keys">
        <label className="flex items-center gap-2 text-[13px] text-gray-300">
          <input type="checkbox" checked={rememberKeys} onChange={(e) => setRememberKeys(e.target.checked)} />
          Remember API keys on this device
        </label>
        <p className="text-[11px] leading-relaxed text-gray-500">
          Keys stay in this browser. Turn the box off to keep them only until the tab closes. Requests go straight to the provider you choose.
        </p>
      </Card>
      <ClaudeControlCard />
    </div>
  );
}

/* ---------------- Editor ---------------- */

function EditorTab() {
  const showAiOnOpen = useSettings((s) => s.showAiOnOpen);
  const { setShowAiOnOpen } = useSettings.getState();
  const [done, setDone] = useState("");
  const theme = useTheme();
  const prefs = usePrefs();
  const lbtn = "rounded-lg border border-edge px-3 py-1.5 text-[13px] text-gray-300 hover:bg-raised hover:text-white";
  return (
    <div className="space-y-4">
      <Card title="Appearance" hint="System follows your computer's light or dark setting.">
        <Segmented<ThemeChoice>
          label="Theme"
          value={theme}
          onChange={setTheme}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
            { value: "system", label: "System" },
          ]}
        />
      </Card>
      <Card title="AI panel">
        <label className="flex items-center gap-2 text-[13px] text-gray-300">
          <input type="checkbox" checked={showAiOnOpen} onChange={(e) => setShowAiOnOpen(e.target.checked)} />
          Open the AI panel when a project opens
        </label>
      </Card>
      <Card title="Layout" hint="Each page (Media, Cut, Edit, Motion, Color, Audio, Lyrics, Deliver) keeps its own panel sizes. They are saved for you.">
        <div className="flex flex-wrap items-center gap-2">
          <button className={lbtn} onClick={() => { useWorkspace.getState().resetPage(); setDone("This page is back to its default layout."); }}>Reset this page</button>
          <button className={lbtn} onClick={() => { useWorkspace.getState().resetAll(); setDone("Every page is back to its default layout."); }}>Reset all pages</button>
          <label className="flex items-center gap-1 text-[13px] text-gray-300">
            Apply to this page
            <select className="field !w-auto" defaultValue="" aria-label="Layout preset" onChange={(e) => { if (e.target.value) { useWorkspace.getState().applyPreset(e.target.value); setDone(`Applied: ${LAYOUT_PRESETS.find((p) => p.id === e.target.value)?.name}.`); e.target.value = ""; } }}>
              <option value="">Choose a layout...</option>
              {LAYOUT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <button className={lbtn} onClick={() => downloadBlob(new Blob([useWorkspace.getState().exportLayouts()], { type: "application/json" }), "cutir-layouts.json")}>Export layouts</button>
          <button
            className={lbtn}
            onClick={() => {
              const input = document.createElement("input");
              input.type = "file";
              input.accept = ".json,application/json";
              input.onchange = async () => input.files?.[0] && setDone(useWorkspace.getState().importLayouts(await input.files[0].text()) ? "Layouts imported." : "That is not a layouts file.");
              input.click();
            }}
          >
            Import layouts
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-500">{PAGES.length} pages. Open the page you want to change, then use the menu or Ctrl+K.</p>
        {done && <p className="mt-1 text-xs text-green-400" role="status">{done}</p>}
      </Card>
      <Card title="Accessibility" hint="Applies at once and is kept for you.">
        <div className="space-y-3">
          <Segmented<Motion>
            label="Motion"
            value={prefs.motion}
            onChange={prefs.setMotion}
            options={[{ value: "system", label: "System" }, { value: "reduce", label: "Reduce" }, { value: "full", label: "Full" }]}
          />
          <Segmented<Contrast>
            label="Contrast"
            value={prefs.contrast}
            onChange={prefs.setContrast}
            options={[{ value: "normal", label: "Normal" }, { value: "high", label: "High" }]}
          />
          <label className="flex items-center gap-3 text-[13px] text-gray-300">
            Interface text size
            <input type="range" min={0} max={TEXT_SCALES.length - 1} step={1} value={Math.max(0, TEXT_SCALES.findIndex((v) => v >= prefs.textScale))} onChange={(e) => prefs.setTextScale(TEXT_SCALES[Number(e.target.value)])} aria-valuetext={`${Math.round(prefs.textScale * 100)} percent`} />
            <span className="text-xs text-gray-500">{Math.round(prefs.textScale * 100)}%</span>
          </label>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Storage ---------------- */

const mb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0.1, n / 1024 ** 2).toFixed(1)} MB`);

function StorageTab() {
  const projects = useLibrary((s) => s.entries.length);
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const [confirm, setConfirm] = useState<"chats" | "keys" | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    navigator.storage?.estimate?.().then((e) => e.usage !== undefined && e.quota !== undefined && setUsage({ used: e.usage, quota: e.quota })).catch(() => {});
  }, []);

  const row = "flex items-center justify-between gap-3";
  const danger = "rounded-lg border border-red-900/60 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/60";
  return (
    <div className="space-y-4">
      <ProxyCacheCard />
      <Card title="Browser storage">
        <div className={row}>
          <span className="text-[13px] text-gray-300">Projects</span>
          <span className="tabular-nums text-[13px] text-gray-400">{projects}</span>
        </div>
        <div className={row}>
          <span className="text-[13px] text-gray-300">Space used</span>
          <span className="tabular-nums text-[13px] text-gray-400">{usage ? `${mb(usage.used)} of ${mb(usage.quota)}` : "Not available"}</span>
        </div>
      </Card>

      <Card title="Saved data">
        <div className={row}>
          <div>
            <p className="text-[13px] text-gray-300">API keys</p>
            <p className="text-[11px] text-gray-500">Removes the keys of every provider. Provider and model choices stay.</p>
          </div>
          {confirm === "keys" ? (
            <span className="flex gap-1.5">
              <button className={danger} onClick={() => (useSettings.getState().forgetKeys(), setConfirm(null), setNote("API keys removed."))}>Remove</button>
              <button className="rounded-lg px-3 py-1.5 text-xs text-gray-400 hover:bg-white/10" onClick={() => setConfirm(null)}>Cancel</button>
            </span>
          ) : (
            <button className={danger} onClick={() => setConfirm("keys")}>Forget keys</button>
          )}
        </div>
        <div className={row}>
          <div>
            <p className="text-[13px] text-gray-300">Chat history</p>
            <p className="text-[11px] text-gray-500">Deletes the assistant conversations of every project.</p>
          </div>
          {confirm === "chats" ? (
            <span className="flex gap-1.5">
              <button className={danger} onClick={() => (useChat.getState().clearHistory(), setConfirm(null), setNote("Chat history cleared."))}>Delete</button>
              <button className="rounded-lg px-3 py-1.5 text-xs text-gray-400 hover:bg-white/10" onClick={() => setConfirm(null)}>Cancel</button>
            </span>
          ) : (
            <button className={danger} onClick={() => setConfirm("chats")}>Clear history</button>
          )}
        </div>
        {note && <p className="text-xs text-green-400" role="status">{note}</p>}
      </Card>
    </div>
  );
}

/* ---------------- Shortcuts ---------------- */

const ShortcutsTab = ShortcutsEditor;

/* ---------------- screen ---------------- */

export default function SettingsScreen() {
  const open = useSettings((s) => s.dialogOpen);
  const tab = useSettings((s) => s.tab);
  const { setTab, closeDialog } = useSettings.getState();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !(e.target as HTMLElement).closest("select") && closeDialog();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeDialog]);

  if (!open) return null;

  const onTabKey = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(i + step + TABS.length) % TABS.length];
    setTab(next.id);
    requestAnimationFrame(() => document.getElementById(`settings-tab-${next.id}`)?.focus());
  };

  const panel = "rounded-2xl border border-white/[0.07] bg-panel/80 shadow-panel backdrop-blur-xl";
  const current = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <div className="aura fixed inset-0 z-50 flex gap-2 p-2" role="dialog" aria-modal="true" aria-label="Settings">
      <nav className={`${panel} flex w-[230px] shrink-0 flex-col p-3`}>
        <button className="mb-4 flex h-8 items-center gap-1 self-start rounded-lg pl-1.5 pr-2.5 text-xs text-gray-300 hover:bg-white/[0.07] hover:text-white" onClick={closeDialog}>
          <Icon name="back" className="h-4 w-4" /> Back
        </button>
        <h2 className="text-gradient mb-2 px-2 text-[19px] font-semibold tracking-tight">Settings</h2>
        <div role="tablist" aria-orientation="vertical" aria-label="Settings sections" onKeyDown={onTabKey} className="space-y-0.5">
          {TABS.map((t) => {
            const on = t.id === tab;
            return (
              <button
                key={t.id}
                id={`settings-tab-${t.id}`}
                role="tab"
                aria-selected={on}
                aria-controls="settings-panel"
                tabIndex={on ? 0 : -1}
                onClick={() => setTab(t.id)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] ${
                  on ? "bg-gradient-to-b from-white/[0.16] to-white/[0.05] text-white ring-1 ring-white/10 shadow-[0_0_18px_rgb(91_157_255/0.22)]" : "text-gray-400 hover:bg-white/[0.05] hover:text-gray-100"
                }`}
              >
                <Icon name={t.icon} className={`h-4 w-4 ${on ? "text-accent" : ""}`} />
                {t.label}
              </button>
            );
          })}
        </div>
      </nav>

      <main id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`} className={`${panel} min-w-0 flex-1 overflow-y-auto`}>
        <div className="mx-auto max-w-[680px] space-y-5 px-8 py-8">
          <h1 className="text-gradient text-[26px] font-semibold tracking-tight">{current.label}</h1>
          {tab === "ai" && <AiTab />}
          {tab === "assistant" && <AssistantTab />}
          {tab === "editor" && <EditorTab />}
          {tab === "storage" && <StorageTab />}
          {tab === "project" && <ProjectDataTab />}
          {tab === "system" && <SystemTab />}
          {tab === "shortcuts" && <ShortcutsTab />}
        </div>
      </main>
    </div>
  );
}
