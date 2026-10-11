// Execution-level harness v2: run the ACTUAL aggregator from the live bundle
// against a mock streaming session. All mutable state lives in one shared
// object so closure writes are observable.
import { readFileSync } from "node:fs";

const BUNDLE = process.argv[2] || process.env.BUNDLE || "patched.mjs"; // pass the built bundle; see README
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
const builderDecl = extractDecl("buildAggregatedToolSummaryLine");
const maxCharDecl = "const AGGREGATED_TOOL_SUMMARY_MAX_CHARS = 200;";

// Shared live state; getters/setters keep the closure bound to it.
function makeShared() {
  return {
    streamingEnabled: true, renderMode: "auto",
    _streaming: null, cardOpens: 0, cardUpdates: [],
    _streamText: "", _reasoningText: "", _statusLine: "", _aggLine: "",
    counts: new Map(), visibleReplySent: false,
    startStreaming() { if (!this._streaming) { this._streaming = { active: true }; this.cardOpens++; } },
  };
}

function build(S) {
  const factory = new Function("S", `
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
    ${maxCharDecl}
    ${builderDecl}
    const buildCombinedStreamText = (thinking, answer) => {
      const parts = [aggregatedToolSummaryLine, [thinking ? "> " + thinking : "", answer].filter(Boolean).join("\\n\\n---\\n\\n")].filter(Boolean);
      return [parts.join("\\n\\n"), statusLine].filter(Boolean).join("\\n\\n");
    };
    ${parseDecl}
    ${aggDecl}
    return {
      parse: parseCollapsibleToolSummary,
      aggregate: async (entry) => {
        if (!streaming) streaming = { isActive: () => S._streaming?.active === true };
        const r = await aggregateCollapsibleToolSummary(entry);
        S._streamText = streamText; S._reasoningText = reasoningText;
        S._statusLine = statusLine; S._aggLine = aggregatedToolSummaryLine;
        return r;
      },
    };
  `);
  return factory(S);
}

// --- Fold burst ---
{
  const S = makeShared(); const api = build(S);
  await api.aggregate(api.parse({ text: "🛠️ Exec: ls -la", mediaUrls: undefined }, { kind: "tool" }));
  await api.aggregate(api.parse({ text: "🛠️ EXEC: df -h", mediaUrls: undefined }, { kind: "tool" }));
  await api.aggregate(api.parse({ text: "📖 Read: /etc/hosts", mediaUrls: undefined }, { kind: "tool" }));
  ok("3 calls collapsed into 2 keys", S.counts.size === 2, JSON.stringify([...S.counts.values()]));
  const exec = [...S.counts.values()].find(c => /exec/i.test(c.label));
  ok("Exec folded ×2 (case-insensitive)", exec?.count === 2, JSON.stringify([...S.counts.values()]));
  ok("aggregate line shows ×2", /×2/.test(S._aggLine), S._aggLine);
  ok("Read entry no multiplier", /Read/.test(S._aggLine) && !/Read ×/.test(S._aggLine), S._aggLine);
  ok("only ONE card opened across burst", S.cardOpens === 1, `opens=${S.cardOpens}`);
  ok("markVisibleReplySent invoked", S.visibleReplySent === true);
  ok("statusLine cleared by aggregation", S._statusLine === "");
  ok("card update carried the aggregate line", S.cardUpdates.some(u => /×2/.test(u)), JSON.stringify(S.cardUpdates));
  ok("deliver intercept would return true (folded)", (await api.aggregate(api.parse({ text: "🛠️ Exec: whoami", mediaUrls: undefined }, { kind: "tool" }))) === true);
}
// --- Fail-open cases ---
for (const [name, payload] of [
  ["isError", { text: "🛠️ Exec: boom", mediaUrls: undefined, isError: true }],
  ["mediaUrl", { text: "🛠️ Exec: ls", mediaUrls: undefined, mediaUrl: "http://x" }],
  ["mediaUrls nonempty", { text: "🛠️ Exec: ls", mediaUrls: ["http://x"] }],
  ["channelData", { text: "🛠️ Exec: ls", mediaUrls: undefined, channelData: { buttons: [] } }],
  ["multiline", { text: "🛠️ a\nb", mediaUrls: undefined }],
  ["plain text", { text: "hello world", mediaUrls: undefined }],
  ["oversize", { text: "🛠️ Exec: " + "x".repeat(300), mediaUrls: undefined }],
  // real-runtime discrimination: prose delivered as kind:"tool" has no mediaUrls array
  ["narration prose (no mediaUrls)", { text: "💬 Running a live test now" }],
  ["narration prose no emoji", { text: "Now running the burst" }],
]) {
  const S = makeShared(); const api = build(S);
  ok(`fail-open: ${name} not parsed`, api.parse(payload, { kind: "tool" }) === undefined);
}
// --- mode gates ---
{
  const S = makeShared(); S.renderMode = "raw"; const api = build(S);
  ok("renderMode raw => aggregate false", (await api.aggregate(api.parse({ text: "🛠️ Exec: ls", mediaUrls: undefined }, { kind: "tool" }))) === false);
  ok("renderMode raw => no card opened", S.cardOpens === 0);
}
{
  const S = makeShared(); S.streamingEnabled = false; const api = build(S);
  ok("streaming disabled => aggregate false", (await api.aggregate(api.parse({ text: "🛠️ Exec: ls", mediaUrls: undefined }, { kind: "tool" }))) === false);
}
{
  const S = makeShared(); S.startStreaming = function () {}; const api = build(S);
  const r = await api.aggregate(api.parse({ text: "🛠️ Exec: ls", mediaUrls: undefined }, { kind: "tool" }));
  ok("inactive stream => aggregate false (summary delivered normally)", r === false);
  ok("inactive stream => counts untouched", S.counts.size === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
