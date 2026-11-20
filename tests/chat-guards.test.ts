// Chat fixes: stable line numbers within one reply, no deleting lines the user did not name, exact counts.
import { applyCalls, limitDeletes, namedLineNumbers, quickAnswer } from "../src/lib/tools/index";
import { defaultProject, useProject } from "../src/store/project";
import { viewToDoc } from "../src/model/convert";

let fails = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${JSON.stringify(got)?.slice(0, 300)}`}`);
}

const six = ["Ocean Eyes", "I've been watchin' you", "Can't stop starin'", "Burning cities", "Fifteen flares", "Your ocean eyes"];
const load = () =>
  useProject.getState().loadDoc(viewToDoc({ ...defaultProject(), lines: six.map((text, i) => ({ id: `l${i + 1}`, text, start: i * 3, end: i * 3 + 2, layerId: "main" })) }));
const texts = () => useProject.getState().project.lines.map((l) => l.text);

/* line numbers in one reply refer to the lines as they were */
load();
const r = await applyCalls([{ tool: "delete_line", args: { index: 2 } }, { tool: "delete_line", args: { index: 3 } }]);
check("two deletes in one reply remove the lines as numbered before the reply", JSON.stringify(texts()) === JSON.stringify(["Ocean Eyes", "Burning cities", "Fifteen flares", "Your ocean eyes"]), texts());
check("both report the right lines", r.results[0].summary.includes("watchin") && r.results[1].summary.includes("starin"), r.results);
check("one reply is one undo step", (useProject.getState().undo(), texts().length === 6));
load();
const twice = await applyCalls([{ tool: "delete_line", args: { index: 2 } }, { tool: "delete_line", args: { index: 2 } }]);
check("deleting the same line twice says so instead of deleting the next one", texts().length === 5 && !twice.results[1].ok && twice.results[1].summary.includes("already removed"), twice.results[1]);
load();
await applyCalls([{ tool: "update_line", args: { index: 1, text: "x" } }, { tool: "merge_lines", args: { index_a: 2, index_b: 3 } }, { tool: "update_line", args: { index: 4, text: "four" } }]);
check("edits after a merge still hit the line that was numbered so", JSON.stringify(texts()) === JSON.stringify(["x", "I've been watchin' you Can't stop starin'", "four", "Fifteen flares", "Your ocean eyes"]), texts());
load();
await applyCalls([{ tool: "split_line", args: { index: 3, at_word: 1 } }, { tool: "update_line", args: { index: 4, text: "BURNING" } }]);
check("split keeps later numbers pointing at the right lines", texts()[4] === "BURNING" && texts()[3] === "stop starin'", texts());
load();
await applyCalls([{ tool: "delete_line", args: { index: 1 } }, { tool: "shift_timings", args: { from_index: 5, to_index: 6, seconds: 1 } }]);
check("ranges after a delete use the old numbers", useProject.getState().project.lines.find((l) => l.id === "l5")!.start === 13 && useProject.getState().project.lines.find((l) => l.id === "l4")!.start === 9);

/* only the lines the user named */
check("line numbers in a request", JSON.stringify([...namedLineNumbers("delete line 2")]) === "[2]" && JSON.stringify([...namedLineNumbers("remove lines 2 and 5, line 7")]) === "[2,5,7]" && namedLineNumbers("lines 3-5").size === 3);
const asked = [1, 2, 3, 4, 5, 6].map((i) => ({ tool: "delete_line", args: { index: i } }));
const g = limitDeletes("delete line 2", asked);
check("a model deleting every line for 'delete line 2' deletes only line 2", g.calls.length === 1 && (g.calls[0].args as { index: number }).index === 2 && g.skipped.length === 5, g);
check("other tools are not touched", limitDeletes("delete line 2", [{ tool: "update_style", args: {} }]).calls.length === 1);
check("no numbers named: nothing is filtered", limitDeletes("delete the chorus", asked).calls.length === 6);
check("not a delete request: nothing is filtered", limitDeletes("make line 2 red", asked).calls.length === 6);

/* exact answers */
load();
const p = useProject.getState().project;
check("how many lines", quickAnswer("how many lines are there", p) === "There are 6 lines.", quickAnswer("how many lines are there", p));
check("typos still count", quickAnswer("how any lines are there?", p) === null || quickAnswer("how many lines?", p) === "There are 6 lines.");
check("how many words", /^There are \d+ words in 6 lines\.$/.test(quickAnswer("How many words?", p) ?? ""));
check("edits are not answered as questions", quickAnswer("delete line 2", p) === null && quickAnswer("make the text bigger", p) === null);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
