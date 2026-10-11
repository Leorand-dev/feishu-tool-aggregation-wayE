import fs from "node:fs";
const file = process.argv[2] || "patched.mjs";
const src = fs.readFileSync(file, "utf8");

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name); } };

// 1. midTurnBlockFold guard exists
ok("midTurnBlockFold declared", /const midTurnBlockFold = info\?\.kind === "block"/.test(src));
ok("midTurnBlockFold requires active streaming", /streaming\?\.isActive\(\) === true/.test(src));
ok("midTurnBlockFold requires tool batch", /aggregatedToolSummaryLine !== "" \|\| aggregatedToolSummaryCounts\.size > 0/.test(src));
ok("midTurnBlockFold excludes raw mode", /renderMode !== "raw"/.test(src));
ok("cardRenderingRequested includes fold", /shouldUseFeishuCard\(text\) \|\| midTurnBlockFold/.test(src));

// 2. simulate the decision with the extracted expression
const decide = ({kind, renderMode, streamingEnabled, isActive, aggLine, countsSize, coreBlock, hasPresentationFallback, shouldUseCard, hasText, exceeds}) => {
  const text = "";
  const finalTextExceedsStreamingLimit = kind === "final" && hasText && exceeds;
  const midTurnBlockFold = kind === "block" && renderMode !== "raw" && streamingEnabled && isActive === true && (aggLine !== "" || countsSize > 0);
  const cardRenderingRequested = renderMode === "card" || (kind === "block" && coreBlock && renderMode !== "raw") || (renderMode === "auto" && shouldUseCard) || midTurnBlockFold;
  const useStaticCard = hasText && cardRenderingRequested;
  const useStreamingCard = hasText && streamingEnabled && !finalTextExceedsStreamingLimit && (kind === "final" || cardRenderingRequested);
  const strayPost = hasPresentationFallback || (kind === "block" && !useStreamingCard);
  return { cardRenderingRequested, useStreamingCard, strayPost };
};

// narration block, mid-turn, streaming active, tool batch accumulated, no table/code
const r1 = decide({kind:"block", renderMode:"auto", streamingEnabled:true, isActive:true, aggLine:"🛠 12 tools: ...", countsSize:3, coreBlock:false, hasPresentationFallback:false, shouldUseCard:false, hasText:true, exceeds:false});
ok("narration mid-turn block does NOT stray-post", r1.strayPost === false);
ok("narration mid-turn block becomes streaming card", r1.useStreamingCard === true);

// block with NO tool batch, no streaming active => still stray (unchanged behavior)
const r2 = decide({kind:"block", renderMode:"auto", streamingEnabled:true, isActive:false, aggLine:"", countsSize:0, coreBlock:false, hasPresentationFallback:false, shouldUseCard:false, hasText:true, exceeds:false});
ok("plain block without tool batch still posts (unchanged)", r2.strayPost === true);

// raw mode => no fold
const r3 = decide({kind:"block", renderMode:"raw", streamingEnabled:true, isActive:true, aggLine:"x", countsSize:1, coreBlock:false, hasPresentationFallback:false, shouldUseCard:false, hasText:true, exceeds:false});
ok("raw mode does not fold", r3.strayPost === true);

// final => unaffected
const r4 = decide({kind:"final", renderMode:"auto", streamingEnabled:true, isActive:true, aggLine:"x", countsSize:1, coreBlock:false, hasPresentationFallback:false, shouldUseCard:false, hasText:true, exceeds:false});
ok("final kind unaffected", r4.strayPost === false && r4.useStreamingCard === true);

// presentation fallback always posts
const r5 = decide({kind:"block", renderMode:"auto", streamingEnabled:true, isActive:true, aggLine:"x", countsSize:1, coreBlock:false, hasPresentationFallback:true, shouldUseCard:false, hasText:true, exceeds:false});
ok("presentation fallback still posts", r5.strayPost === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
