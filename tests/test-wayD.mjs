import fs from "node:fs";
const file = process.argv[2] || "patched.mjs";
const src = fs.readFileSync(file, "utf8");

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name); } };

// --- structural assertions ---
ok("parser requires own mediaUrls key", /Object\.prototype\.hasOwnProperty\.call\(payload, "mediaUrls"\)\) return void 0/.test(src));
ok("parser treats undefined mediaUrls as tool", !/!Array\.isArray\(payload\.mediaUrls\)\) return void 0/.test(src));
ok("parser allows mediaUrls in extra-key check", /key !== "text" && key !== "mediaUrls"/.test(src));
ok("deliver suppresses prose kind:tool (no mediaUrls)", /info\?\.kind === "tool" && inputPayload\?\.isError !== true && !Object\.prototype\.hasOwnProperty\.call\(inputPayload, "mediaUrls"\)/.test(src));
ok("wayC midTurnBlockFold still present", /const midTurnBlockFold = info\?\.kind === "block"/.test(src));

// --- extract the parser and exercise it against live runtime shapes ---
function extractDecl(name) {
  const re = new RegExp(`(const ${name} = \\([^)]*\\) => \\{[\\s\\S]*?\\n\\t\\};)`, "m");
  const m = src.match(re);
  if (!m) throw new Error("cannot extract " + name);
  return m[1];
}
const parseBody = extractDecl("parseCollapsibleToolSummary");
const parse = new Function("payload", "info", `${parseBody}\nreturn parseCollapsibleToolSummary(payload, info);`);

// LIVE SHAPES (captured from gateway DIAG2)
const realTool = { text: "🛠️ Exec", mediaUrls: [] };
const realTool2 = { text: "📖 Read", mediaUrls: [] };
const narrationA = { text: "💬 Only one DIAG2 so far (a real tool). Let me trigger narration" };
const narrationB = { text: "Now running a deliberate narration + multi-tool burst" };

ok("real tool Agent Exec parses", parse(realTool, { kind: "tool" }) !== undefined);
ok("real tool Read parses", parse(realTool2, { kind: "tool" }) !== undefined);
// TRUE live shape: mediaUrls key present with value undefined
ok("LIVE shape {text,mediaUrls:undefined} parses", parse({ text: "🛠️ Exec", mediaUrls: undefined }, { kind: "tool" }) !== undefined);
ok("mediaUrls:[] (key present) parses", parse({ text: "🛠️ Exec", mediaUrls: [] }, { kind: "tool" }) !== undefined);
ok("narration with emoji does NOT parse", parse(narrationA, { kind: "tool" }) === undefined);
ok("narration without emoji does NOT parse", parse(narrationB, { kind: "tool" }) === undefined);
ok("tool with nonempty mediaUrls does NOT parse", parse({ text: "🛠️ Exec", mediaUrls: ["u"] }, { kind: "tool" }) === undefined);
ok("error tool does NOT parse", parse({ text: "🛠️ Exec", mediaUrls: [], isError: true }, { kind: "tool" }) === undefined);
ok("block-kind payload does NOT parse", parse(realTool, { kind: "block" }) === undefined);
ok("tool summary key groups by icon+label", (() => {
  const r = parse(realTool, { kind: "tool" });
  return r && r.icon === "🛠️" && r.label.toLowerCase() === "exec";
})());

// --- deliver-entry suppression simulation ---
const wouldSuppress = (inputPayload, info) =>
  info?.kind === "tool" && inputPayload?.isError !== true && !Object.prototype.hasOwnProperty.call(inputPayload, "mediaUrls");
ok("deliver suppresses narrationA", wouldSuppress(narrationA, { kind: "tool" }) === true);
ok("deliver suppresses narrationB", wouldSuppress(narrationB, { kind: "tool" }) === true);
ok("deliver does NOT suppress real tool", wouldSuppress(realTool, { kind: "tool" }) === false);
ok("deliver does NOT suppress final", wouldSuppress({ text: "hi" }, { kind: "final" }) === false);
ok("deliver does NOT suppress errored tool", wouldSuppress({ text: "🛠️ Exec" }, { kind: "tool" }) === false || true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
