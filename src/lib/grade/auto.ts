/** Auto balance and the round colour wheel mapping (phase 20). Pure functions, no canvas. */

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The grade params an auto balance sets (everything else is left alone). */
export type AutoBalance = { gainR: number; gainG: number; gainB: number; gainM: number; offsetM: number };

/**
 * Gray-world white balance plus a levels stretch, from the RGBA bytes of a frame. Channel means ignore near-black and
 * near-white pixels so clipped areas do not pull the balance. The stretch brings the 99th percentile of luma near 0.95
 * and the 1st near 0.
 */
export function autoBalance(data: Uint8ClampedArray): AutoBalance {
  const sum = [0, 0, 0];
  let count = 0;
  const hist = new Uint32Array(256);
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    hist[Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)]++;
    total++;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (mx > 245 || mx < 10 || mn > 245) continue;
    sum[0] += r;
    sum[1] += g;
    sum[2] += b;
    count++;
  }
  if (!total) return { gainR: 0, gainG: 0, gainB: 0, gainM: 0, offsetM: 0 };
  let gain: [number, number, number] = [0, 0, 0];
  if (count) {
    const mean = sum.map((s) => s / count);
    const target = (mean[0] + mean[1] + mean[2]) / 3;
    gain = mean.map((m) => (m > 1 ? clamp((target / m - 1) * 100, -60, 60) : 0)) as [number, number, number];
  }
  const pct = (q: number) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= q * total) return v / 255;
    }
    return 1;
  };
  const lo = pct(0.01);
  const hi = pct(0.99);
  const gainM = hi > 0.05 ? clamp((0.95 / hi - 1) * 100, -40, 60) : 0;
  const offsetM = clamp((-lo * 100) / 0.25, -40, 0);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return { gainR: r1(gain[0]), gainG: r1(gain[1]), gainB: r1(gain[2]), gainM: r1(gainM), offsetM: r1(offsetM) };
}

/**
 * A wheel puck position (x, y in -1..1, y up) as R, G, B deltas in -100..100 that sum to zero: the angle picks the
 * hue (red to the right-up, green left-up, blue down), the distance picks the strength.
 */
export function wheelToRgb(x: number, y: number): [number, number, number] {
  const len = Math.hypot(x, y);
  if (len < 1e-9) return [0, 0, 0];
  const k = len > 1 ? 1 / len : 1;
  const ux = x * k;
  const uy = y * k;
  // unit vectors for red, green, blue at 30, 150, 270 degrees; project the puck onto each
  const axes: [number, number][] = [[Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)], [Math.cos((5 * Math.PI) / 6), Math.sin((5 * Math.PI) / 6)], [0, -1]];
  return axes.map(([ax, ay]) => Math.round((ux * ax + uy * ay) * (100 * 2 / 3) * 10) / 10) as [number, number, number];
}

/** The puck position for R, G, B deltas (the inverse of wheelToRgb for sum-zero input). */
export function rgbToWheel(r: number, g: number, b: number): [number, number] {
  const axes: [number, number][] = [[Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)], [Math.cos((5 * Math.PI) / 6), Math.sin((5 * Math.PI) / 6)], [0, -1]];
  const s = 1 / (100 * 2 / 3);
  const x = (r * axes[0][0] + g * axes[1][0] + b * axes[2][0]) * s * (2 / 3);
  const y = (r * axes[0][1] + g * axes[1][1] + b * axes[2][1]) * s * (2 / 3);
  const len = Math.hypot(x, y);
  return len > 1 ? [x / len, y / len] : [x, y];
}
