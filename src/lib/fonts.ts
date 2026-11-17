/**
 * Font loading. Any family on Google Fonts can be used by name: the stylesheet is fetched on demand
 * (the same mechanism index.html uses for Permanent Marker) and the browser downloads the font files.
 * Only the font NAME is sent to Google (fonts.googleapis.com), nothing else.
 */

// Already available: loaded by index.html, or installed on virtually every system.
const BUILTIN = new Set(
  ["permanent marker", "inter", "arial", "georgia", "impact", "courier new", "times new roman", "verdana", "helvetica", "tahoma", "trebuchet ms", "sans-serif", "serif", "monospace"]
);

const ready = new Set<string>(); // lower-cased families known to be usable
const inflight = new Map<string, Promise<void>>();

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ]{0,60}$/;

/** "open sans" -> "Open Sans". CSS font names match case-insensitively, so this is cosmetic. */
export const titleCaseFont = (s: string) =>
  s
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");

/** Fonts the user uploaded (FontFace) are already registered; remember them so we never look them up online. */
export function markFontReady(family: string) {
  ready.add(family.trim().toLowerCase());
}

function isRegistered(key: string): boolean {
  try {
    for (const f of document.fonts) {
      if (f.family.replace(/["']/g, "").trim().toLowerCase() === key && f.status !== "error") return true;
    }
  } catch {
    /* FontFaceSet not iterable here */
  }
  return false;
}

function addStylesheet(family: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}&display=swap`;
    link.onload = () => resolve();
    link.onerror = () => {
      link.remove();
      reject(new Error(`"${family}" was not found on Google Fonts (or you are offline)`));
    };
    document.head.appendChild(link);
  });
}

/**
 * Make sure a font is usable on the canvas, downloading it from Google Fonts if needed.
 * `sample` is the text that will be drawn, so the right unicode-range subsets (latin, devanagari...) are fetched.
 * Resolves to the family name to store in the project; rejects if the font cannot be found.
 */
export async function ensureFont(raw: string, sample = ""): Promise<string> {
  const family = titleCaseFont(raw);
  const key = family.toLowerCase();
  if (!SAFE_NAME.test(family)) throw new Error(`"${raw}" is not a valid font name`);

  if (!BUILTIN.has(key) && !ready.has(key) && !isRegistered(key)) {
    let p = inflight.get(key);
    if (!p) {
      p = addStylesheet(family).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    await p;
    ready.add(key);
  }

  try {
    await document.fonts.load(`48px "${family}"`, sample || "Aa");
  } catch {
    /* drawing falls back until it arrives */
  }
  return family;
}
