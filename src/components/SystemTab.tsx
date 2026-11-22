import { useRef, useState } from "react";
import { Card } from "./ui";
import { useSystem } from "../store/system";
import { usePlugins } from "../store/plugins";
import { permissionSummary, type Plugin } from "../lib/plugins/manifest";
import { download } from "../lib/interchange/common";

const btn = "rounded-lg border border-edge px-3 py-1.5 text-[13px] text-gray-300 hover:bg-raised hover:text-white disabled:opacity-40";
const link = "text-[11px] text-gray-400 underline hover:text-gray-100 disabled:opacity-40";

const STARTER: Plugin = {
  id: "my-tint",
  name: "My tint",
  version: "1.0.0",
  author: "",
  description: "A starter effect: mixes a colour over the picture.",
  api: 1,
  permissions: ["effects", "scripts"],
  effects: [
    {
      id: "tint",
      name: "Tint",
      category: "Colour",
      description: "Mix a colour over the picture",
      params: [
        { key: "amount", label: "Amount", type: "number", min: 0, max: 100, default: 40, unit: "%" },
        { key: "tone", label: "Colour", type: "color", default: "#ff7a3d" },
      ],
      glsl: "void main() {\n  vec4 c = texture(uTex, vUv);\n  outColor = vec4(mix(c.rgb, uCol_tone, u_amount / 100.0), c.a);\n}",
    },
  ],
  presets: [],
  scripts: [{ id: "count", title: "Count clips", code: "const clips = await cutir.clips();\nreturn `${clips.length} clips`;" }],
};

/** Settings, Plugins and system: capability check, performance, plugins and the scripting console, diagnostics (phase 30). */
export default function SystemTab() {
  return (
    <div className="space-y-4">
      <CapabilityCard />
      <PerformanceCard />
      <PluginsCard />
      <ConsoleCard />
      <DiagnosticsCard />
    </div>
  );
}

function CapabilityCard() {
  const report = useSystem((s) => s.report);
  return (
    <Card title="This browser" hint="What Cutir needs and what happens without it. Checked each time the app starts.">
      <ul className="space-y-1.5 text-[13px]">
        {report.items.map((i) => (
          <li key={i.id} className="flex gap-2">
            <span className={`w-14 shrink-0 text-xs ${i.ok ? "text-green-400" : i.need === "required" ? "text-red-400" : "text-yellow-300"}`}>{i.ok ? "Works" : i.need === "required" ? "Missing" : "Limited"}</span>
            <span className="text-gray-300">
              {i.name}
              {!i.ok && <span className="block text-xs text-gray-500">{i.without}</span>}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PerformanceCard() {
  const s = useSystem();
  return (
    <Card title="Performance" hint="Browsers decide hardware acceleration themselves; these switches are what Cutir can control.">
      <label className="flex items-start gap-2 text-[13px] text-gray-300">
        <input type="checkbox" className="mt-1" checked={s.autoQuality} onChange={(e) => s.set({ autoQuality: e.target.checked })} />
        <span>
          Lower the preview quality when playback falls behind
          <span className="block text-xs text-gray-500">The preview is drawn smaller while it cannot keep up and returns to full size when there is room. Exports are never affected.{s.scale < 1 ? ` Drawing at ${Math.round(s.scale * 100)}% now.` : ""}</span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-[13px] text-gray-300">
        <input type="checkbox" className="mt-1" checked={s.gpuEffects} onChange={(e) => s.set({ gpuEffects: e.target.checked })} />
        <span>
          Use the graphics card for effects
          <span className="block text-xs text-gray-500">Turn off if effects look wrong or the browser reports graphics problems. Plugin effects pass the picture through untouched while this is off.</span>
        </span>
      </label>
    </Card>
  );
}

function PluginsCard() {
  const { list, install, remove } = usePlugins();
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ text: string; plugin: Plugin } | null>(null);
  const [msg, setMsg] = useState<string[]>([]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setMsg([]);
    setPending(null);
    const text = await file.text();
    try {
      const { validatePlugin } = await import("../lib/plugins/manifest");
      const { plugin, errors } = validatePlugin(JSON.parse(text));
      if (!plugin) return setMsg(errors);
      setPending({ text, plugin });
    } catch {
      setMsg(["This file is not valid JSON."]);
    }
  };
  const accept = () => {
    if (!pending) return;
    const r = install(pending.text);
    setMsg(r.ok ? [`Installed ${pending.plugin.name}.`] : r.errors);
    setPending(null);
  };

  return (
    <Card title="Plugins" hint="A plugin is one JSON file: effects (graphics card code), delivery presets and script commands. Nothing runs until you accept what it asks for. Install only plugins you trust.">
      {list.length === 0 && <p className="text-xs text-gray-500">No plugins installed.</p>}
      {list.map((p) => (
        <div key={p.id} className="rounded-lg border border-edge px-3 py-2 text-[13px]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-gray-100">{p.name} <span className="text-xs text-gray-500">{p.version}{p.author ? ` by ${p.author}` : ""}</span></span>
            <button className={link} onClick={() => remove(p.id)}>Remove</button>
          </div>
          {p.description && <p className="text-xs text-gray-500">{p.description}</p>}
          <ul className="mt-1 list-disc pl-4 text-xs text-gray-400">{permissionSummary(p).map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      ))}
      {pending && (
        <div className="rounded-lg border border-yellow-700/60 bg-panel px-3 py-2 text-[13px]" role="alertdialog" aria-label="Install plugin">
          <p className="text-gray-100">Install {pending.plugin.name} {pending.plugin.version}?</p>
          <ul className="mt-1 list-disc pl-4 text-xs text-gray-300">{permissionSummary(pending.plugin).map((t, i) => <li key={i}>{t}</li>)}</ul>
          <div className="mt-2 flex gap-2">
            <button className={btn} onClick={accept}>Install</button>
            <button className={btn} onClick={() => setPending(null)}>Cancel</button>
          </div>
        </div>
      )}
      {msg.length > 0 && <ul className="space-y-0.5 text-xs text-yellow-300" role="status">{msg.map((m, i) => <li key={i}>{m}</li>)}</ul>}
      <div className="flex flex-wrap items-center gap-3">
        <input ref={input} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
        <button className={btn} onClick={() => input.current?.click()}>Install from file...</button>
        <button className={link} onClick={() => download("cutir-plugin-starter.json", JSON.stringify(STARTER, null, 2), "application/json")}>Save a starter plugin</button>
      </div>
    </Card>
  );
}

function ConsoleCard() {
  const { console: lines, running, run, clearConsole } = usePlugins();
  const [code, setCode] = useState("const clips = await cutir.clips();\nreturn clips.length + ' clips';");
  return (
    <Card title="Scripting console" hint="Write a script with the cutir API (cutir.clips(), cutir.tool(name, args), cutir.run(commandId) ...). It runs in a sandboxed worker, edits are undoable, and it stops after 15 seconds.">
      <textarea className="h-28 w-full rounded-lg border border-edge bg-black/30 p-2 font-mono text-xs text-gray-200" spellCheck={false} aria-label="Script" value={code} onChange={(e) => setCode(e.target.value)} />
      <div className="flex items-center gap-3">
        <button className={btn} disabled={running || !code.trim()} onClick={() => void run(code)}>{running ? "Running..." : "Run"}</button>
        <button className={link} onClick={clearConsole}>Clear output</button>
      </div>
      {lines.length > 0 && (
        <pre className="max-h-48 overflow-auto rounded-lg bg-black/30 p-2 font-mono text-[11px] leading-4" aria-label="Script output">
          {lines.map((l, i) => <div key={i} className={l.kind === "err" ? "text-red-300" : l.kind === "in" ? "text-gray-500" : "text-green-300"}>{l.kind === "in" ? "> " : ""}{l.text}</div>)}
        </pre>
      )}
    </Card>
  );
}

function DiagnosticsCard() {
  const { keepErrors, errors, set, clearErrors, saveBundle } = useSystem();
  return (
    <Card title="Diagnostics" hint="Nothing is ever sent anywhere. With this on, errors are kept in this browser so you can attach them to a bug report.">
      <label className="flex items-start gap-2 text-[13px] text-gray-300">
        <input type="checkbox" className="mt-1" checked={keepErrors} onChange={(e) => set({ keepErrors: e.target.checked })} />
        <span>Keep a local error log <span className="block text-xs text-gray-500">{errors.length} entr{errors.length === 1 ? "y" : "ies"} kept. File names, paths and links are removed.</span></span>
      </label>
      <div className="flex items-center gap-3">
        <button className={btn} onClick={saveBundle}>Save diagnostic bundle</button>
        <button className={link} disabled={!errors.length} onClick={clearErrors}>Clear log</button>
      </div>
      <p className="text-[11px] text-gray-500">The bundle holds browser and graphics details, feature support, counts (clips, tracks) and the error log. It holds no project content, media or file names.</p>
    </Card>
  );
}
