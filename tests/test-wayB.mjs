// 方式 B verification: single-line, bounded aggregate summary.
// Runs the ACTUAL builder + aggregate fn from the bundle against mock state.
import { readFileSync } from "node:fs";

const BUNDLE = process.argv[2] || "patched.mjs";
const src = readFileSync(BUNDLE, "utf8");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`PASS  ${n}`)) : (fail++, console.log(`FAIL  ${n}${d ? " — " + d : ""}`)); };

function extractDecl(name) {
  const start = src.indexOf(`const ${name} = `);
  if (start < 0) throw new Error("missing " + name);
  const brace = src.indexOf("{", src.indexOf("=>", start));
  let depth = 0, i = brace;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (!depth) break; } }
  return src.slice(start, i + 1) + ";";
}

const parseDecl = extractDecl("parseCollapsibleToolSummary");
const aggDecl = extractDecl("aggregateCollapsibleToolSummary");
// Builder has no `=>`, it's `const X = () => {...}` — extract by same routine works.
const builderDecl = extractDecl("buildAggregatedToolSummaryLine");
const maxCharsDecl = "const AGGREGATED_TOOL_SUMMARY_MAX_CHARS = 200;";

function build(S) {
  return new Function("S", `
    const streamingEnabled = S.streamingEnabled;
    const renderMode = S.renderMode;
    const startStreaming = () => S.startStreaming();
    const markVisibleReplySent = () => { S.visibleReplySent = true; };
    const flushStreamingCardUpdate = (c) => S.cardUpdates.push(c);
    const streamingStartPromise = null;
    let streaming = null;
    let streamText = "";
    let reasoningText = "";
    let statusLine = "";
    let aggregatedToolSummaryLine = "";
    const aggregatedToolSummaryCounts = S.counts;
    const buildCombinedStreamText = (t, a) => {
      const parts = [aggregatedToolSummaryLine, [t ? "> " + t : "", a].filter(Boolean).join("\\n\\n---\\n\\n")].filter(Boolean);
      return [parts.join("\\n\\n"), statusLine].filter(Boolean).join("\\n\\n");
    };
    ${maxCharsDecl}
    ${builderDecl}
    ${parseDecl}
    ${aggDecl}
    return {
      parse: parseCollapsibleToolSummary,
      aggregate: async (entry) => {
        if (!streaming) streaming = { isActive: () => S._active === true };
        const r = await aggregateCollapsibleToolSummary(entry);
        S._aggLine = aggregatedToolSummaryLine;
        return r;
      },
      rebuild: () => { aggregatedToolSummaryLine = buildAggregatedToolSummaryLine(); S._aggLine = aggregatedToolSummaryLine; return aggregatedToolSummaryLine; },
    };
  `)(S);
}

function mkS() {
  return { streamingEnabled: true, renderMode: "auto", _active: true, counts: new Map(), cardUpdates: [], visibleReplySent: false,
    startStreaming() { this._active = true; } };
}

// --- 1. Same-tool burst folds to one segment ---
{
  const S = mkS(); const api = build(S);
  for (let i = 0; i < 4; i++) await api.aggregate(api.parse({ text: "🛠️ Exec: cmd" + i, mediaUrls: undefined }, { kind: "tool" }));
  const line = api.rebuild();
  ok("4x same tool => single line", !line.includes("\n"), JSON.stringify(line));
  ok("4x same tool => shows total 4", /4 tools/.test(line), line);
  ok("4x same tool => shows ×4", /×4/.test(line), line);
}

// --- 2. The regression case: 19 DISTINCT labels must stay ONE line ---
{
  const S = mkS(); const api = build(S);
  const labels = ["Exec","Read","Grep","Sed","Cat","Diff","Sha256sum","Node","Journalctl","Ls","Python3",
                  "Git","Awk","Find","Sort","Head","Tail","Wc","Xargs"];
  for (const l of labels) await api.aggregate(api.parse({ text: `🛠️ ${l}: something`, mediaUrls: undefined }, { kind: "tool" }));
  const line = api.rebuild();
  ok("19 distinct labels => ONE line (no newline)", !line.includes("\n"), JSON.stringify(line));
  ok("19 distinct labels => bounded <= 200 chars", line.length <= 200, `len=${line.length}`);
  ok("19 distinct labels => shows total 19", /19 tools/.test(line), line);
  ok("19 distinct labels => truncation marker present", /…\+\d+ more/.test(line), line);
  // must not blow the card
  ok("19 distinct labels => fits card single-line budget", line.length < 240, `len=${line.length}`);
}

// --- 3. Two distinct types ---
{
  const S = mkS(); const api = build(S);
  await api.aggregate(api.parse({ text: "🛠️ Exec: a", mediaUrls: undefined }, { kind: "tool" }));
  await api.aggregate(api.parse({ text: "🛠️ EXEC: b", mediaUrls: undefined }, { kind: "tool" }));
  await api.aggregate(api.parse({ text: "📖 Read: c", mediaUrls: undefined }, { kind: "tool" }));
  const line = api.rebuild();
  ok("2 types => single line", !line.includes("\n"), JSON.stringify(line));
  ok("2 types => total 3", /3 tools/.test(line), line);
  ok("2 types => Exec ×2", /×2/.test(line), line);
}

// --- 4. Single tool: no prefix, just the segment ---
{
  const S = mkS(); const api = build(S);
  await api.aggregate(api.parse({ text: "🛠️ Exec: loner", mediaUrls: undefined }, { kind: "tool" }));
  const line = api.rebuild();
  ok("single tool => no 'N tools' prefix", !/tools:/.test(line), line);
  ok("single tool => single line", !line.includes("\n"));
}

// --- 5. Extreme: very long labels must still be one bounded line ---
{
  const S = mkS(); const api = build(S);
  for (let i = 0; i < 30; i++) await api.aggregate(api.parse({ text: `🛠️ ${"L".repeat(70)}${i}: x`, mediaUrls: undefined }, { kind: "tool" }));
  const line = api.rebuild();
  ok("30 long labels => ONE line", !line.includes("\n"), JSON.stringify(line).slice(0, 120));
  ok("30 long labels => bounded <= 200", line.length <= 200, `len=${line.length}`);
}

// --- 6. Fail-open unchanged ---
{
  const S = mkS(); const api = build(S);
  ok("isError still fail-open", api.parse({ text: "🛠️ Exec: x", mediaUrls: undefined, isError: true }, { kind: "tool" }) === undefined);
  ok("media still fail-open", api.parse({ text: "🛠️ Exec: x", mediaUrls: undefined, mediaUrl: "u" }, { kind: "tool" }) === undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
