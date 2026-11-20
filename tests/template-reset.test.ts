// Applying a template replaces the whole look: nothing is left over from the template applied before.
import { BUILTIN_TEMPLATES, applyTemplateTo } from "../src/lib/templates";
import { defaultProject } from "../src/store/project";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 400)}`}`);
}

const byId = (id: string) => BUILTIN_TEMPLATES.find((t) => t.id === id)!;
const target = { scope: "project" } as const;

let p = defaultProject();
p = applyTemplateTo(p, target, byId("rainbow-arch"));
check("rainbow arch sets the arch", p.style.arch === 100 && p.style.fitWidth === 0.8, p.style);
p = applyTemplateTo(p, target, byId("echo-stack"));
check("echo stack clears the arch and fit", !p.style.arch && !p.style.fitWidth, p.style);
check("echo stack sets its echoes", p.style.ghostEcho === true && p.style.ghosts === 3);
p = applyTemplateTo(p, target, byId("green-tag"));
check("green tag clears the echoes", !p.style.ghosts && !p.style.ghostEcho, p.style);
check("green tag sets its label", p.style.labelColor === "#1f8f3e");
p = applyTemplateTo(p, target, byId("minimal"));
check("a plain template clears the label and rotation", !p.style.labelColor && !p.style.transform.rotation, p.style);
p = applyTemplateTo(p, target, byId("paint-fill"));
p = applyTemplateTo(p, target, byId("karaoke"));
check("karaoke clears fill-up and fit", !p.style.fillColor && !p.style.fitWidth, p.style);
p = applyTemplateTo(p, target, byId("left-stack"));
p = applyTemplateTo(p, target, byId("karaoke"));
check("karaoke clears left alignment", !p.style.align || p.style.align === "center", p.style.align);

if (fails) process.exit(1);
console.log("all passed");
