# AGENTS.md — tscircuit development workspace

This file orients agents (and humans) working in this multi-repo tscircuit
workspace. Read this first, then `MAP.md` (repo guide) and `README.md` (workflow
detail). Each cloned repo also has its own `AGENTS.md`/`CLAUDE.md` — read the
relevant repo's file before changing that repo.

## What this workspace is

This directory (`~/src/tscircuit`) is a **flat workspace of independently-cloned
tscircuit repos** (siblings: `core/`, `eval/`, `props/`, ...). Key facts:

- tscircuit is **NOT a monorepo** and does **NOT** use git submodules. Each
  package is its own GitHub repo under https://github.com/tscircuit, published
  to npm independently.
- There is **no top-level git repo** tracking these checkouts. The workspace
  tooling (`tsc-dev`, `MAP.md`, this file) lives here ungit-tracked; each repo
  is its own git checkout.
- Cross-repo development uses **yalc** (a local package registry), per the
  handbook: https://github.com/tscircuit/handbook/blob/main/guides/using-yalc.md

## Dev tools (required)

- **bun** — install / build / test runner. Use `bun`, never `npm`/`yarn`/`pnpm`.
- **yalc** — link local package versions across repos.
- **biome** — formatting/linting (`bun run format`).
- **gh**, **rg**, **fd** — used by `tsc-dev` for repo discovery and search.

## The `tsc-dev` helper (start here)

`./tsc-dev <command>` automates the clone/build/link/search workflow. Run
`./tsc-dev help` for the full list. Most-used:

| Command | Purpose |
|---|---|
| `clone-group <group>` | bulk-clone a curated category (`runtime`, `solvers`, `viewers`, ...) |
| `clone-deps <repo> [-r]` | clone the org repos a repo depends on (dependency closure) |
| `clone [repos...]` | clone specific repos as siblings |
| `search <pattern> [rg args]` | ripgrep across all cloned repos (source only) |
| `install [repos...]` | `bun install` in repos (default: all cloned) |
| `publish <repo>` | build + `yalc publish` to the local store |
| `link <consumer> <dep>` | `yalc add` the dep's package into the consumer |
| `push <repo>` | rebuild + `yalc push` to all consumers |
| `rebuild <repo...>` | link local deps + build + push, **in order** (propagate a change up the chain) |
| `rebuild --from <repo>` | same, but the chain is **computed** from `workspace.json`'s bundling graph |
| `watch <repo>` | rebuild + push that repo on every source change (debounced) |
| `playground <init\|start\|status\|logs\|stop>` | manage a test project and its daemons |
| `doctor [target...]` | audit yalc links (unstamped versions, npm copies that overwrote a link, stale links) |
| `prune-store [--keep N]` | delete old `-local.*` builds from the yalc store |
| `pr <repo> <branch>` | isolated worktree off upstream main for a small upstream fix (`--pick`, `--take`) |
| `pr-check <repo> <branch>` | run the PR gates CI runs, derived from that repo's workflows |
| `pr-push <repo> <branch>` | push to your fork (or origin) and open the PR |
| `fork <repo...>` | create your fork and wire it up as the `fork` remote |
| `local <init\|save\|sync\|status>` | manage your config layer (orphan branch, pushed to your fork) |
| `config [key]` | effective merged config + which layer each key came from |
| `freeze` | snapshot this build environment into your layer |
| `env <add\|show\|diff\|adopt>` | read and reproduce a peer's build environment |
| `gen-map [--check]` | regenerate (or verify) MAP.md's group sections from `workspace.json` |
| `test` | run the workspace's own test suite (`bun test ./test/`) |
| `dev [file]` | run the CLI dev server **from source** |
| `unlink <consumer>` | `yalc remove --all` + `bun install` (restore npm versions) |
| `status` | list cloned repos, package names, active yalc links |

## Changing the workspace tooling itself

The logic that can silently produce a *wrong answer* — config layering, rebuild
chains, CI-gate parsing, environment comparison — lives in `bin/*.mjs` with tests
in `test/`, not in the bash. Run them before committing:

```bash
./tsc-dev test              # bun test ./test/  (35 tests, no deps, no package.json)
./tsc-dev gen-map --check   # MAP.md is generated from workspace.json
```

Always give `bun test` an explicit path (`./tsc-dev test` does): the workspace
root has ~60 cloned repos beneath it and a bare `bun test` would walk into all
of them.

Two rules those modules follow, both learned from real bugs here:

- **Importing a module must have no side effects.** Each CLI body is guarded by
  an is-main check comparing **realpaths** — node resolves symlinks when loading
  a module, so a naive `import.meta.url` comparison reports "imported" whenever
  a path component is a symlink (`/tmp` on macOS), and the command silently
  exits 0 having done nothing.
- **Keep the decision logic pure and inject the filesystem.** `resolveChain`,
  `compareEnvironments` and `merge` take plain data, so their tests state the
  rule rather than rebuilding a workspace on disk.

## Repo layout & discovery

- **Configuration comes in two layers.** `workspace.json` is **shared** (clone
  groups, the build-time bundling graph, the default clone set) and lives on
  `main`. `.local/workspace.local.json` is **yours** (your patch-set effort,
  personal overrides, the environment lock); it is deep-merged over the shared
  file and wins, and is versioned on an orphan branch pushed only to your fork.
  Decide by asking *would every developer's copy hold the same value?* — shared
  if yes, local if no. `./tsc-dev config` shows the merge and each key's origin,
  and warns when a user-specific key is still in the shared file.
- A build environment is shareable: `./tsc-dev freeze` snapshots every cloned
  repo's remote/branch/SHA plus the yalc links into your layer, and a colleague
  reproduces it with `./tsc-dev env adopt <owner> --into <dir>`. The lock records
  each branch's remote **URL**, so fork-based patch sets reproduce as forks
  rather than silently falling back to upstream.
- **`MAP.md`'s group sections are generated** from `workspace.json` by
  `./tsc-dev gen-map`. Edit the manifest (`groups`, `repoNotes`), not the
  markdown between the generated markers; everything outside them is
  hand-written. `./tsc-dev gen-map --check` fails if they have drifted.
- The org has ~300 active repos. **Clone deliberately** — see `MAP.md` for the
  ~80 that matter, grouped by function.
- `.tscircuit-repos.txt` caches active org repo names (used to validate
  `clone-deps`). Refresh with:
  `gh repo list tscircuit --no-archived --limit 1000 --source --json name --jq '.[].name' | sort > .tscircuit-repos.txt`
- Repo name usually equals the published package name with the `@tscircuit/`
  scope stripped (e.g. `@tscircuit/core` → `core/`). Some packages are unscoped
  (`circuit-json`, `circuit-to-svg`, `footprinter`). A few names collide with
  npm packages (the org's `react` repo is a placeholder, not npm `react`);
  `clone-deps` guards against these by verifying the published package name.

## Cloning & updating process

```bash
# Clone the core development set (~40 repos):
./tsc-dev clone-group runtime      # core eval runframe cli tscircuit props circuit-json
./tsc-dev clone-deps core          # + everything core depends on
./tsc-dev install core             # bun install where you'll work

# Update later (per repo — they're independent checkouts):
git -C core pull                   # or loop:
for d in */; do [ -d "$d/.git" ] && git -C "$d" pull --ff-only; done
```

Always work on a branch in the specific repo you're changing, and open PRs
against that repo (not the workspace).

## Build & test process (per repo)

Every repo follows the same conventions:

```bash
bun install            # once per repo (and after dependency changes)
bun run build          # build (tsup/vite) — only repos with build artifacts
bun test               # bun's test runner; many use SVG snapshot tests
bun test ./path/x.test.tsx              # single file (must contain ".test")
BUN_UPDATE_SNAPSHOTS=1 bun test ...     # update snapshots intentionally
bunx tsc --noEmit      # typecheck
bun run format         # biome format
```

- `core`'s tests are **self-contained** — no yalc needed to develop core alone.
- Solver/viewer repos have a live debugger: `bun run start` (React Cosmos) or,
  for `core`, `bun run start:benchmarking`.

### Repo-specific CI gates (check before opening a PR)

The four commands above are the *common* subset. Several repos run additional
gates in CI that will fail a PR even when tests and typecheck pass.
**`./tsc-dev pr-check <repo> <branch>` runs them for you**, derived from that
repo's own `pull_request` workflows so the list cannot go stale. Run it (or read
the repo's `.github/workflows/*.yml`) before pushing — do not assume the generic
set is sufficient.

| Repo | Gates beyond `bun test` / `bunx tsc --noEmit` |
|---|---|
| `circuit-json` | `bun run lint:zod`, `bun run check-snake-case` |
| `props` | `bun run format:check` |
| `checks` | `bun run format:check`, npm build, dependency-check |
| `circuit-json-util` | `bun run format:check` (`bun-formatcheck`), `bun-typecheck` |
| `core` | `bun-typecheck`, formatbot, dependency-check, `smoke-test-dist` |

`circuit-json`'s `lint:zod` is the easiest to miss: it enforces snake_case on
**zod enum values**, so new enum members must be `from_y_pos`, not `from_y+`.
Note `check-snake-case` is a *different, weaker* check — passing it does not
imply `lint:zod` passes.

### Expected install noise (not errors — ignore)

- `warn: incorrect peer dependency "..."` — repos pin slightly different shared
  versions (react, bun-match-svg, ...). Advisory only; install succeeds and
  build/test are unaffected.
- `Blocked N postinstalls. Run bun pm untrusted` — bun blocks lifecycle scripts
  from packages not in `trustedDependencies` by default. **Leave them blocked** —
  biome, builds, and tests all work without them (verified). Only run
  `bun pm trust <pkg>` if a package that needs a compiled native binary actually
  fails at build/runtime.
- `bun pm untrusted` → `error: Lockfile not found` — expected: most repos disable
  the lockfile (`bunfig.toml` `[install.lockfile] save = false`), so there's
  nothing to inspect. Not a problem.
- `error: Script not found "build"` from `tsc-dev publish/rebuild` — that repo is
  source-only (no build step); nothing to build, safe to ignore.

## Upstream fixes found while working on a feature

When feature work turns up an isolated upstream bug, do **not** fix it in the
feature checkout: the PR would inherit unrelated commits and a yalc-dirtied
`package.json`, and testing it churns the build/link state of your feature
environment. Give it its own worktree off upstream `main`:

```bash
./tsc-dev pr <repo> <branch> --pick <sha>       # a fix already committed on the feature branch
./tsc-dev pr <repo> <branch> --take <path>      # a fix that only exists in the working tree
./tsc-dev pr-check <repo> <branch>              # exactly the gates CI runs on a PR
./tsc-dev pr-push <repo> <branch>               # push to your fork (or origin) + open the PR
./tsc-dev pr-rm <repo> <branch> --delete-branch
```

Remote convention, identical for every developer: **`origin` is always
`tscircuit/<repo>`** (upstream) and **`fork` is your own** — set up with
`./tsc-dev fork <repo...>`, or skipped entirely if you have push access, in which
case branches go to origin. Never hardcode a username, absolute path or other
machine-specific state in a tracked workspace file; per-developer facts belong in
git remotes/config.

The worktree has its own checkout, its own `node_modules`, and (by construction,
since its `package.json` comes from upstream) no yalc links — `--take
package.json` is refused for that reason. A worktree must never `yalc publish`
into the shared `~/.yalc` store, which would replace the build your feature
environment is running on; `./tsc-dev pr-link` uses a private store inside the
worktree instead.

## Testing changes in a playground (and what to rebuild)

A *playground* is an ordinary circuit project outside this workspace (e.g.
`../tsc-playground`) with yalc links into it. Register it once, then let
watchers keep it current:

```bash
./tsc-dev playground init ../tsc-playground --effort parametric-enclosures
./tsc-dev playground start            # watchers rebuild + push on every save
./tsc-dev playground status           # works from any shell, or a later session
./tsc-dev playground logs watch-core
./tsc-dev playground stop             # ALWAYS stop when you finish
```

**Bind the playground to the effort, not to a list of repos.** The effort
already names the repos a change spans, so the watch set follows it: add a repo
to the effort and it gets watched, remove it and it stops. Docs repos in the
effort (no `package.json`) are skipped. `start` is idempotent — re-run it after
changing the effort and only the new watcher starts — and `status` flags drift
in both directions.

Daemons are `nohup`ed with a pid and a log in `.run/`, so they **outlive the
session that started them**. An agent that starts them must stop them before
finishing, or the next session inherits builds it did not start. `status` is the
way to find out what a previous session left running.

`watch <repo>` drives that repo's **own** `bun run build` through `push`, so
nothing has to be added to any repo's package.json — this stays working without
anything being upstreamed.

### Rebuild only what the path you are testing needs

Measured on this workspace: a full `circuit-json → … → tscircuit` chain is
~380s, and **runframe alone is 314s of it** (two full vite bundles). Almost
nothing else exceeds 25s. But the Node path does not need runframe at all:
`eval`'s node entry and the `tscircuit` umbrella both keep `@tscircuit/core`
**external**, resolving it from `node_modules` at runtime.

| Testing | Rebuild | Cost |
|---|---|---|
| circuit JSON, exports, `tsci build`, tests | the edited package only (`push`, or let the watcher do it) | **~10-20s** |
| browser preview (`tsci dev`) | + `eval` + `runframe` (the standalone bundle inlines the worker, which inlines core) | ~6 min |

Verified end to end: editing `core`, with only `push core`, changes the circuit
JSON that `bin/tsci build` produces in the playground. Do not rebuild the whole
chain reflexively — it is 20x slower and hides which level actually mattered.

Use `bin/tsci` (the CLI from source) or the playground's own `bunx tsci`; both
resolve core from `node_modules`, so both see a `push`ed change immediately.

## Local build versions (never hand-edit `version`)

Versions are minted by CI, not by hand: `bun-pver-release.yml` runs `pver
release` on every push to `main`, which bumps `package.json`, publishes to npm,
and commits `vX.Y.Z` back. So a checkout's version names the **published**
artifact, and any local build from it is a different package wearing that same
version. Since the yalc store (`~/.yalc/packages/<pkg>/<version>/`) and bun's
cache are both keyed by version, the two builds share a slot and substitute for
each other silently — which is how a project ends up with two incompatible
`0.0.3`s.

Rules:

- **Never bump a `version` field to iterate locally.** That only claims a number
  pver will later mint for real; it postpones the collision rather than removing
  it, and the dirty `package.json` collides with pver's own bump commit.
- Publish through `tsc-dev` (`publish` / `push` / `watch` / `rebuild`). Each
  stamps a throwaway prerelease — `0.0.4` → `0.0.4-local.20260805T094955` — for
  the duration of the build and then restores `package.json` from a byte copy,
  so no fake version reaches a commit. A prerelease sorts below its release and
  satisfies no ordinary range, so npm can never mint the same string.
- Run `./tsc-dev doctor` when a change "isn't taking effect". It distinguishes
  an unstamped (collidable) build, an npm copy that has silently overwritten a
  link, and a stale link that was rebuilt but never pushed. `./tsc-dev
  prune-store` trims the store dir each publish adds.
- Stamped packages make `bun install` print `warn: incorrect peer dependency`
  (a prerelease does not satisfy a caret range) — advisory only, like the other
  install noise listed above.

## The bundling gotcha (critical for end-to-end changes)

tscircuit packages are **inlined at build time**, not loaded as plain
node_modules at runtime:

```
core / props / circuit-json
        │  (inlined into)
        ▼
eval webworker        ──(base64-embedded into)──▶  runframe standalone.min.js
        │                                                  │ (copied into)
        └──────────────(copied into)──────────────▶  tscircuit umbrella dist
cli dev server  serves runframe's standalone + runs eval's worker
```

Therefore a `core` change does **not** appear just by `yalc add`-ing core into
the CLI — it's frozen inside eval's prebuilt bundle. To see it end-to-end you
must rebuild **bottom-up** so it gets re-inlined at each level.

**Let the chain be computed** rather than remembering it — `workspace.json`
carries the bundling graph, and `--from` walks it:

```bash
./tsc-dev rebuild --from core --dry-run     # ▶ chain from core: core eval runframe cli tscircuit
./tsc-dev rebuild --from circuit-json --to cli
```

Edges are verified against each consumer's real `package.json`, so a declared
edge that a given branch doesn't actually have is dropped instead of causing a
pointless rebuild, and repos you haven't cloned are skipped. The equivalent
explicit forms:

| Changed | Rebuild chain |
|---|---|
| core / props / circuit-json | `./tsc-dev rebuild core eval runframe cli` |
| eval | `./tsc-dev rebuild eval runframe cli` |
| runframe (UI only) | `./tsc-dev rebuild runframe cli` |
| cli | nothing — `./tsc-dev dev` re-runs it (`bun --hot`) |

Then run the full system from source against a circuit project:

```bash
./tsc-dev rebuild core eval runframe              # rebuild only what's below your change
./tsc-dev dev ../tscircuit-local --local          # serve YOUR local runframe bundle
```

`dev` runs with cwd = the project (mimicking `tsci dev`), so the project's
entrypoint/config/node_modules resolve normally. `--local` sets
`RUNFRAME_STANDALONE_FILE_PATH` to this workspace's `runframe/dist/standalone.min.js`,
which the cli re-reads per request — after `rebuild core eval runframe` just
refresh the browser. Without `--local`, the cli uses its installed (published)
packages (good for testing CLI-only changes).

To test the actual global `tsci` binary: `./tsc-dev rebuild core eval runframe
tscircuit && (cd tscircuit && npm install -g .)`.

## Before committing

Remove yalc links so each repo's package.json points back at npm versions:

```bash
./tsc-dev unlink core    # repeat for every repo you linked into
```

Leftover yalc links are the #1 cause of broken PRs.

## The tscircuit Skill

`skill/` is the org's agent Skill for *authoring* circuits — element reference,
CLI usage, syntax and workflow. It is the counterpart to this file: this one
covers developing the tscircuit packages, the Skill covers using them.

Consult `skill/elements/<element>.md` before writing TSX, rather than inferring
props from source. It is a real repo (`github.com/tscircuit/skill`), so fixes and
new elements belong there and should be PR'd upstream.

Install it into a circuit project by symlinking, so edits stay live:

```bash
mkdir -p .agents/skills .claude/skills
ln -sfn ~/src/tscircuit/skill .agents/skills/tscircuit
ln -sfn ~/src/tscircuit/skill .claude/skills/tscircuit
```

`~/src/tsc-playground` is set up this way.

## Coordinate frames and side names — where the rules live

This workspace has spent more time on side-naming and transform defects than on
any other class of bug, so the rules are written down. They are **domain law,
not workspace mechanics**, and they live in the repos whose code they govern —
an agent working in one of those repos must read that repo's `AGENTS.md` before
touching geometry:

| Repo | Owns |
|---|---|
| `circuit-json` | the direction vocabulary itself: the six canonical names, `InsertionDirection`, the `top`/`bottom` layer-vs-direction collision, the `lint:zod` snake_case gate. The authoritative reasoning is the docstring in `src/pcb/properties/insertion_direction.ts`. |
| `core` | transforms: compose rather than hand-roll, derive from the component's matrix, a layer flip is a rotation (`flipY`) not an inversion, and how to test geometry. |
| `create-fdm-enclosure` | `EnclosureFace`/`BoardWall` Cartesian face names, and the migration hazard — `top` was **+Z**, so it maps to `z_pos`, never `y_pos`. |
| `3d-viewer`, `circuit-json-to-gltf` | the renderer frames (Circuit JSON is Z-up, the scene is Y-up), the duplicated per-format normalization, and the consolidation proposal in `rfc/rfcs/2026-07-22-coordinate-frame-consolidation.md`. |

Two things worth knowing before you open any of them:

- **`front` and `back` are retired.** They meant opposite axes in different
  packages — `3d-viewer`'s `Front` camera preset is −Y, while `core`, `checks`
  and `circuit-json-to-gltf` treated front as +Y. Prefer naming the axis
  outright ("the +X face") in any new code, in any repo.
- **A change to this vocabulary spans repos.** The names are defined in
  `circuit-json` and consumed by core, the renderers and the enclosure solver,
  so a rename is a bottom-up chain (see the bundling gotcha above) and the docs
  in each repo must move with it. When you change the rule, change it where it
  lives — not here.

## Conventions agents must follow

- Use `bun`, not npm/yarn. Don't add lockfiles where repos disable them
  (`bunfig.toml` often sets `[install.lockfile] save = false`).
- Match each repo's existing style; run `bun run format` (biome) before finishing.
- File naming is kebab-case; one test per file (split into `fn1.test.ts`,
  `fn2.test.ts` rather than multiple tests per file) — see `core/AGENTS.md`.
- When a change spans repos, build/link bottom-up (see the gotcha above) and
  verify with that repo's tests before pushing via yalc.
- Don't commit workspace files (`tsc-dev`, `MAP.md`, `AGENTS.md`,
  `.tscircuit-repos.txt`) into individual repos — they belong to this workspace.
