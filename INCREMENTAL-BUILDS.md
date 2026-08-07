# Incremental builds for the tscircuit workspace — analysis and proposal

*Status: rungs 0–6 of §6's ladder are **implemented** in `tsc-dev` (2026-08-07).
What remains is upstream work (§4.4) and off-the-shelf executors (§4.5), which
are deliberately not started. See §0 for what shipped and what it measures.*

This looks at what `tsc-dev` actually does today, where the time actually goes,
and what a Bazel-style incremental build system would and would not buy. The
short version:

> **The multi-minute chains are gone, and caching was not what fixed them.**
> Two orchestration defects in `tsc-dev` accounted for nearly all of it; with
> those fixed the full `core → eval → runframe` chain is **65.6s measured**,
> down from ~496s. What remains is *real compute*, and it is not shaped the way
> the folklore said: **declaration emit is 27.4s of that 65.6s (61%)**, Vite is
> 17s, and JavaScript emit is under 400ms in total. The next win is therefore
> not a cache — it is not generating `.d.ts` in the inner loop, which no cache
> can do for you the first time. Content addressing remains worth building
> after that, for branch switches, no-ops and retries; Bazel remains the right
> shape of answer to a problem whose measured size no longer justifies its cost.
>
> **Both of those have now been built, and the prediction held.** A JS-only dev
> profile takes the chain to **~11.5s** (core 10.5s → 0.34s), and an unchanged
> or previously-built repo restores in **~0.1s**.

---

## 0. What was built (2026-08-07)

All of it is local to `tsc-dev`; nothing needed upstreaming, and nothing was
added to any repo's `package.json`.

| Rung | Shipped as | Measured effect |
|---|---|---|
| 0 | `bin/timings.mjs`, `./tsc-dev timings`; wrong figures corrected in `AGENTS.md`, `stale-bundles.mjs`, `chain-sync.mjs` | every build appends to `.run/timings.jsonl`; the docs stop disagreeing |
| 1 | `bin/build-profile.mjs`, `--fast`/`--full`, `workspace.json build.profiles` | core **10.5s → 0.34s**, eval ~15s → **1.3s**, runframe ~23s → **9.7s**, chain compilation 65.6s → **~11.5s** |
| 2 | `bin/provenance.mjs`, `bin/verify-running.mjs`, `doctor --verify-running`; watcher input filtering via `bin/build-inputs.mjs` | 4 repos' builds identified inside a 26MB served bundle in **0.1s**; `tests/**` edits no longer trigger builds |
| 3 | declaration preservation in `bin/build.mjs`, reported by `doctor` | a dev build keeps the last known-good `.d.ts`, labelled `preserved-stale` |
| 4 | `bin/action-key.mjs`; the version stamp is now `-local.<profile>.<key>` | identical inputs → identical version; the store stops growing per publish |
| 5 | `bin/build-cache.mjs`, `./tsc-dev cache status\|prune\|verify` | no-op **~0.1s**, restore **~0.1s**; `cache verify core` reports byte-identical rebuilds |
| 6 | stable versions make an unchanged publish idempotent | the 3.8GB store is now bounded by distinct inputs, not by build count |

**And the bottleneck moved.** A full `rebuild --from core --to runframe` now
measures ~28s, of which only ~11.5s is compilation: the rest is `yalc push`
copying eval's 32MB and runframe's 47MB payload into every consumer whether or
not the bytes changed. Rung 6's second half — skip the push when the consumer
already holds this artifact digest — is therefore the next thing worth doing,
and it was ranked *below* caching on the old measurements precisely because
copying was invisible next to a 65.6s compile. It is not urgent: the common case
is one repo (`push core`, ~1s all-in).

Things learned while building it, which the analysis had not predicted:

- **`bun run <script>` cannot be replaced by running the command**, unless you
  also put `<repo>/node_modules/.bin` on PATH. Every build failed with
  `tsup-node: command not found` until that was added.
- **An ordinary `//` comment is not provenance.** esbuild strips comments when
  it bundles, so core's stamp vanished the moment eval inlined it and
  `verify-running` reported core "missing" from a bundle that certainly
  contained it. A *legal* comment (`/*!`) is preserved by every minifier in this
  pipeline, and that one character is the difference between the mechanism
  working and quietly not.
- **The base64 step had to be seen through, not just survived.**
  `inject-eval-worker.mjs` splices the worker in as `atob("…")`, which is exactly
  where the six-hour-stale worker hid. `extractBuildKeys` decodes it — and the
  injector also restates the worker's stamps in plain text, because the question
  gets asked with `grep` at 2am. Scanning for the base64 payload with a regex
  overflowed the regex engine's stack on a real 26MB bundle; it is an
  `indexOf` loop for that reason.
- **A build that writes into its own source tree would loop forever.**
  runframe's `build:css` emits `lib/hooks/styles.generated.ts`; hashing it would
  make every build change its own inputs. `**/*.generated.*` is excluded, and
  the derived file's own sources are inputs, so nothing is lost.
- **A no-op still has to touch `dist`.** `stale-bundles.mjs` reads mtimes, so a
  build that decides there is nothing to do must still record "checked just
  now", or a chain sync sees an unchanged consumer as permanently behind and
  rebuilds it on every pass, forever.

---

## 1. What the numbers actually are

`AGENTS.md` currently says a full chain is ~380s of which "runframe alone is
314s (two full vite bundles)", and `stale-bundles.mjs` cites ~480s. Those
numbers no longer match the artifacts on disk.

Reconstructed from `.run/chain-tsc-playground.log` plus the yalc store, whose
directory names carry the stamp time (`0.0.2362-local.20260806T211459`) and
whose mtimes carry the publish time — for the `rebuild eval runframe` pass that
ran 21:07:12 → 21:15:27 (495s):

| Interval | What happened | Time |
|---|---|---|
| 21:07:12 → 21:10:22 | before eval's build even started: the pre-build `yalc add` loop over ~30 deps (21 of them not in the store at all) | **190s** |
| 21:10:22 → 21:14:59 | eval build + publish + push, then runframe's own `yalc add` loop | 277s |
| 21:14:59 → 21:15:27 | **runframe's entire build** — `build:css`, two vite UMD bundles, `tsup` lib + dts, publish, push to 3 consumers | **28s** |

And from the build tools' own timers in the same log:

| Step | Time |
|---|---|
| runframe `vite build` (standalone, 3031 modules, 11.5MB raw; ~26MB after local worker injection) | **9.26s** |
| runframe `vite build` (standalone-preview, 2980 modules, 11MB out) | **8.69s** |
| runframe `tsup` lib: ESM / **DTS** | 47ms / **6.1s** |
| core `tsup`: ESM 1.48MB / **DTS 8.74MB** | 49ms / **10.2s** |
| eval: 6 tsup steps, five of which are dts | ~2.5s each, ~14s total |
| `yalc add` of an in-store package (measured, empty dir) | 0.1s |

### Measured after the orchestration fixes (2026-08-06)

The re-measurement Recommendation 0 asked for has now been done, on an idle
machine with the playground daemons stopped:

| Command | Before | After |
|---|---|---|
| `rebuild core eval runframe` (full chain) | ~496s avg over 10 runs | **65.6s** |
| `rebuild eval` alone | 3m13s | **20.2s** |
| `rebuild core` alone | — | **17.5s** |
| `playground sync` (eval + serve-time inject) | ~496s | **20.1s** |
| `yalc push` (eval, 3 consumers) | — | **0.6s** |

Where the 65.6s goes, from the build tools' own timers in that run:

| Repo | JS emit | Declarations | Vite |
|---|---|---|---|
| core | 50ms | **10.2s** | — |
| eval (6 steps, 5 of them dts) | ~390ms | **11.3s** | — |
| runframe | 47ms | **5.9s** | 8.54s + 8.44s |
| **total** | **~0.5s** | **27.4s (61% of wall)** | **17.0s** |

Four conclusions, and they change the shape of the whole problem:

1. **The crisis was orchestration, and it is over.** The two defects — a
   package-name lookup that spawned `node` once per repo per dependency
   (~1,200 spawns per rebuild), and `yalc add` attempts against packages that
   were never in the store — accounted for roughly 7/8 of the elapsed time.
   Neither was compilation. This is worth internalizing before adopting any
   build system: *the workspace was never compute-bound.*
2. **runframe's full build is ~23s, not 314s or 480s.** Two Vite bundles at
   8.5s each, css at 0.7s, tsup lib at 47ms + 5.9s of dts. The 314s in
   `AGENTS.md` and the 480s in `stale-bundles.mjs` are both wrong, and the 480s
   was written during this work from pre-fix logs. Both should be corrected;
   see §7.
3. **Declarations are the remaining cost, at 61% of the chain.** core emits its
   JavaScript in 50ms and its 9.2MB `index.d.ts` in 10.2s — a factor of 200.
   The browser and `tsci build` consume none of it.
4. **JavaScript emit is essentially free.** Half a second for the whole chain.
   Any plan whose payoff is "avoid re-running JS emit" is optimizing 0.7% of
   the problem.

**`--dts false` does not work as a CLI override.** Measured: `npx tsup-node
--dts false` in core still starts a DTS build, fails it, and exits — the JS is
correct but the invocation is not a supported fast path. A profile table in
`tsc-dev` (or an upstreamed `build:js` script per repo) is required; there is
no generic flag to lean on.

---

## 2. What the topology actually is

- ~52 sibling checkouts, each its own git repo, its own `node_modules`
  (19GB apparent), its own `bun install`, its own bespoke build script
  (`tsup-node`, `vite build` ×2, `bun build`, hand-written `scripts/*.ts`).
- Intra-workspace dependencies are resolved by **yalc, which copies**: a publish
  copies the package into `~/.yalc/packages/<pkg>/<version>/`, and each push
  copies it again into every consumer's `.yalc/` *and* `node_modules/`. runframe
  is 47MB of `dist` × 3 consumers; the store holds **80 versions of core and 24
  of runframe, 3.8GB total**.
- The build graph is declared once, by hand, in `workspace.json`'s
  `bundling.inlines`, and is deliberately a superset ("rebuilding one level too
  many is harmless").
- Staleness is decided by **mtime** (`stale-bundles.mjs`, `chain-sync.mjs`):
  newest file under `dist/`, propagated through the graph.
- Every local build is stamped `X.Y.Z-local.<UTC timestamp>` to keep local and
  npm artifacts out of the same cache slot.
- The stamp is not metadata-only. `core` imports its own `package.json` into the
  runtime bundle (`IsolatedCircuit.getCoreVersion` and the autorouting cache
  key), and runframe imports its version into UI code. Changing the stamp
  therefore changes output bytes even when source code is otherwise identical.

This is a monorepo in everything but git. The repository graph already captures
important domain rules, but its freshness mechanism and package-sized build
unit are precisely the parts a build system would replace.

### The three structural defects

**(a) Nothing is cached, and the clock stamp guarantees it stays that way.**
The stamp is derived from the clock and is embedded by at least core and
runframe, so two builds of identical source produce different output bytes. It
is also the direct cause of the 80-versions-of-core store.

> **Fix the identity first: stamp with an action/input hash, not the clock.**
> For example, `0.0.1609-local.dev.7f3a91c2b04e` and
> `0.0.1609-local.full.54c27d…`. The build profile must be part of the identity:
> a JS-only snapshot and a release snapshot must never overwrite one another
> under the same version. Twelve or sixteen hexadecimal characters is preferable
> to a very short suffix, and the cache manifest should retain the full digest.

This hash cannot simply be “the hash of `dist`”: the version is compiled into
`dist`, which would create a cycle. Compute an **action key** from normalized
inputs first, use that key as the deterministic prerelease stamp, build once,
and then record a separate digest of the resulting artifact. It preserves every
property the timestamp scheme was designed for while making an unchanged build
reuse the same identity and bounding the yalc store by distinct inputs rather
than build count. Changing `with_dev_version` is small; making the key correct is
the substantive work.

**(b) mtime is wrong in both directions.** `git checkout` of a branch you had
before rewrites mtimes and rebuilds the world; a rebuild that changes no output
byte still marks every consumer stale and cascades a full chain. `dist/` mtimes
also confuse "when we built" with "what we built from" — which is exactly why
`stale-bundles.mjs` needs its subtle second rule about inherited staleness.

Content addressing needs two identities, not one:

- the **action key** says whether a build may be reused;
- the **artifact digest** says what bytes a consumer actually embeds.

A consumer should be keyed by the artifact digests of the precise upstream
outputs it consumes. Using the upstream repository's source/action hash would
unnecessarily invalidate a consumer when a source change produces identical
JS. A provenance manifest beside every cached artifact records both.

**(c) Linking copies tens of MB per push, but it is no longer the first target.**
An in-store `yalc add` is about 0.1s in the measurements; the minutes in the old
log were failed lookups and repeated process discovery that current `tsc-dev`
already avoids. Once snapshot versions are stable, `tsc-dev` can also skip a
publish/push when the target consumer already has the same `yalcSig` or artifact
digest. That is lower-risk than changing package-manager topology.

---

## 3. Would Bazel help? Honestly:

**What Bazel/Buck2/Pants would genuinely give us**

- Content-addressed action cache — the thing we're missing.
- Correct, automatic invalidation from declared inputs (no more mtime rules).
- Parallel execution of independent actions (runframe's two vite bundles are
  independent and run serially today; so do eval's six tsup steps).
- A shared remote cache and remote execution, if they eventually matter.
- Hermeticity across the non-JS bits we already have (`krt-wasm`, manifold wasm,
  `@resvg/resvg-js` native binaries).

The first three benefits do not require a remote service. A local content-
addressed action cache is the missing capability in the current loop; sharing it
with CI is a separate product decision, not the reason to adopt caching.

**What it would cost, specifically here**

- **The mature `rules_js` path is pnpm-shaped.** We are Bun-first, and most
  repos *disable lockfiles entirely* (`[install.lockfile] save = false`). A
  serious Bazel adoption would therefore mean either substantial custom Bun
  toolchain/rule work or maintaining a second pnpm lock and dependency world
  alongside the one each repo's CI actually uses. Either path is a permanent
  tax and a source of "works in Bazel, fails in CI" divergence.
- **BUILD files have to live somewhere.** Committing them into ~15 upstream
  repos needs org buy-in, and then each repo has *two* build definitions (bun
  scripts for its own CI, Bazel for us) that will drift. The alternative — a
  generated overlay in this workspace — is a gazelle-sized project.
- **It would not make any single build faster.** Bazel would invoke `vite build`
  as one opaque action. The 9s stays 9s; the 10.2s of core dts stays 10.2s. All
  the win is in *not repeating* work — which is the cache, which we can have far
  more cheaply.
- It conflicts with the workspace's existing, working machinery: yalc,
  version stamping, PR worktrees with private stores, playground daemons.
  `tsc-dev` encodes domain knowledge no generic tool has (that runframe's
  standalone can be *spliced* rather than rebuilt, that `cli` is run from source
  and never needs building for the browser loop).

**Verdict: no, not as the next step — and the measurements make this stronger,
not weaker.** The whole chain is 65.6s, of which 27.4s is declaration emit that
a profile flag removes outright and 17s is Vite that Bazel would invoke
unchanged. A hermetic build system's fixed costs — a second dependency world,
BUILD files in ~15 upstream repos, two build definitions per repo — would be
paid every day to cache a workload measured in seconds. Bazel is the right
shape of answer to a problem we have (no caching) but couples it to a
package-manager/toolchain migration we do not need. Revisit it when (i) local cache correctness has become
hard to maintain; (ii) remote execution or a shared cache is genuinely needed;
(iii) the org is willing to own BUILD files and a second dependency model.

**Ranked alternatives if we do want an off-the-shelf runner:**

| Tool | Fit | Notes |
|---|---|---|
| **moon** | best | Rust, first-class bun support, explicit `inputs`/`outputs` per task, local + remote cache, per-project config that can be generated into an overlay. Closest to "Bazel discipline, npm ergonomics". |
| **turborepo** | possible, but awkward | Hash-based task caching, but assumes a package-manager workspace at the root. Package-script granularity is still too coarse for `js` versus `dts` and runframe shell versus UMD dependency chunks. |
| **nx** | ok | More machinery than we need; strong affected-graph tooling. |
| **bazel / buck2 / pants** | later | See above. Buck2 is the nicer of the three for this shape, but JS rules are thin. |

---

## 4. Proposed ladder (each rung independently shippable)

### 4.1 Stop doing work the inner loop doesn't consume *(small; biggest immediate win)*

***Implemented*** *(rung 1; see §0). What follows is the reasoning as written
before it was built — the outcome beat the estimate because the recipe is
derived per build step rather than per repo.*

- **Add explicit JS-only dev recipes.** Measured effect on the full chain:
  **65.6s → ~38s**, and on the common inner loop (core edit → browser, which
  skips runframe via serve-time injection) **~35s → ~10s**. A `TSC_DEV_FAST=1` /
  `--no-dts` profile turns core's build from **10.3s → ~0.5s** (its JS emit is
  49ms), eval's from ~15s toward its JS-only
  cost, and removes runframe's 6.1s declaration pass. This is not reliably a
  generic `bun run build -- --dts false`: eval has six scripts/configs and
  runframe mixes Vite and tsup. Start with a small recipe table in `tsc-dev`,
  then upstream a conventional `build:js` or `TSCIRCUIT_SKIP_DTS` contract so
  the local recipes cannot drift from each repo's build.
- **Preserve the last known-good declarations.** Core and 3d-viewer export
  `dist/index.d.ts`; eval exports declarations for almost every subpath, and
  yalc publishes only `dist`. Editors do *not* automatically read source through
  the yalc snapshot. A fast build that cleans `dist` can therefore break editor
  resolution. The dev artifact should merge newly built JS with declarations
  from the newest compatible full-build artifact, or explicitly record that no
  declarations are available. If preserved declarations are merged, their
  artifact digest is an input to the dev snapshot key. `doctor` should show
  whether declarations are current, preserved/stale, or absent. `pr-check` and
  release builds always use the `full` profile.
- **Give fast and full artifacts different identities.** For example,
  `-local.dev.<hash>` versus `-local.full.<hash>`. Otherwise a no-dts payload can
  overwrite a complete payload under the same yalc/cache key.
- **Parallelize only after measuring memory.** Runframe's two Vite processes
  each permit an 8GB heap. They and eval's tsup passes are independent, but
  running all of them concurrently is not a free 2× on a developer laptop.
  Profile-specific builds remove more work than parallel scheduling; bounded
  parallelism can follow.
- **core's 8.74MB `index.d.ts`** is worth its own investigation (editor perf,
  and it is most of the 10.2s). `isolatedDeclarations` may make declaration emit
  much cheaper, but that is an upstream type-design/build change and should be
  benchmarked rather than assumed.

### 4.1b Make provenance greppable, and filter what the watchers watch *(hours; prevents the failure class caching multiplies)*

***Implemented*** *(rung 2). One correction from building it: the banner has to
be a LEGAL comment (`/*!`), because bundlers strip ordinary ones — and the
base64 splice has to be decoded, not merely survived.*

Two cheap changes that are not optimizations — they are the safety rail the rest
of the ladder needs.

**Every artifact must be able to answer "are you the build I think you are?"**
In a single session, three separate hours went to *running code that was not the
code on disk*: an eval worker inlined six hours earlier, a published
jscad-electronics where a local build was assumed, and a dev server silently
falling back to the CDN bundle after `dist` was wiped. Each was ultimately
diagnosed the same way — decode the artifact and grep it for a symbol that only
the new code contains. A cache makes that class of failure **more** likely, not
less: a wrong cache hit is indistinguishable from a correct one at the point of
use.

So: emit the action key as a literal string in every artifact (a
`__TSC_DEV_BUILD__` banner comment survives minification if declared as a
banner), and give `doctor` a `--verify-running` that fetches what the dev server
is actually serving, extracts the keys, and compares them with the keys the
graph says should be there. That turns an 8-minute bisect into a one-second
check, and it is the only mechanism that can catch a cache serving a stale hit.

**Watchers currently rebuild on inputs the build does not read.** Every save
under `tests/` triggers a full repo build producing byte-identical `dist` —
during this session core rebuilt repeatedly from test edits alone, at ~13s each.
Restricting the watch set to declared build inputs (`lib/**`, `src/**`,
`package.json`, build configs) removes most triggers before any cache is
consulted, and it is a prerequisite for §4.2 anyway: the watched set and the
hashed input set should be the same list, derived from one declaration. Until
they are, a cache hit merely makes a wasted trigger cheap instead of absent.

### 4.2 Content-address everything *(the "Bazel discipline" without Bazel)*

***Implemented*** *(rungs 4–5): `bin/action-key.mjs` and `bin/build-cache.mjs`.
The input set is exclusion-based rather than an explicit include list — an
over-narrow include list fails silently, an over-broad one only costs a rebuild
— and the dependency edge is each local dependency's `yalcSig`, which is
already an artifact digest. `stale-bundles.mjs` still uses mtimes (rung 7).*

The cache key must describe a **target and profile**, not just a repository:

```
actionKey(target, profile) = H(
  cache schema version,
  normalized declared source inputs,
  normalized package manifest + build recipe/config files,
  bun/node + bundler/plugin versions,
  OS/architecture and declared environment variables,
  resolved external dependency graph fingerprint,
  artifactDigest of each precise local input target,
  profile                         # dev-js, full, standalone-shell, ...
)
```

Important details omitted by a simple `git tree` hash:

- Hash paths, modes/symlinks and bytes for an explicit input set, including
  dirty and untracked files. Do not hash every tracked file: core has 443 source
  files and 2,185 tracked tests, so a snapshot update must not invalidate its
  library build. Build configs, package export fields and generated inputs do
  belong in the set.
- Normalize fields that `tsc-dev` itself rewrites. The clock/local version and
  `file:.yalc/...` spellings must not create a new action key; the base published
  version, scripts, exports and dependency identities still matter.
- The current repos have no lockfiles, but a local cache still has to notice
  `bun install` changing the dependency tree. Hashing only Bun, tsup and Vite is
  insufficient: any transitive package can change bundle output. Initially,
  fingerprint the resolved installed graph (name/version plus git SHA or
  integrity where available), every local package's `yalcSig`/artifact digest,
  Bun version, platform and architecture. Have `tsc-dev install` persist that
  fingerprint so builds do not walk 19GB of `node_modules` every time.
- Use exact artifact edges. `workspace.json` is deliberately a repository-level
  superset and package.json only proves that a dependency is declared, not that
  a particular entry point bundles it. The first target graph can be explicit;
  Vite/esbuild metafiles should later verify it. The runframe shell target must
  omit eval's artifact edge when eval is supplied by serve-time injection.

Store artifacts in a versioned local CAS, preferably under
`$XDG_CACHE_HOME/tsc-dev/v1`, with a manifest such as:

```json
{
  "target": "core:js",
  "profile": "dev-js",
  "actionKey": "…",
  "artifactDigest": "…",
  "localVersion": "0.0.1609-local.dev.7f3a91c2b04e",
  "inputs": { "…": "…" },
  "dependencies": { "circuit-json:js": "artifact digest" },
  "outputs": ["dist/index.js"],
  "declarations": "preserved-stale"
}
```

On a miss, build once under the deterministic stamp, digest the declared
outputs, and atomically rename a temporary cache entry into place. On a hit,
verify the manifest and restore with APFS clonefile (`cp -c`) with a portable
copy fallback. Use a per-action-key lock so two watchers cannot populate the
same entry, never admit a failed/interrupted build, and add LRU/prune support.
Some actions need more than `dist`: runframe's CSS step currently writes
`lib/hooks/styles.generated.ts` into the source tree. Generated inputs like that
must be declared or split into their own cached target.

`stale-bundles.mjs` should stop inferring correctness from output mtimes. A
restored/built output gets a provenance sidecar, and status compares the
recorded action key and dependency artifact digests with the currently required
ones. Mtime remains useful only for "have watchers been quiet for 45 seconds?"
The inherited-staleness tests remain valuable, but provenance makes the answer
explicit rather than inferred.

Add `--verify-cache`: rebuild into a temporary location and compare output
manifests/digests. Run it periodically and in tests for representative targets;
embedded timestamps, absolute paths and nondeterministic chunk IDs are build
bugs, not reasons to weaken the key.

**Expected effect:** switching back to previously built contents, restarting a
watcher, or retrying after a downstream failure restores artifacts instead of
compiling. A core edit rebuilds `core:js` and the eval worker that embeds its
new artifact; runframe is untouched when the worker is composed at serve time.
A doc or snapshot edit either does not trigger the build watcher or produces an
immediate cache hit.

### 4.3 Keep yalc, but make materialization content-addressed *(small after §4.2)*

***Partly implemented*** *(rung 6): stable versions make an unchanged publish
idempotent, so the store is bounded by distinct inputs. Skipping the push itself
when the consumer already holds the digest is not done — a push measures 0.6s.*

Do **not** generate a root Bun workspace as the next step. This workspace
intentionally has no root `package.json`: Bun walks upward, so adding one would
change dependency resolution inside every independent checkout and make local
behavior diverge from each repo's CI. A workspace in a separate staging tree
could be revisited, but it is not needed for caching.

Keep yalc as the npm-shape adapter, and separate build from materialization:

1. Resolve or build the cached artifact.
2. Temporarily apply its deterministic local version only while constructing the
   package payload.
3. Reuse the existing yalc store entry when its artifact digest matches.
4. Push/add only to consumers whose installed `yalcSig` or artifact digest
   differs.

This retains peer/package-resolution fidelity and the private-store isolation of
PR worktrees. It also means a cache hit does not immediately spend its savings
republishing and copying the same 47MB payload. The cache should store the
canonical build artifact; yalc remains disposable delivery state that `doctor`
can repair.

Separating these phases also lets `package.json` become a watched input again.
Today it is ignored because stamping and yalc rewrite it and would trigger a
loop, which means a genuine dependency edit requires restarting the watcher.
With self-writes explicitly suppressed during materialization, dependency and
build-config changes can invalidate normally.

### 4.4 Split runframe's true long-lived dependencies into UMD artifacts *(upstream work)*

No cache makes a first build after a genuine runframe-shell input change faster.
The existing eval placeholder proves the right structural pattern:
`inject-eval-worker.mjs` composes a cached worker with a cached shell in ~0.1s.
Generalize that pattern to high-cost, independently changing dependencies.

- First emit a Vite/Rollup metafile and visualizer report for each standalone
  entry. Pick candidates by bundle weight *and change frequency* rather than by
  intuition; likely candidates include `3d-viewer`/three, `pcb-viewer`, and
  `circuit-to-svg`, but the measured closure decides.
- Build each chosen dependency as a versioned UMD artifact and mark it external
  in the runframe shell. The final local/release artifact can load the UMD files
  separately or concatenate/inject cached chunks, preserving a one-file delivery
  option without rebundling their source.
- Define the global ABI, load order and compatibility identity explicitly.
  React must remain a singleton; Three and viewer globals must not be duplicated.
  A chunk's content/action hash should be part of the composed artifact's
  provenance.
- Preserve the standalone contract deliberately: offline behavior, CLI static
  serving, CDN URLs, CSP/blob behavior and the tscircuit umbrella's copy/inject
  scripts all need tests. Prototype behind `STANDALONE=split` before changing
  published exports.

Then a 3d-viewer edit rebuilds its UMD chunk and performs cheap composition,
not a 3,000-module runframe transform. This is more valuable than scheduling the
same monolithic bundle faster because it shortens the invalidation graph itself.

### 4.5 Only then consider an off-the-shelf executor

After §4.2, `tsc-dev` already has the part we currently need: declared local
targets, deterministic identities and a content-addressed cache. Moon/Nx may
later be useful for scheduling/UI, and a remote backend can be added without
changing artifact identities. Turborepo still wants the root workspace we have
a reason not to create. Revisit Bazel/Buck2 only against §3's conditions rather
than treating remote caching as an immediate requirement.

---

## 5. What not to lose

`tsc-dev` is not a thin wrapper; it encodes things no generic build system
knows, and each of them exists because of a real incident recorded in its
comments:

- eval is **spliced** into runframe at serve time, so a runframe rebuild is
  usually unnecessary (`INJECTED_AT_SERVE_TIME`) — and pruning that edge must
  prune eval's whole subtree, not just the edge.
- the chain syncs after the watchers go **quiet**, so a burst of saves costs one
  rebuild.
- `cli` is run from source and the `tscircuit` umbrella only matters for a
  global install, so neither belongs in the browser loop.
- local builds must never wear a version npm can mint.
- PR worktrees must never publish into the shared store.
- cache entries are profile-, schema-, toolchain- and platform-specific; a fast
  dev artifact can never satisfy a full/release request.
- cache publication and `dist` restoration are atomic and locked per repo/key;
  interrupted builds and concurrent watchers cannot poison an entry.
- package manifests and build configs are real watched inputs even though
  `tsc-dev` temporarily mutates package metadata during yalc materialization.
- release and `pr-check` continue to execute the repository's own full build,
  which is the compatibility oracle until upstream build recipes are shared.
- an artifact can be asked what it is. Provenance that is only in a sidecar
  manifest cannot answer "is the browser running my change?" — the answer has to
  survive bundling, injection and base64 embedding, because that is the path the
  question is actually asked along.

Any migration should treat these as requirements to carry forward, not as
accidents of the current implementation.

---

## 6. Suggested order

Re-ranked against the measurements. The ordering principle: remove work before
caching work, and make wrongness visible before making work invisible.

| # | Change | Effort | Expected, measured where possible | Status |
|---|---|---|---|---|
| 0 | correct the wrong numbers now in `AGENTS.md` and `stale-bundles.mjs`; add `--timings` JSONL | hours | stops three documents disagreeing about a number that decides designs | **done** — `bin/timings.mjs`, `./tsc-dev timings` |
| 1 | **JS-only dev profile** (recipe table in `tsc-dev`, then an upstream `build:js` convention) | 1–2 days | chain **65.6s → ~38s**; core edit → browser **~35s → ~10s** | **done, and better than predicted** — chain **~11.5s**, because the recipe is derived per step and runframe's unused second Vite bundle is skipped too |
| 2 | **greppable provenance + `doctor --verify-running`**; restrict watcher inputs to declared build inputs | hours | kills the "running code that isn't on disk" class; removes most no-op rebuild triggers | **done** — `bin/provenance.mjs`, `bin/verify-running.mjs`, `bin/build-inputs.mjs` |
| 3 | declaration strategy: preserve last-good `.d.ts` in dev artifacts, investigate `isolatedDeclarations` for core's 9.2MB / 10.2s | days + upstream | makes profile 1 safe for editors; possibly removes the 27.4s outright rather than deferring it | **half done** — preservation shipped; `isolatedDeclarations` is upstream type-design work and untouched |
| 4 | action keys replacing the clock stamp (normalized inputs, profile in the identity) | 1–2 days | stable identity; bounds the 3.8GB store; prerequisite for any cache | **done** — `bin/action-key.mjs` |
| 5 | local CAS with atomic populate/restore, per-key locking, `--verify-cache` | several days | branch switches, no-ops and retries stop compiling | **done** — `bin/build-cache.mjs`, `./tsc-dev cache verify` |
| 6 | content-aware yalc materialization (skip publish/push when the digest matches) | days | a cache hit stops spending its savings on a 47MB copy | **partly** — stable versions make an unchanged publish idempotent; the push itself (0.6s measured) is not yet skipped |
| 7 | exact artifact graph (`core:js`, `eval:webworker`, `runframe:shell`) verified by bundler metafiles | days | fewer false invalidations; retires the mtime rules | not started — staleness is still mtime-based, now with provenance beside it |
| 8 | split runframe's heavy, independently-changing deps into UMD chunks | weeks, upstream | shortens the graph itself; only worth it once 3d-viewer edits are the bottleneck | not started (upstream) |
| 9 | bounded parallelism; moon/Nx; remote cache | later | scheduling and sharing, not correctness | not started |
| — | root Bun workspace; Bazel/Buck2 | not now | costs exceed a 65s workload | **still no** — and the workload is now ~11.5s |

**What changed from the previous ordering.** Content addressing moved from #1 to
#4–5, because the measurements show the inner loop is dominated by work that
should not run at all rather than by work being repeated. Two new rungs were
inserted ahead of it: a JS-only profile (removes 27.4s that no cache can avoid
on a cold key) and provenance/watch-filtering (makes cache correctness
checkable, and removes triggers rather than servicing them cheaply).

**Where this plan could still be wrong.** The 65.6s figure was one run on one
machine with warm dependency caches and daemons stopped; `./tsc-dev timings`
now turns it into a distribution instead. If cold-start Vite (dep pre-bundling)
or a loaded machine reproduces the old 300s+ figures, rung 8 moves up sharply.
Measure before believing either number — including the ~11.5s in §0.

## 7. Numbers to correct in the tree — *done, and the lesson*

All three were corrected on 2026-08-07:

- `AGENTS.md`: "a full chain is ~380s, runframe alone is 314s" → a measured
  table, plus a pointer to `./tsc-dev timings` as the live source. The "browser
  preview costs ~6 min" entry is now ~2s (worker splice) or ~12s (runframe
  rebuild).
- `bin/stale-bundles.mjs`, `INJECTED_AT_SERVE_TIME`: the "~480s vite build" and
  "496s average" are gone. The carve-out is now justified by STRUCTURE — the
  standalone ships a placeholder precisely so the worker can be spliced, so
  rebuilding runframe to deliver an eval change is work with no product — which
  is a reason no measurement can invalidate.
- `bin/chain-sync.mjs` header: same figures, same treatment.

The general rule now lives in `AGENTS.md`: a number in a comment rots, so quote
`./tsc-dev timings`, and if a comment must carry a figure, say when it was
measured and what has changed since. Both wrong numbers were written from logs
of a build whose time was going into a `yalc add` loop rather than a compiler,
and both outlived that defect by weeks while being cited as reasons to build
things.

## Appendix: incidental findings

- **Playground daemons from a previous session were still running** (9 live pids
  in `.run/`: `chain-tsc-playground`, `dev-tsc-playground`, and 7 watchers).
  Per `AGENTS.md` they should have been stopped by whoever started them;
  `./tsc-dev playground status` / `stop` clears them. (Cleared since.)
- `runframe/package.json` and `cli/package.json` currently carry
  `file:.yalc/...` dependency entries — the leftover-link hazard `AGENTS.md`
  calls the #1 cause of broken PRs. `./tsc-dev doctor` / `unlink` before any PR
  from those checkouts.
- `~/.yalc` is 3.8GB (80 core versions, 24 runframe); stable snapshot versions
  plus content-aware materialization should shrink that substantially.
  `*/node_modules` is 19GB apparent (less on disk thanks to APFS clonefile), but
  the revised plan intentionally does not try to deduplicate it with a risky
  root workspace.
