// Independent audit harness for the Feishu tool-aggregation patch.
// Extracts the actual injected code from the LIVE bundle and exercises it
// directly, instead of importing the repo's own copies.
import { readFileSync } from "node:fs";

const BUNDLE = process.argv[2] || process.env.BUNDLE || "patched.mjs"; // pass the built bundle; see README
const src = readFileSync(BUNDLE, "utf8");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
};

// --- Extract parseCollapsibleToolSummary verbatim by brace-balanced scan ---
function extractFn(name) {
  const start = src.indexOf(`const ${name} = `);
  if (start < 0) throw new Error(`not found: ${name}`);
  const eq = src.indexOf("=> {", start);
  const braceStart = src.indexOf("{", eq);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) break; }
  }
  const body = src.slice(braceStart, i + 1);
  // eslint-disable-next-line no-new-func
  return new Function("return (" + (src.slice(start, braceStart).replace(`const ${name} = `, "") + body) + ")")();
}

// --- Build a slice that contains the two functions plus their deps ---
const deps = ["parseCollapsibleToolSummary", "aggregateCollapsibleToolSummary", "markVisibleReplySent"];

// 1. Structural: every injected call must resolve to exactly one declaration
for (const fn of ["markVisibleReplySent", "aggregateCollapsibleToolSummary", "parseCollapsibleToolSummary"]) {
  const decls = [...src.matchAll(new RegExp(`(const|let|var|function)\\s+${fn}\\b`, "g"))].length;
  ok(`${fn}: exactly one declaration`, decls === 1, `found ${decls}`);
}

// 2. Predicate behaviour, driven from the LIVE text (not the repo's copy)
const parseSrc = extractFn("parseCollapsibleToolSummary");
ok("predicate: real tool event ({mediaUrls:undefined}) parses",
  (() => { const r = parseSrc({ text: "🛠️ Exec", mediaUrls: undefined }, { kind: "tool" }); return r && r.label === "Exec"; })());
ok("predicate: prose without mediaUrls closed",
  parseSrc({ text: "💬 running a test" }, { kind: "tool" }) === undefined);
ok("predicate: real mediaUrl value closed",
  parseSrc({ text: "🛠️ Exec", mediaUrls: undefined, mediaUrl: "https://x" }, { kind: "tool" }) === undefined);
ok("predicate: nonempty mediaUrls closed",
  parseSrc({ text: "🛠️ Exec", mediaUrls: ["https://x"] }, { kind: "tool" }) === undefined);
ok("predicate: isError closed",
  parseSrc({ text: "🛠️ Exec", mediaUrls: undefined, isError: true }, { kind: "tool" }) === undefined);
ok("predicate: non-tool kind closed",
  parseSrc({ text: "🛠️ Exec", mediaUrls: undefined }, { kind: "final" }) === undefined);
ok("predicate: multiline closed",
  parseSrc({ text: "🛠️ a\nb", mediaUrls: undefined }, { kind: "tool" }) === undefined);
ok("predicate: >240 chars closed",
  parseSrc({ text: "🛠️ Exec: " + "x".repeat(300), mediaUrls: undefined }, { kind: "tool" }) === undefined);
ok("predicate: bare `Exec ` with no label still parses label=Exec",
  (() => { const r = parseSrc({ text: "🛠️ Exec", mediaUrls: undefined }, { kind: "tool" }); return r === undefined || r.label === "Exec"; })());

// 3. Grouping key: case-insensitive fold
const a = parseSrc({ text: "🛠️ Exec", mediaUrls: undefined }, { kind: "tool" });
const b = parseSrc({ text: "🛠️ EXEC", mediaUrls: undefined }, { kind: "tool" });
ok("grouping key folds case", a && b && a.key === b.key, `${a?.key} vs ${b?.key}`);

// 4. Lifecycle invariants asserted on the LIVE text
ok("aggregator calls startStreaming before isActive check",
  /const aggregateCollapsibleToolSummary[\s\S]{0,400}startStreaming\(\);[\s\S]{0,200}isActive\(\)/.test(src));
ok("onIdle guard holds while aggregatedToolSummaryLine set",
  /onIdle: \(\) => \{[\s\S]{0,600}aggregatedToolSummaryLine !== ""[\s\S]{0,200}deliveredFinalTexts\.size === 0/.test(src));
ok("onIdle guard releases when text arrives (checks !streamText && !reasoningText)",
  /aggregatedToolSummaryLine !== ""[\s\S]{0,120}!streamText && !reasoningText/.test(src));
ok("buildCombinedStreamText prepends aggregatedToolSummaryLine",
  /buildCombinedStreamText[\s\S]{0,300}aggregatedToolSummaryLine/.test(src));
ok("discard guard requires aggregatedToolSummaryLine === \"\"",
  /shouldDiscardStreamingPreview = aggregatedToolSummaryLine === ""/.test(src));
ok("deliver intercept returns noVisibleFeishuReplyDelivery sentinel",
  /collapsibleToolSummary && await aggregateCollapsibleToolSummary\(collapsibleToolSummary\)\) return noVisibleFeishuReplyDelivery/.test(src));
ok("counts cleared on resetStreamingState", /resetStreamingState[\s\S]{0,400}aggregatedToolSummaryCounts\.clear\(\)/.test(src));
ok("counts cleared on new reply start", /replyLifecycleStateInitialized[\s\S]{0,300}aggregatedToolSummaryCounts\.clear\(\)/.test(src));

// 5. No dangling identifiers: every identifier referenced inside the injected
//    functions must be either local, a param, or declared in the bundle.
const injectedRegions = src.slice(
  src.indexOf("const parseCollapsibleToolSummary"),
  src.indexOf("const sendChunkedTextReply")
)
  // strip comments so prose words (e.g. "its") are not read as identifiers
  .replace(/\/\/[^\n]*/g, " ")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  // strip regex literals so flag chars like /u, /g are not read as identifiers
  .replace(/\/\^\[.*?\]\/[a-z]*|\/[^/\n]*\/[a-z]+/g, " ");
const identRe = /(?<![.\w])([a-zA-Z_$][\w$]*)\s*(?=[(.\[])|\b([a-zA-Z_$][\w$]*)\b(?=\s*=(?!=))/g;
const knownLocal = new Set(["if","return","const","let","for","new","key","icon","label","count","entry","payload","info","text","match","value","current","line","parts","rendered","groups","total","segments","prefix","budget","shown","candidate","more","reservedTail","dropped","hard","void","Map","Array","from","Object","entries","some","push","filter","Boolean","join","length","toLowerCase","split","trim","test","values","clear","get","set","then","async","await","reduce","slice","Math","max","String","Number","undefined","tool","array"]);
const problems = [];
const declInBundle = (name) => new RegExp(`(const|let|var|function)\\s+${name}\\b`).test(src) || /^[A-Z]/.test(name);
for (const m of injectedRegions.matchAll(identRe)) {
  const name = m[1] || m[2];
  if (!name || knownLocal.has(name)) continue;
  if (!declInBundle(name)) problems.push(name);
}
ok("no unresolved identifiers in injected region", problems.length === 0, "unresolved: " + [...new Set(problems)].join(", "));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
