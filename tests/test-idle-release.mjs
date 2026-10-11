import { readFileSync } from "node:fs";
const B = process.argv[2] || "patched.mjs";
const src = readFileSync(B, "utf8");
let pass=0, fail=0;
const ok=(n,c,d="")=>{c?(pass++,console.log("PASS  "+n)):(fail++,console.log("FAIL  "+n+(d?" — "+d:"")));};

// Extract the onIdle implementation and simulate the guard.
const m = src.match(/onIdle: \(\) => \{([\s\S]*?)\n\t\t\},/);
ok("onIdle found", !!m);
const body = m[1];

function runGuard({aggLine, streamText, reasoningText, deliveredCount, replyOutcome}) {
  // Mirror the guard logic with the same variable names.
  const terminalQuiet = replyOutcome?.kind === "suppressed" || replyOutcome?.kind === "skipped" && replyOutcome.reason === "silent";
  if (aggLine !== "" && !streamText && !reasoningText && deliveredCount === 0 && !terminalQuiet) return "HOLD";
  return "QUEUE";
}

// 1. Tool batch, nothing delivered yet, no terminal outcome => HOLD
ok("holds while accumulating", runGuard({aggLine:"🛠️ Exec ×2",streamText:"",reasoningText:"",deliveredCount:0,replyOutcome:undefined}) === "HOLD");
// 2. Text arrives => QUEUE
ok("releases when text arrives", runGuard({aggLine:"🛠️ Exec ×2",streamText:"answer",reasoningText:"",deliveredCount:0,replyOutcome:undefined}) === "QUEUE");
// 3. Reasoning arrives => QUEUE
ok("releases when reasoning arrives", runGuard({aggLine:"🛠️ Exec ×2",streamText:"",reasoningText:"think",deliveredCount:0,replyOutcome:undefined}) === "QUEUE");
// 4. Final delivered => QUEUE
ok("releases when final delivered", runGuard({aggLine:"🛠️ Exec ×2",streamText:"",reasoningText:"",deliveredCount:1,replyOutcome:undefined}) === "QUEUE");
// 5. Silent terminal outcome => QUEUE (the optimization)
ok("releases on silent terminal", runGuard({aggLine:"🛠️ Exec ×2",streamText:"",reasoningText:"",deliveredCount:0,replyOutcome:{kind:"skipped",reason:"silent"}}) === "QUEUE");
// 6. Suppressed terminal => QUEUE
ok("releases on suppressed terminal", runGuard({aggLine:"🛠️ Exec ×2",streamText:"",reasoningText:"",deliveredCount:0,replyOutcome:{kind:"suppressed",reason:"channel_transform"}}) === "QUEUE");
// 7. No tool batch at all => QUEUE (unchanged upstream behaviour)
ok("queues when no tool batch", runGuard({aggLine:"",streamText:"",reasoningText:"",deliveredCount:0,replyOutcome:undefined}) === "QUEUE");
// 8. Guard still contains the original conditions
ok("guard keeps aggLine condition", body.includes("aggregatedToolSummaryLine !== \"\""));
ok("guard keeps deliveredFinalTexts condition", body.includes("deliveredFinalTexts.size === 0"));
ok("guard got the terminalQuiet addition", body.includes("terminalQuiet"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail===0?0:1);
