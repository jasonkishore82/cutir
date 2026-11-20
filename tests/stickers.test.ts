// Doodle stickers (src/lib/stickers.ts).
import { SHAPES, addSticker, autoDoodles, clearStickers, doodleFor, removeSticker, updateSticker } from "../src/lib/stickers";
import { defaultProject, type LyricLine, type Project } from "../src/store/project";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 400)}`}`);
}

const texts = ["I feel the fire tonight", "nothing here", "Love me like you do", "Let's go dancing"];
const lines: LyricLine[] = texts.map((t, i) => ({ id: `l${i}`, text: t, start: i * 2, end: i * 2 + 2 }));
const base: Project = { ...defaultProject(), lines };

check("every shape has a drawing", SHAPES.every((s) => s.fill || s.line));
check("words pick a doodle", doodleFor("my heart") === "heart" && doodleFor("on fire") === "flame" && doodleFor("hello") === undefined);

const a = addSticker(base, ["l1"], "star");
check("adds a sticker to the chosen line only", a.lines[1].stickers?.length === 1 && !a.lines[0].stickers && a.lines[1].stickers![0].shape === "star");
const a2 = addSticker(a, ["l1"], "heart");
check("the second sticker takes another spot", a2.lines[1].stickers!.length === 2 && a2.lines[1].stickers![0].x !== a2.lines[1].stickers![1].x || a2.lines[1].stickers![0].y !== a2.lines[1].stickers![1].y);
check("an unknown shape adds nothing", addSticker(base, ["l1"], "nope").lines[1].stickers === undefined);

const id = a.lines[1].stickers![0].id;
check("update changes one sticker", updateSticker(a, "l1", id, { size: 0.4 }).lines[1].stickers![0].size === 0.4);
check("removing the last sticker drops the field", removeSticker(a, "l1", id).lines[1].stickers === undefined);

const auto = autoDoodles(base);
check("auto doodles match the lyrics", auto.added === 3 && !auto.project.lines[1].stickers && auto.project.lines[0].stickers![0].shape === "flame" && auto.project.lines[2].stickers![0].shape === "heart", auto.project.lines.map((l) => l.stickers?.[0]?.shape));
check("auto doodles can be limited to lines", autoDoodles(base, ["l0"]).added === 1);
check("clear removes them", clearStickers(auto.project).lines.every((l) => !l.stickers));
check("the original project is untouched", base.lines.every((l) => !l.stickers));

if (fails) process.exit(1);
console.log("all passed");
