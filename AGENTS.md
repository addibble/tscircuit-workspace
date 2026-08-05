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
| `doctor [target...]` | audit yalc links (unstamped versions, npm copies that overwrote a link, stale links) |
| `prune-store [--keep N]` | delete old `-local.*` builds from the yalc store |
| `pr <repo> <branch>` | isolated worktree off upstream main for a small upstream fix (`--pick`, `--take`) |
| `pr-check <repo> <branch>` | run the PR gates CI runs, derived from that repo's workflows |
| `dev [file]` | run the CLI dev server **from source** |
| `unlink <consumer>` | `yalc remove --all` + `bun install` (restore npm versions) |
| `status` | list cloned repos, package names, active yalc links |

## Repo layout & discovery

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
./tsc-dev pr-rm <repo> <branch> --delete-branch
```

The worktree has its own checkout, its own `node_modules`, and (by construction,
since its `package.json` comes from upstream) no yalc links — `--take
package.json` is refused for that reason. A worktree must never `yalc publish`
into the shared `~/.yalc` store, which would replace the build your feature
environment is running on; `./tsc-dev pr-link` uses a private store inside the
worktree instead.

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
must rebuild **bottom-up** so it gets re-inlined at each level. Rebuild only
what's below your change:

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

## Coordinate frames, side names, and transforms

This workspace has spent more time on side-naming and transform defects than on
any other class of bug. The rules below are the settled outcome. They apply in
every repo, to code, prose, enum values and test names.

### Canonical direction names

A direction name states **where something is**, not which way it travels, and it
is always expressed in board/project space:

| Axis | Name | `insertion_direction` |
| --- | --- | --- |
| +X | `right` | `from_right` |
| −X | `left` | `from_left` |
| +Y | `top` | `from_top` |
| −Y | `bottom` | `from_bottom` |
| +Z | `above` | `from_above` |
| −Z | `below` | `from_below` |

Published in `circuit-json` as `InsertionDirection`. The Cartesian and
deprecated spellings are still accepted **as input** and normalized through
`insertionDirectionToCanonical`; emitted Circuit JSON always carries one of the
six canonical names.

**`front` and `back` are retired.** They meant opposite axes in different parts
of the ecosystem — `3d-viewer`'s `Front` camera preset is −Y, while `core`,
`checks` and `circuit-json-to-gltf` treated front as +Y — and that disagreement
is the root of most defects in this area. Do not reintroduce them in new code,
enum values, comments or docs. **Prefer naming the axis outright** ("the +X
face") wherever a sentence can carry it; a named direction is a convenience, the
axis is the truth.

### The layer/direction collision — the one real gotcha

`top` and `bottom` name **different axes** depending on what owns them:

| Owner | `top` | `bottom` |
| --- | --- | --- |
| direction / `insertion_direction` | **+Y** | **−Y** |
| **PCB layer** (`layer="top"`, `originalLayer`) | **+Z** | **−Z** |

A PCB layer is a Z concept; a direction is a Y concept. They are unrelated
quantities that happen to share two words. Whenever a symbol named `top` or
`bottom` crosses a boundary, say in the docstring which of the two it is. Note
also that a *component* carries `layer`, while a `<footprint>` carries
`originalLayer`; the part is mirrored when the two differ. Enclosure faces avoid
the ambiguity entirely by using Cartesian names — see below.

### Enclosure faces are named Cartesian

Because the collision above is worst for enclosure geometry — where a face can
plausibly be ±Y *or* ±Z — enclosure and board faces skip named directions and
use the axis outright. `EnclosureFace` (`create-fdm-enclosure`) and `BoardWall`
(`core`) are both:

```ts
"x_pos" | "x_neg" | "y_pos" | "y_neg" | "z_pos" | "z_neg"
```

Spelled `_pos`/`_neg` rather than `+`/`-` to match the already-published
`InsertionDirectionCartesian` (`from_x_pos`, `from_y_neg`, …) and because
Circuit JSON enum values must be snake_case (`circuit-json/scripts/zod-lint.ts`),
so one spelling works on both sides of that boundary with no translation layer.

Since both types use the same names, converting a board wall to an enclosure
face is an identity — assert that rather than mapping it.

| `insertion_direction` | face |
| --- | --- |
| `from_right` | `x_pos` |
| `from_left` | `x_neg` |
| `from_top` | `y_pos` |
| `from_bottom` | `y_neg` |
| `from_above` | `z_pos` |
| `from_below` | `z_neg` |

**Migration hazard — `top` and `bottom` change meaning.** In the old
`EnclosureFace` they were the **Z** faces (lid and floor), not the Y walls:

| old name | axis | new name |
| --- | --- | --- |
| `right` | +X | `x_pos` |
| `left` | −X | `x_neg` |
| `front` | +Y | `y_pos` |
| `back` | −Y | `y_neg` |
| `top` | **+Z** | `z_pos` |
| `bottom` | **−Z** | `z_neg` |

So `top → z_pos`, **not** `y_pos`. A mechanical rename that reads `top` as +Y
moves lid apertures onto a side wall, and the geometry still resolves, so
nothing throws. Migrate by axis, never by word, and check `getFaceNormalAxis` /
`getFaceNormalSign` agree afterwards. Watch `BoardWall` especially: `front` is
−Y on core's `main` but +Y on `feat/parametric-enclosures`, so the correct
target depends on which definition you are converting.

### Transforms

1. **Compose; never hand-roll a rotation matrix.** Use the repo's existing
   matrix library (`transformation-matrix` in `core`) with `compose()` and
   `applyToPoint()`. Hand-written `x*cos − y*sin` is exactly how the
   `insertion_direction` flip bug survived: the direction math and the pad
   geometry were two independent implementations of "the same" transform, and
   they silently disagreed on bottom-layer parts.
2. **Find the reference transform first.** Before writing a transform for some
   object, find an object that already moves the same way and build from the
   same expression. Anything that follows a component — pads, silkscreen, a
   derived direction — must be derived from the component's matrix, so it cannot
   drift when that matrix changes.
3. **Cite what you copied.** Name the file, symbol and branch in a comment next
   to the code, and quote the expression if it is short. A reader must be able
   to check agreement without re-deriving the geometry.
4. **Composition order is load-bearing.** `compose(a, b)` applies **b first**.
   Reflections and rotations do not commute (`F·R(θ) = R(−θ)·F`), so a wrong
   order is not a cosmetic difference — it silently inverts results at some
   angles and not others.
5. **A layer flip is a rotation, not an inversion.** `core` flips to the bottom
   layer with `flipY()` (mirror *on* the y-axis, i.e. negate X), a 180° rotation
   about Y: `(x, y, z) → (−x, y, −z)`. Exactly two components invert. Negating
   all three would be an improper transform (determinant −1) and would turn the
   part into its own mirror image.

### Declare the frame at every boundary

Any function or record that carries geometry states explicitly, in its
docstring: **which frame** (footprint-local, board/circuit world, renderer/glTF
scene), **what the axes mean**, **units** (mm throughout tscircuit),
**handedness and which way is up**, and **whether the value is a point or a
direction** — a point picks up translation, a direction must not.

### Validate a convention before copying it

Matching surrounding code is the default *only* once you have confirmed the
surrounding code is intentional. Prevailing patterns here have repeatedly turned
out to be bugs or compensations for bugs elsewhere. Before adopting one, find
its origin commit, the test that pins it, or a measurement that confirms it —
and prefer removing a compensation at its source over adding a matching one.

**The 3D renderers are the highest-risk area** and the biggest cleanup
opportunity: duplicated per-format normalization, hardcoded rotations, a late
X-mirror in the glTF builder, and separate transform tables in `3d-viewer` and
`circuit-json-to-gltf`. See `rfc/rfcs/2026-07-22-coordinate-frame-consolidation.md`.

### Testing geometry

- **Derive expectations from ground truth, not from the transform.** Assert
  against where geometry actually lands (emitted pad coordinates), so the test
  still fails if the transform and the geometry ever diverge again. A test that
  restates the implementation only pins the implementation — including its bugs.
- **Make probes discriminating.** A marker at `x = 0` cannot detect an X mirror,
  and 90°/270° rotations cannot distinguish a wrong mirror axis (there, wrong
  and right agree exactly). Use off-axis markers and cover 0°/180° *and*
  90°/270°, on both layers.
- **Never blind-rebaseline a snapshot.** Look at the image. A rebaseline here
  once silently disabled the very regression guard its test comment described.
  Caption snapshots (see `tests/fixtures/caption-png.ts`) so a wrong render
  reads as wrong in a diff viewer rather than merely different.

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
