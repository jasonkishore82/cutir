import { z } from "zod";
import { defineTool } from "./registry";
import { Aspect, color, num } from "./schema";

export const setBackground = defineTool({
  name: "set_background",
  group: "scene",
  description: "Set a gradient background (colors as hex, angle in degrees) or keep the uploaded asset",
  // flat on purpose: small models handle one flat object far better than a oneOf union
  params: z
    .object({
      type: z.enum(["gradient", "asset"]),
      colors: z.array(color).min(2).max(6).optional(),
      angle: num(0, 360).optional(),
    })
    .superRefine((a, ctx) => {
      if (a.type === "gradient" && !a.colors) ctx.addIssue({ code: "custom", path: ["colors"], message: "gradient needs colors (2 to 6)" });
    }),
  hint: "type 'gradient' needs colors[]",
  // models often omit `type` when they only send colors
  normalize: (args) =>
    args && typeof args === "object" && !("type" in args) && "colors" in args ? { type: "gradient", ...(args as object) } : args,
  apply: (p, a) => {
    if (a.type === "gradient") {
      const noise = p.background.type === "gradient" ? p.background.noise : true;
      const angle = a.angle ?? 135;
      const colors = a.colors!;
      return { project: { ...p, background: { type: "gradient", colors, angle, noise } }, summary: `gradient ${colors.join(" > ")} @${angle}deg` };
    }
    if (p.background.type === "asset" && p.background.asset) return { project: p, summary: "background asset kept" };
    throw new Error("no background file is loaded; ask the user to upload one in the left panel");
  },
});

export const setAspect = defineTool({
  name: "set_aspect",
  group: "scene",
  description: "Set the aspect ratio",
  params: z.object({ ratio: Aspect }),
  apply: (p, a) => ({ project: { ...p, aspect: a.ratio }, summary: `aspect ${a.ratio}` }),
});

export const sceneTools = [setBackground, setAspect];
