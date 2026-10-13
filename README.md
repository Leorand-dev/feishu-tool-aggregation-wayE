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
