# feishu-tool-aggregation-wayE

A source patch for the OpenClaw Feishu channel plugin that folds tool-call
summaries into a single bounded chat card and stops interleaved assistant
narration from leaking out as separate message bubbles.

This is a **new, self-contained** patch set. It supersedes the earlier
aggregation experiments and packages the final behaviour as one patch against a
pristine plugin bundle.

## What it fixes

When the agent runs several tools in a row, the Feishu plugin used to emit one
line per tool and let mid-turn narration escape as its own bubble. Users saw a
wall of separate messages instead of one tidy status card.

Observed symptoms:

- A multi-tool turn produced many standalone bubbles (one per tool or label).
- Assistant narration written between tool calls appeared as extra bubbles.

## Root cause (from live gateway data)

The plugin routes two very different payloads through the same `kind:"tool"`
delivery path:

| payload | keys | example |
| --- | --- | --- |
| a genuine tool-summary event | `[text, mediaUrls]` — the **`mediaUrls` key is present, value `undefined`** | `🛠️ Exec` |
| assistant prose / narration | `[text]` — **no `mediaUrls` key at all** | `💬 let me run a burst` |

The original parser only checked "starts with an emoji + single line + ≤240
chars", so short narration was miscounted as a tool, and anything that failed the
shape check fell through to a standalone reply. The discriminating signal is
**presence of the `mediaUrls` key**, not its value:

- `Array.isArray(undefined)` is `false`, so a value-based check wrongly rejects
  real tool events (this is what an earlier, rejected revision did).

## The patch (7 hunks)

1. **`markVisibleReplySent` helper** — restores the symbol the aggregator needs.
2. **Parser discriminator** — accept `kind:"tool"` only when an own `mediaUrls`
   key exists; ignore its empty value; stop treating narration as a tool.
3. **`buildAggregatedToolSummaryLine()`** — build the summary as one bounded line
   (budget `AGGREGATED_TOOL_SUMMARY_MAX_CHARS = 200`), collapsing extra groups
   into a trailing `, …+N more` instead of joining with newlines.
4. **Bounded line wired in** — the aggregator now uses the bounded builder.
5. **Card hold across a tool batch** — keep the streaming card open while a tool
   batch accumulates, and release it on a terminal non-text outcome so a
   tool-only turn cannot leave the card open forever.
6. **Delivery guard for prose** — a `kind:"tool"` payload without the `mediaUrls`
   key is narration; suppress it (`noVisibleFeishuReplyDelivery`) so it never
   becomes a standalone bubble.
7. **Mid-turn block fold** — a `kind:"block"` narration emitted mid tool-batch
   folds into the active card instead of a new bubble.

## Version table

| plugin build | patch file | pristine sha256 | patched sha256 |
| --- | --- | --- | --- |
| `@openclaw/feishu` 2026.10.5 | `patches/2026.10.5/feishu-tool-aggregation.patch` | `72a0a198…3bfe` | `3e0b7819…c17a` |
| `@openclaw/feishu` 2026.10.2 | `patches/2026.10.2/feishu-tool-aggregation-wayE.patch` | `8ae0e845…5eac` | `97ca5ce4…d867` |
| `@openclaw/feishu` 2026.10.1 | `patches/2026.10.1/feishu-tool-aggregation-wayE.patch` | `9bbbd0c3…d2d9` | `8cbe577b…4644` |

Each entry targets one exact plugin build. The installer selects the patch by
matching the target's sha256, so a newer release is a new build: re-derive the
patch for it (the 2026.10.2 port was re-anchored against that build's streaming
refactor). A different build is refused rather than mis-applied.

## Install

```sh
# point at the installed monitor bundle (glob resolves per install)
TARGET=$(ls ~/.openclaw/npm/projects/*/node_modules/@openclaw/feishu/dist/.setup/monitor.account-*.mjs | head -1)
./install.sh "$TARGET"
# then restart the gateway
```

The installer detects the target build by hash, backs up the original, applies
the matching patch, and verifies the result hash. It is idempotent — running it
twice reports `already patched`.

## Verify

```sh
cd patches && sha256sum -c SHA256SUMS                # all bundles + patches intact
cd ../tests
V=../patches/2026.10.2/patched.mjs                   # or 2026.10.1/patched.mjs
node test-wayD.mjs $V      # live-shape discriminator (20)
node test-wayC.mjs $V      # mid-turn block fold     (11)
node test-wayB.mjs $V      # bounded summary line    (17)
node exec-agg.mjs  $V      # execution harness       (23)
node test-idle-release.mjs $V  # card-release        (11)
node audit-agg.mjs $V      # structural audit        (22)
```

All suites must pass. They read the bundle path from `argv[2]` (or
`BUNDLE`), so you can point them at an installed file to audit the live copy.

## Revert

```sh
TARGET=$(ls ~/.openclaw/npm/projects/*/node_modules/@openclaw/feishu/dist/.setup/monitor.account-*.mjs | head -1)
cp -p "$(dirname "$TARGET")/.monitor.backup-*.mjs" "$TARGET"
```

Or reinstall the plugin to restore the pristine bundle.

## 2026.10.5: waiting-only progress line

The 2026.10.5 port changes what the card shows. Earlier ports folded per-tool
lines into a summary such as `🛠️ 3 tools: 🛠️ Exec ×3`. That summary is gone; the
card now carries a single bounded progress line:

```
⏳ 已执行 3 个工具，等待中…
```

Tool labels, per-tool counts and the "running X…" phase line are all removed.
The chat surface is: no bubbles outside the card, one waiting line inside it.

### Requires `verboseLevel: on`

This is the one hard prerequisite. With `verboseLevel: off` tool events never
reach the plugin's `deliver` / `onItemEvent` hooks, so nothing is aggregated and
no progress line appears. Enable it per session:

```sh
openclaw gateway call sessions.patch \
  --params '{"key":"agent:main:main","verboseLevel":"on"}'
```

That override is **per session**. New sessions fall back to the default.

### What changed against 2026.10.2

| area | 2026.10.2 | 2026.10.5 |
| --- | --- | --- |
| card body | `🛠️ N tools: 🛠️ Exec ×3` summary | `⏳ 已执行 N 个工具，等待中…` |
| bare-label payloads | not recognised | `parseBareToolLabel` + `BARE_TOOL_LABELS` whitelist |
| card/tool race | progress line could be dropped | backfilled once `session.start()` resolves |
| idle hold | unconditional timer | `hasToolActivity` guard, 8s window, `unref()` |

### Bare-label payloads

Live gateway data shows tool events carry only the label, not an icon:

```json
{"keys":["text","mediaUrls"],"text":"Exec","mediaUrlsType":"undefined"}
```

The upstream emoji-prefixed parser (`/^(\S+)\s+(.+)$/u` plus
`\p{Extended_Pictographic}`) never matches that shape, so aggregation silently
produced nothing. The port adds `parseBareToolLabel`, gated by a whitelist so
short prose is not miscounted as a tool:

```
exec bash shell read write edit apply_patch grep glob ls browser
web_fetch web_search image view_image process sessions message
task todo memory node canvas
```

**Known limitation:** tools outside that set (MCP servers, plugin-provided tools)
are not counted. Add the label to `BARE_TOOL_LABELS` if you need them.

### Card/tool race

Local commands finish in well under a second while card creation takes seconds.
The aggregator used to write its status line before the card existed, so fast
batches showed no progress at all. The port backfills after creation:

```js
if (generation === activeStreamingGeneration && aggregatedToolSummaryCounts.size > 0) {
  updateStreamingStatusLine(`⏳ 已执行 ${backfillTotal} 个工具，等待中…`, true);
}
```

### Review fixes folded in

| issue | fix |
| --- | --- |
| `onToolResult` returned `{visible:true}` but core never consumes it | removed (dead code) |
| `markVisibleReplySent()` polluted delivery bookkeeping | removed |
| bare-label regex accepted any letter string | replaced with whitelist |
| 15s timer without `unref` | `unref?.()`, window reduced to 8s |
| duplicated `midTurnBlockFold` condition | simplified |

## Upgrade warning

Upgrading OpenClaw or `@openclaw/feishu` rewrites `dist/` and **silently reverts
this patch**. After any upgrade:

```sh
grep -c parseCollapsibleToolSummary ~/.openclaw/npm/projects/*/node_modules/@openclaw/feishu/dist/.setup/monitor.account-*.mjs
```

`0` means the patch is gone — re-apply it (and re-derive it if the build hash
changed).

## Layout

```
install.sh                                  multi-version, idempotent installer
patches/
  2026.10.1/
    original.mjs                            pristine plugin bundle
    patched.mjs                             patched plugin bundle
    feishu-tool-aggregation-wayE.patch      the 7-hunk unified diff
  2026.10.2/
    original.mjs
    patched.mjs
    feishu-tool-aggregation-wayE.patch
  2026.10.5/
    original.mjs                            pristine plugin bundle
    patched.mjs                             patched plugin bundle
    feishu-tool-aggregation.patch           the 9-hunk unified diff
  SHA256SUMS                                hashes for all of the above
tests/
  test-wayD.mjs       live-shape discriminator
  test-wayC.mjs       mid-turn block fold
  test-wayB.mjs       bounded summary line
  exec-agg.mjs        execution harness
  audit-agg.mjs       structural audit
  test-idle-release.mjs  card-release behaviour
```

## License

MIT — see `LICENSE`.
