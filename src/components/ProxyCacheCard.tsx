import { useState } from "react";
import { Card, Segmented, Slider } from "./ui";
import { useProject } from "../store/project";
import { useMedia } from "../store/media";
import { useLibrary } from "../store/library";
import { activeTimeline } from "../model/convert";
import { DEFAULT_CACHE, DEFAULT_PROXY, type ProxySettings, type RenderCacheSettings } from "../model/types";
import { makeVariants, removeVariant, useProxyJobs, variantUsage, wantsProxy } from "../lib/proxy";
import { useCacheInfo } from "../render/cache";
import { clearRenderCache, prerenderRange } from "./Preview";

const mb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0, n / 1024 ** 2).toFixed(n ? 1 : 0)} MB`);

/** Project settings for proxies, optimized media and the render cache (phase 16), with storage housekeeping. */
export default function ProxyCacheCard() {
  const open = useLibrary((s) => s.screen === "editor");
  const doc = useProject((s) => s.doc);
  const items = useMedia((s) => s.items);
  const jobs = useProxyJobs((s) => s.jobs);
  const cache = useCacheInfo();
  const [msg, setMsg] = useState("");
  if (!open) return null;

  const proxy: ProxySettings = { ...DEFAULT_PROXY, ...(doc.settings.proxy ?? {}) };
  const rc: RenderCacheSettings = { ...DEFAULT_CACHE, ...(doc.settings.renderCache ?? {}) };
  const setProxy = (p: Partial<ProxySettings>) => useProject.getState().editDoc((d) => ({ ...d, settings: { ...d.settings, proxy: { ...proxy, ...p } } }), "proxy-settings");
  const setCache = (p: Partial<RenderCacheSettings>) => useProject.getState().editDoc((d) => ({ ...d, settings: { ...d.settings, renderCache: { ...rc, ...p } } }), "cache-settings");
  const usage = variantUsage();
  const large = items.filter((i) => wantsProxy(i) && !i.proxy);
  const used = new Set(activeTimeline(doc).clips.map((c) => doc.media.find((m) => m.id === c.mediaId)?.poolId).filter(Boolean));
  const unusedProxies = items.filter((i) => (i.proxy || i.optimized) && !used.has(i.id));
  const running = Object.values(jobs).filter((j) => !j.error).length;
  const tl = activeTimeline(doc);
  const btn = "rounded-lg border border-edge px-3 py-1.5 text-[12px] text-gray-300 hover:bg-raised disabled:opacity-40";

  return (
    <Card title="Proxies and render cache (this project)" hint="Smaller copies of large videos make editing smooth; export still uses the originals.">
      <label className="flex items-center gap-2 text-[13px] text-gray-300">
        <input type="checkbox" checked={proxy.use} onChange={(e) => setProxy({ use: e.target.checked })} />
        Use proxies and optimized media for playback
      </label>
      <div>
        <span className="label">Proxy size</span>
        <Segmented
          label="Proxy size"
          value={proxy.size}
          onChange={(size) => setProxy({ size })}
          options={[
            { value: "half", label: "1/2" },
            { value: "quarter", label: "1/4" },
            { value: "540", label: "540p" },
            { value: "720", label: "720p" },
            { value: "1080", label: "1080p" },
          ]}
        />
      </div>
      <label className="flex items-center gap-2 text-[13px] text-gray-300">
        <input type="checkbox" checked={proxy.suggest} onChange={(e) => setProxy({ suggest: e.target.checked })} />
        Suggest proxies for clips above 1080p or when playback drops frames
      </label>
      <label className="flex items-start gap-2 text-[13px] text-gray-300">
        <input type="checkbox" className="mt-0.5" checked={proxy.exportFromProxies} onChange={(e) => setProxy({ exportFromProxies: e.target.checked })} />
        <span>
          Export from proxies
          <span className="block text-[11px] text-gray-500">Faster but lower quality. Leave off for the final video.</span>
        </span>
      </label>
      <div className="flex flex-wrap gap-1.5">
        <button className={btn} disabled={!large.length} onClick={() => makeVariants(large.map((i) => i.id), "proxy")}>
          Proxies for {large.length} large clip{large.length === 1 ? "" : "s"}
        </button>
        <button className={btn} disabled={!unusedProxies.length} onClick={() => unusedProxies.forEach((i) => (i.proxy && void removeVariant(i.id, "proxy"), i.optimized && void removeVariant(i.id, "optimized")))}>
          Remove {unusedProxies.length} unused
        </button>
      </div>
      <p className="text-[11px] text-gray-500">
        {usage.proxies} prox{usage.proxies === 1 ? "y" : "ies"} ({mb(usage.proxyBytes)}), {usage.optimized} optimized ({mb(usage.optimizedBytes)}){running ? `, ${running} being made` : ""}.
      </p>

      <div className="border-t border-edge pt-3">
        <span className="label">Render cache</span>
        <Segmented
          label="Render cache"
          value={rc.mode}
          onChange={(mode) => setCache({ mode })}
          options={[
            { value: "off", label: "Off" },
            { value: "smart", label: "Smart" },
            { value: "always", label: "All video" },
          ]}
        />
        <p className="mt-1 text-[11px] text-gray-500">Smart keeps only frames that did not play in real time. Cached parts show as a green strip on the ruler.</p>
      </div>
      <Slider label="Cache size" value={rc.sizeMB} min={64} max={4096} step={64} unit=" MB" onChange={(v) => setCache({ sizeMB: v })} />
      <p className="text-[11px] text-gray-500">
        {cache.frames} frames cached ({cache.mb} MB of {rc.sizeMB} MB).
      </p>
      <div className="flex flex-wrap gap-1.5">
        <button className={btn} onClick={() => clearRenderCache()} disabled={!cache.frames}>
          Clear cache
        </button>
        <button
          className={btn}
          disabled={rc.mode === "off" || tl.inPoint === undefined || tl.outPoint === undefined}
          title={tl.inPoint === undefined || tl.outPoint === undefined ? "Set in and out points on the timeline (I and O) first" : "Render the in/out range now"}
          onClick={async () => {
            setMsg("Rendering the in/out range...");
            try {
              const n = await prerenderRange(tl.inPoint!, tl.outPoint!, (f) => setMsg(`Rendering the in/out range... ${Math.round(f * 100)}%`));
              setMsg(n ? `Cached ${n} frames.` : "Nothing to cache there (no video or images, or already cached).");
            } catch (e) {
              setMsg((e as Error).message);
            }
          }}
        >
          Pre-render in/out
        </button>
      </div>
      {msg && <p className="text-[11px] text-gray-400" role="status">{msg}</p>}
    </Card>
  );
}
