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

/* ---------- recognising "use / download this font" in chat ---------- */

const FONT_VERB = /\b(use|using|download|install|get|apply|switch|set|change|try|load|add)\b/i;
// anything that is about styling a font, not choosing one ("make the font bigger", "font size 120")
const NOT_A_FONT_NAME = /\b(size|bigger|smaller|larger|bold|italic|colou?r|shadow|outline|spacing|height|uppercase|lowercase|animation|position|px|pt)\b|\d/i;
const FILLER = new Set(
  ("download this that the a an font fonts typeface use using set change switch apply install get please pls to as my for text lyrics lyric on and it can you " +
    "could would make try with in video of new called named from google load add i want need like go back").split(" ")
);

/**
 * "BBH Bogle\ndownload this font" -> "BBH Bogle";  "use Roboto font" -> "Roboto";  "change the font to open sans" -> "open sans".
 * Returns null unless the message clearly asks for a font by name; everything else goes to the model.
 */
export function fontIntent(text: string): string | null {
  if (!/\b(fonts?|typeface)\b/i.test(text) || !FONT_VERB.test(text) || NOT_A_FONT_NAME.test(text)) return null;
  const words = text
    .replace(/["'`:,.!?;()]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w.toLowerCase()));
  if (!words.length || words.length > 5) return null;
  const name = words.join(" ");
  return SAFE_NAME.test(name) ? name : null;
}

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
