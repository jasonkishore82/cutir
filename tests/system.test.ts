// Phase 30: plugins, scripting, capability check, quality governor and diagnostics.
import { validatePlugin, uniformName, permissionSummary, MAX_GLSL, type Plugin } from "../src/lib/plugins/manifest";
import { effectFromPlugin, effectId } from "../src/lib/plugins/host";
import { registerEffect, unregisterEffect, getEffect, listEffects, newEffect, cleanParams } from "../src/lib/effects";
import { handleCall, type ScriptHost } from "../src/lib/scripting/api";
import { runScript, WORKER_SOURCE, type Spawn } from "../src/lib/scripting/run";
import { createGovernor, LEVELS } from "../src/lib/system/governor";
import { check, message, detect, type Env } from "../src/lib/system/capabilities";
import { addError, buildBundle, scrub, MAX_ERRORS } from "../src/lib/system/diagnostics";

let fails = 0;
function ok(name: string, cond: boolean, got?: unknown) {
  if (!cond) fails++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : `  got ${JSON.stringify(got)?.slice(0, 300)}`}`);
}

/* ---------- manifests ---------- */
const good = {
  id: "warm-look",
  name: "Warm look",
  version: "1.2.0",
  api: 1,
  permissions: ["effects", "presets", "scripts"],
  effects: [
    {
      id: "tint",
      name: "Tint",
      category: "Colour",
      description: "Mix a colour",
      params: [
        { key: "amount", label: "Amount", type: "number", min: 0, max: 100, default: 150 },
        { key: "tone", label: "Colour", type: "color", default: "#ff8800" },
        { key: "centre", label: "Centre", type: "point", default: { x: 0.2, y: 0.8 } },
        { key: "flip", label: "Flip", type: "boolean", default: true },
        { key: "mode", label: "Mode", type: "choice", options: [{ value: "a", label: "A" }, { value: "b" }], default: "b" },
        { key: "turn", label: "Turn", type: "angle", default: 30 },
      ],
      glsl: "void main(){ vec4 c = texture(uTex, vUv); outColor = vec4(mix(c.rgb, uCol_tone, u_amount/100.0), c.a); }",
    },
  ],
  presets: [{ id: "web", name: "Web 720", container: "mp4", video: "avc", audio: "aac", width: 1280, height: 720 }],
  scripts: [{ id: "count", title: "Count", code: "return (await cutir.clips()).length;" }],
};
const v = validatePlugin(good);
ok("a good manifest validates", !!v.plugin && !v.errors.length, v.errors);
const plugin = v.plugin as Plugin;
ok("default is clamped into range", (plugin.effects[0].params[0] as { default: number }).default === 100);
ok("choice options get labels", JSON.stringify((plugin.effects[0].params[4] as { options: unknown[] }).options) === '[{"value":"a","label":"A"},{"value":"b","label":"b"}]');
ok("preset id is namespaced by the plugin", plugin.presets[0].id.startsWith("plugin-warm-look-"), plugin.presets[0].id);
ok("permission summary lists all three kinds", permissionSummary(plugin).length === 3);

const bad = (patch: Record<string, unknown>) => validatePlugin({ ...good, ...patch });
ok("a non-object is refused", !validatePlugin("x").plugin && !validatePlugin(null).plugin && !validatePlugin([]).plugin);
ok("wrong api version is refused", bad({ api: 2 }).errors.some((e) => /API/.test(e)));
ok("bad id is refused", !!bad({ id: "Bad Id" }).errors.length);
ok("effects need the permission", bad({ permissions: ["presets", "scripts"] }).errors.some((e) => /"effects" permission/.test(e)));
ok("presets need the permission", bad({ permissions: ["effects", "scripts"] }).errors.some((e) => /"presets" permission/.test(e)));
ok("scripts need the permission", bad({ permissions: ["effects", "presets"] }).errors.some((e) => /"scripts" permission/.test(e)));
ok("an unknown permission is reported", bad({ permissions: ["effects", "network"] }).errors.some((e) => /unknown permission "network"/.test(e)));
ok("#extension is refused", bad({ effects: [{ ...good.effects[0], glsl: "#extension GL_OES_x : enable\nvoid main(){}" }] }).errors.some((e) => /#extension/.test(e)));
ok("huge glsl is refused", bad({ effects: [{ ...good.effects[0], glsl: "void main(){}" + " ".repeat(MAX_GLSL) }] }).errors.some((e) => /longer/.test(e)));
ok("glsl without main is refused", bad({ effects: [{ ...good.effects[0], glsl: "float x;" }] }).errors.some((e) => /main/.test(e)));
ok("an unsupported param type is refused", bad({ effects: [{ ...good.effects[0], params: [{ key: "x", type: "lut" }] }] }).errors.some((e) => /not supported/.test(e)));
ok("a param key that would clash is refused", bad({ effects: [{ ...good.effects[0], params: [{ key: "Bad", type: "boolean" }] }] }).errors.some((e) => /must start with a lowercase/.test(e)));
ok("duplicate effect ids are reported", bad({ effects: [good.effects[0], good.effects[0]] }).errors.some((e) => /used twice/.test(e)));
ok("a plugin that adds nothing is refused", validatePlugin({ id: "empty", name: "E", api: 1, permissions: [] }).errors.some((e) => /adds nothing/.test(e)));
ok("empty script code is refused", bad({ scripts: [{ id: "xx", code: "  " }] }).errors.some((e) => /empty/.test(e)));
ok("uniform names follow the runner's type prefixes", uniformName({ key: "a", type: "number" }) === "u_a" && uniformName({ key: "a", type: "color" }) === "uCol_a" && uniformName({ key: "a", type: "point" }) === "uPt_a");

import { readFileSync } from "node:fs";
const starter = validatePlugin(JSON.parse(readFileSync("docs/plugin-starter/warm-tint.json", "utf8")));
ok("the starter plugin in the docs is valid", !!starter.plugin && starter.plugin.effects.length === 1 && starter.plugin.scripts.length === 1, starter.errors);

/* ---------- installing an effect needs no core change ---------- */
const def = effectFromPlugin(plugin, plugin.effects[0]);
ok("effect id is namespaced", def.id === "warm-look-tint" && effectId(plugin, plugin.effects[0]) === def.id);
ok("effect is not registered before install", !getEffect(def.id));
registerEffect(def);
ok("effect is in the registry after register", !!getEffect(def.id) && listEffects().some((e) => e.id === def.id));
const fx = newEffect(def.id, { amount: 55, tone: "#00ff00" });
ok("newEffect uses the plugin's defaults and overrides", fx.params.amount === 55 && fx.params.tone === "#00ff00" && (fx.params.centre as { x: number }).x === 0.2, fx.params);
ok("cleanParams clamps plugin params", cleanParams(def.params, { amount: 999 }).amount === 100);
const u = def.gpu!.uniforms({ amount: 40, tone: "#ff0000", centre: { x: 0.1, y: 0.9 }, flip: true, mode: "b", turn: 90 }, { w: 2, h: 2, time: 0, clipDuration: 1, scratch: () => null as never });
ok("uniforms: number, colour, point, boolean, choice index, angle", u.u_amount === 40 && JSON.stringify(u.uCol_tone) === "[1,0,0]" && JSON.stringify(u.uPt_centre) === "[0.1,0.9]" && u.u_flip === 1 && u.u_mode === 1 && u.u_turn === 90, u);
unregisterEffect(def.id);
ok("effect is gone after unregister", !getEffect(def.id));
ok("built-in effects are untouched", !!getEffect("blur") && !!getEffect("invert"));

/* ---------- scripting ---------- */
const calls: string[] = [];
const host: ScriptHost = {
  commands: () => [{ id: "view.fullscreen", title: "Fullscreen", category: "View" }],
  run: async (id) => (calls.push(`run:${id}`), id === "view.fullscreen"),
  tools: () => [{ name: "add_clip", signature: "add_clip()" }],
  tool: async (name, args) => (calls.push(`tool:${name}:${JSON.stringify(args)}`), name === "bad" ? { ok: false, summary: "nope" } : { ok: true, summary: `did ${name}` }),
  project: () => ({ fps: 30 }),
  clips: () => [{ id: "a" }, { id: "b" }],
  log: () => {},
};
ok("handleCall lists commands", ((await handleCall(host, "commands", [])) as unknown[]).length === 1);
ok("handleCall refuses an unknown method", await handleCall(host, "eval", ["1"]).then(() => false, (e) => /does not exist/.test(e.message)));
ok("handleCall refuses a non-string command id", await handleCall(host, "run", [5]).then(() => false, (e) => /string/.test(e.message)));
ok("handleCall reports a command that is not available", await handleCall(host, "run", ["file.delete"]).then(() => false, (e) => /not available/.test(e.message)));
ok("handleCall turns a failed tool into an error", await handleCall(host, "tool", ["bad", {}]).then(() => false, (e) => e.message === "nope"));
ok("handleCall returns the tool summary", (await handleCall(host, "tool", ["add_clip", { x: 1 }])) === "did add_clip");

// the worker source run in-process: `self` and `postMessage` are shimmed, which is all the source needs
const spawn: Spawn = (source) => {
  const self: any = {};
  const w: any = {
    onmessage: null as null | ((e: { data: any }) => void),
    postMessage: (m: unknown) => queueMicrotask(() => self.onmessage?.({ data: m })),
    terminate: () => (w.dead = true),
  };
  const postMessage = (m: unknown) => queueMicrotask(() => !w.dead && w.onmessage?.({ data: m }));
  new Function("self", "postMessage", source)(self, postMessage);
  return w;
};
const r1 = await runScript("const c = await cutir.clips(); console.log('n', c.length); return c.length * 2;", host, { spawn });
ok("a script gets results and logs", r1.ok && r1.result === 4 && r1.logs.join("|") === "n 2" && r1.calls === 2, r1);
const r2 = await runScript("await cutir.run('view.fullscreen'); await cutir.tool('add_clip', {a: 1}); return 'done';", host, { spawn });
ok("a script can run commands and tools", r2.ok && calls.includes("run:view.fullscreen") && calls.includes('tool:add_clip:{"a":1}'), r2);
const r3 = await runScript("await cutir.tool('bad', {});", host, { spawn });
ok("a failed tool call fails the script with its message", !r3.ok && r3.error === "nope", r3);
const r4 = await runScript("throw new Error('boom');", host, { spawn });
ok("a thrown error is reported", !r4.ok && r4.error === "boom", r4);
const r5 = await runScript("return await cutir.nothing();", host, { spawn });
ok("a missing api method is a clear error", !r5.ok && /nothing/.test(r5.error ?? ""), r5);
const r6 = await runScript("for (;;) { await cutir.log('x'); }", host, { spawn });
ok("a runaway script is stopped by the call limit", !r6.ok && /more than 2000 calls/.test(r6.error ?? ""), r6.error);
const r7 = await runScript("await new Promise(() => {});", host, { spawn, timeoutMs: 50 });
ok("a script that never ends is stopped by the timeout", !r7.ok && /stopped/.test(r7.error ?? ""), r7.error);
ok("the worker source removes network APIs before running", /fetch/.test(WORKER_SOURCE) && /XMLHttpRequest/.test(WORKER_SOURCE) && /WebSocket/.test(WORKER_SOURCE));

/* ---------- capability check ---------- */
const full: Env = { webgl2: true, webgpu: false, webcodecsVideo: true, webcodecsAudio: true, opfs: true, filePicker: true, offscreenCanvas: true, workers: true, indexedDb: true, isolated: true, serviceWorker: true, cores: 8, memoryGB: 8 };
const a = check(full);
ok("a full browser passes with nothing degraded", a.ok && !a.blocking.length && !a.degraded.length && message(a) === "", a);
ok("webgpu is optional", a.items.find((i) => i.id === "webgpu")!.need === "optional" && !a.items.find((i) => i.id === "webgpu")!.ok);
const b = check({ ...full, webcodecsVideo: false });
ok("no WebCodecs blocks", !b.ok && b.blocking.map((i) => i.id).join() === "webcodecs" && /WebCodecs/.test(message(b)));
const c = check({ ...full, webgl2: false, opfs: false });
ok("no WebGL2 or OPFS only degrades, with the fallback explained", c.ok && c.degraded.length === 2 && /canvas path/.test(message(c)) && /IndexedDB/.test(message(c)), message(c));
const d = detect({ navigator: { hardwareConcurrency: 4, storage: {}, serviceWorker: {} }, Worker: class {}, indexedDB: {}, crossOriginIsolated: false });
ok("detect reads what the browser offers", d.workers && d.indexedDb && !d.webgl2 && !d.webcodecsVideo && !d.opfs && d.serviceWorker && d.cores === 4, d);

/* ---------- quality governor ---------- */
const g = createGovernor();
const play = (fps: number) => g.sample({ fps, target: 30, playing: true });
ok("full quality at the start", g.scale === 1);
ok("one slow sample does not drop quality", play(15) === 1);
ok("two slow samples drop one level", play(15) === LEVELS[1]);
play(10);
const lvl2 = play(10);
play(5);
play(5);
ok("it keeps dropping while slow, down to the last level", lvl2 === LEVELS[2] && g.scale === LEVELS[3], [lvl2, g.scale]);
for (let i = 0; i < 10; i++) play(5);
ok("it never goes below the last level", g.scale === LEVELS[3]);
for (let i = 0; i < 9; i++) play(30);
ok("recovery is slow: nine good samples do nothing", g.scale === LEVELS[3]);
play(30);
ok("the tenth good sample raises one level", g.scale === LEVELS[2]);
const paused = g.sample({ fps: 1, target: 30, playing: false });
ok("paused playback never changes quality", paused === LEVELS[2]);
play(30);
play(20);
ok("a mixed sample resets the run of good ones", (() => { for (let i = 0; i < 9; i++) play(30); return g.scale === LEVELS[2]; })());
g.reset();
ok("reset goes back to full", g.scale === 1);
const g2 = createGovernor();
for (let i = 0; i < 6; i++) g2.sample({ fps: 29, target: 30, playing: true });
ok("a little under the rate (29 of 30) is left alone", g2.scale === 1);

/* ---------- diagnostics ---------- */
ok("scrub removes Windows paths", !/Users/.test(scrub("failed at C:\\Users\\Ann\\Videos\\holiday.mp4 line 3")), scrub("failed at C:\\Users\\Ann\\Videos\\holiday.mp4 line 3"));
ok("scrub removes unix paths", !/home/.test(scrub("read /home/ann/clips/a.mov failed")), scrub("read /home/ann/clips/a.mov failed"));
ok("scrub removes blob and file urls", scrub("bad blob:http://localhost:5173/abc-123 and file:///C:/x/y.png") === "bad <url> and <url>", scrub("bad blob:http://localhost:5173/abc-123 and file:///C:/x/y.png"));
ok("scrub keeps only the origin of a web address", scrub("GET https://example.com/secret/token?a=1 failed") === "GET https://example.com/<path> failed", scrub("GET https://example.com/secret/token?a=1 failed"));
ok("scrub removes file names and emails", !/wedding|ann@/.test(scrub("cannot decode wedding-final.mp4 for ann@mail.com")), scrub("cannot decode wedding-final.mp4 for ann@mail.com"));
let log = addError([], { kind: "error", message: "boom", stack: "Error: boom\n  at f (C:\\proj\\a.ts:1:1)" }, 1000);
ok("an error is added with a scrubbed stack", log.length === 1 && !/proj/.test(log[0].stack ?? ""), log);
log = addError(log, { kind: "error", message: "boom" }, 1500);
ok("the same error within a second is one entry", log.length === 1);
log = addError(log, { kind: "error", message: "boom" }, 5000);
ok("the same error later is a new entry", log.length === 2);
for (let i = 0; i < 80; i++) log = addError(log, { kind: "error", message: `e${i}` }, 10000 + i * 5000);
ok("the log is capped", log.length === MAX_ERRORS && log[log.length - 1].message === "e79", log.length);
const bundle = buildBundle({ app: { version: "0.1.0" }, userAgent: "UA", capabilities: a, env: { cores: 8 }, errors: log.slice(-2), project: { timelines: 1, tracks: 3, clips: 9, media: 2, durationSeconds: 60, fps: 30, width: 1920, height: 1080 }, plugins: [{ id: "warm-look", version: "1.2.0" }], now: 0 });
ok("the bundle has counts, capabilities, plugins and errors", bundle.project?.clips === 9 && bundle.capabilities.length === a.items.length && bundle.plugins[0].id === "warm-look" && bundle.errors.length === 2 && bundle.createdAt === "1970-01-01T00:00:00.000Z");
ok("the bundle says it holds no project content and has no names in it", /no project content/.test(bundle.note) && !/title|name/i.test(JSON.stringify(bundle.project)));

console.log(fails ? `\n${fails} checks failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
