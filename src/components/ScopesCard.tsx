import { useEffect, useRef, useState } from "react";
import { Card } from "./ui";
import { histogram, scopeSource, vectorPosition, vectorscope, waveform } from "../lib/scopes";

type Kind = "waveform" | "parade" | "vectorscope" | "histogram";
const KINDS: { id: Kind; label: string }[] = [
  { id: "waveform", label: "Waveform" },
  { id: "parade", label: "Parade" },
  { id: "vectorscope", label: "Vectorscope" },
  { id: "histogram", label: "Histogram" },
];
const W = 256;
const H = 144;

/** Scopes of the frame on screen, redrawn about 15 times a second (also during playback). */
export default function ScopesCard() {
  const [kind, setKind] = useState<Kind>("waveform");
  const out = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const small = document.createElement("canvas");
    small.width = W;
    small.height = H;
    const sctx = small.getContext("2d", { willReadFrequently: true })!;
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 66) return;
      last = now;
      const src = scopeSource.canvas;
      const c = out.current;
      if (!src || !c || !src.width) return;
      sctx.drawImage(src, 0, 0, W, H);
      draw(c, kind, sctx.getImageData(0, 0, W, H).data);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [kind]);
  return (
    <Card title="Scopes" hint="Measured from the frame in the viewer. Brightest at the top of the waveform.">
      <div className="flex flex-wrap gap-1">
        {KINDS.map((k) => (
          <button key={k.id} onClick={() => setKind(k.id)} aria-pressed={kind === k.id} className={`rounded-md px-2 py-0.5 text-[11px] ${kind === k.id ? "bg-accent/25 text-accent" : "text-gray-400 hover:bg-white/10"}`}>
            {k.label}
          </button>
        ))}
      </div>
      <canvas ref={out} width={kind === "vectorscope" ? 256 : 384} height={kind === "vectorscope" ? 256 : 200} className="w-full rounded-md border border-edge bg-black" aria-label={`${kind} scope`} />
    </Card>
  );
}

function draw(c: HTMLCanvasElement, kind: Kind, px: Uint8ClampedArray) {
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, c.width, c.height);
  const img = ctx.createImageData(c.width, c.height);
  const set = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
    const i = (y * c.width + x) * 4;
    img.data[i] = Math.min(255, img.data[i] + r * a);
    img.data[i + 1] = Math.min(255, img.data[i + 1] + g * a);
    img.data[i + 2] = Math.min(255, img.data[i + 2] + b * a);
    img.data[i + 3] = 255;
  };
  if (kind === "histogram") {
    const h = histogram(px);
    const peak = Math.max(1, ...h.luma, ...h.r, ...h.g, ...h.b);
    for (let x = 0; x < c.width; x++) {
      const bin = Math.min(255, Math.floor((x / c.width) * 256));
      for (const [arr, col] of [[h.r, [255, 60, 60]], [h.g, [60, 255, 60]], [h.b, [70, 120, 255]]] as const) {
        const hh = Math.round((arr[bin] / peak) * (c.height - 4) * 1.4);
        for (let y = 0; y < Math.min(hh, c.height - 2); y++) set(x, c.height - 1 - y, col[0], col[1], col[2], 0.55);
      }
    }
  } else if (kind === "vectorscope") {
    const v = vectorscope(px, 128);
    const peak = Math.max(1, ...v) / 6;
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 128; x++) {
        const n = v[y * 128 + x];
        if (!n) continue;
        const a = Math.min(1, 0.25 + n / peak);
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) set(x * 2 + dx, y * 2 + dy, 90, 255, 150, a);
      }
  } else {
    const chans = kind === "parade" ? (["r", "g", "b"] as const) : (["luma"] as const);
    const colW = Math.floor(c.width / chans.length);
    chans.forEach((ch, ci) => {
      const wf = waveform(px, W, H, ch);
      const col = ch === "r" ? [255, 70, 70] : ch === "g" ? [70, 255, 70] : ch === "b" ? [80, 130, 255] : [120, 255, 140];
      for (let x = 0; x < W; x++)
        for (let lvl = 0; lvl < 256; lvl++) {
          const n = wf[x * 256 + lvl];
          if (!n) continue;
          const y = Math.round((1 - lvl / 255) * (c.height - 1));
          set(ci * colW + Math.floor((x / W) * colW), y, col[0], col[1], col[2], Math.min(1, 0.18 + n / 6));
        }
    });
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.font = "10px sans-serif";
  if (kind === "vectorscope") {
    ctx.beginPath();
    ctx.arc(c.width / 2, c.height / 2, c.width * 0.45, 0, Math.PI * 2);
    ctx.stroke();
    const marks: [string, number, number, number][] = [["R", 1, 0, 0], ["Y", 1, 1, 0], ["G", 0, 1, 0], ["C", 0, 1, 1], ["B", 0, 0, 1], ["M", 1, 0, 1]];
    for (const [t, r, g, b] of marks) {
      const [fx, fy] = vectorPosition(r, g, b);
      ctx.fillText(t, fx * c.width - 3, fy * c.height + 3);
    }
  } else if (kind !== "histogram") {
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const y = (1 - f) * (c.height - 1);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(c.width, y);
      ctx.stroke();
      ctx.fillText(String(Math.round(f * 100)), 2, Math.min(c.height - 2, y + 10));
    }
  }
}
