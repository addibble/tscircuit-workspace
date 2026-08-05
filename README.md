# tscircuit development workspace

This folder is a **flat workspace** of tscircuit repos cloned as siblings
(`core/`, `props/`, ...). tscircuit is **not** a monorepo and does **not** use
git submodules — every package is its own GitHub repo published independently to
npm. Cross-repo development is done with [`yalc`](https://github.com/wclr/yalc),
a local package registry.

See the official guides:
- yalc workflow: https://github.com/tscircuit/handbook/blob/main/guides/using-yalc.md
- project overview: https://docs.tscircuit.com/contributing/overview-of-projects
- all repos: https://github.com/tscircuit

## Tooling

- **bun** for install/build/test (not npm/yarn)
- **yalc** for linking local package versions across repos
- **biome** for formatting

## The `tsc-dev` helper

`./tsc-dev` automates clone + build + yalc-linking. Run `./tsc-dev help` for all
commands. Common ones:

| Command | What it does |
|---|---|
| `./tsc-dev clone [repos...]` | clone repos from the tscircuit org as siblings |
| `./tsc-dev clone-group <group>` | bulk-clone a curated category (see `MAP.md`); run with no arg to list groups |
| `./tsc-dev clone-deps <repo> [-r]` | clone the org repos a repo depends on (its dependency closure); `-r` = recursive |
| `./tsc-dev search <pattern>` | ripgrep across every cloned repo (source only) |
| `./tsc-dev install [repos...]` | `bun install` in each repo |
| `./tsc-dev publish <repo>` | build + `yalc publish` a package to the local store |
| `./tsc-dev link <consumer> <dep>` | `yalc add` the dep's package into the consumer |
| `./tsc-dev push <repo>` | rebuild + `yalc push` to every consumer using it |
| `./tsc-dev watch <repo>` | `yalc publish --watch` (republish on change) |
| `./tsc-dev unlink <consumer>` | `yalc remove --all` + `bun install` (restore npm versions) |
| `./tsc-dev doctor [target...]` | audit yalc links: unstamped versions, npm copies that overwrote a link, stale links |
| `./tsc-dev prune-store [--keep N]` | delete old `-local.*` builds from the yalc store (released versions untouched) |
| `./tsc-dev pr <repo> <branch>` | isolated worktree off upstream main for a small upstream fix (`--pick`, `--take`) |
| `./tsc-dev pr-check <repo> <branch>` | run the gates CI runs on a PR, derived from that repo's workflows |
| `./tsc-dev pr-link <repo> <br> <dep>` | link a workspace package into a PR worktree via a private yalc store |
| `./tsc-dev pr-list` / `pr-rm` | list / remove PR worktrees |
| `./tsc-dev rebuild <repo...>` | link local deps + build + `yalc push` for each repo **in order** (propagate a change up the chain) |
| `./tsc-dev dev [path] [--local]` | run the CLI dev server **from source** on a circuit project; `--local` serves your locally-built runframe |
| `./tsc-dev status` | list cloned repos, package names, and active links |

## Dependency layers

```
tscircuit (umbrella pkg + `tsci` CLI)
├── @tscircuit/cli
├── @tscircuit/eval
├── @tscircuit/runframe   (React preview UI)
└── @tscircuit/core       (React -> Circuit JSON engine)
    ├── @tscircuit/props
    ├── circuit-json
    ├── @tscircuit/footprinter
    └── ...solvers...
```

## Exploring the code

With ~300 repos in the org, clone deliberately. See **`MAP.md`** for a
categorized guide to the repos worth looking at. Three ways to pull code:

```bash
# 1. A curated category (groups: runtime viewers exporters autorouting solvers formats importers)
./tsc-dev clone-group runtime
./tsc-dev clone-group solvers

# 2. Everything a repo actually depends on (great for "what does core use?")
./tsc-dev clone-deps core          # direct tscircuit-org deps of core (~40 repos)
./tsc-dev clone-deps core -r       # recursive: deps-of-deps too (large)

# 3. Named repos
./tsc-dev clone footprinter circuit-to-svg
```

`clone-deps` reads a repo's package.json, maps each `@tscircuit/*` (and known
unscoped) dependency to its GitHub repo, and clones it — skipping name
collisions (e.g. npm `react` vs the org's placeholder `react` repo). Repo names
are validated against `.tscircuit-repos.txt` (a cached list of active org repos;
refreshed automatically, or `gh repo list tscircuit --no-archived` to redo it).

Then search across whatever you've cloned:

```bash
./tsc-dev search "doInitialPcbComponentRender"      # find a symbol everywhere
./tsc-dev search "BaseSolver" -t ts                 # extra args pass through to rg
./tsc-dev search -l "toMatchPcbSnapshot"            # just list files
```

Good entry points once cloned: each repo's `AGENTS.md`/`CLAUDE.md` (architecture
notes), `README.md`, `lib/index.ts` (public surface), and `tests/` (runnable
examples). Solver repos have a Cosmos debugger via `bun run start`.

## Running the whole system locally with your changes

When you run `tsci dev myboard.tsx`, this is the runtime pipeline:

```
@tscircuit/cli  (dev server)
   └─ serves  standalone.min.js  ← @tscircuit/runframe   (React PCB/sch/3D UI)
                  └─ runs a Web Worker  ← @tscircuit/eval (transpiles + runs your .tsx)
                         └─ produces Circuit JSON using @tscircuit/core (+ props, circuit-json)
```

### ⚠️ The bundling gotcha (why rebuild order matters)

Packages are **inlined at build time**, not loaded as plain node_modules at runtime:

- `eval` bundles `@tscircuit/core`, `circuit-json`, `zod`, `@tscircuit/math-utils`
  into its webworker (`noExternal` in `tsup-webworker.config.ts`).
- `runframe` base64-embeds eval's webworker into `standalone.min.js`.
- the `tscircuit` umbrella copies runframe's standalone + eval's webworker into its `dist`.

So `yalc add @tscircuit/core` into the CLI does **nothing** to the rendered
output — core is frozen inside eval's prebuilt bundle. To see a change
end-to-end you must rebuild **bottom-up** so it gets re-inlined at each level:

```
core ──▶ eval ──▶ runframe ──▶ cli
```

### Strategy A — iterate on ONE package (fastest)

Most repos ship their own local debugger, so you rarely need the full stack:

- `core`: `bun run start:benchmarking` (Chrome-profilable render harness)
- `runframe`: `bun run start` (React Cosmos UI fixtures)
- solvers (autorouter, schematic-trace-solver, matchpack, ...): `bun run start` (Cosmos)
- any repo: `bun test` for snapshot tests

### Strategy B — run the real `tsci dev` from source with your changes

Clone the chain you need, install, then rebuild bottom-up and run the CLI from source:

```bash
./tsc-dev clone core eval runframe cli
./tsc-dev install core eval runframe cli

# After editing core (or props/circuit-json), propagate up the chain:
./tsc-dev rebuild core eval runframe cli

# Run the dev server from source against your circuit file:
./tsc-dev dev ../my-project/index.circuit.tsx
```

`rebuild` auto-links any dependency that is also cloned in this workspace, builds
each repo, and `yalc push`es it before moving to the next — so the change is
re-inlined at every level. **Only rebuild what's below your change:**

| You changed... | Rebuild chain |
|---|---|
| `core`, `props`, `circuit-json` | `core eval runframe cli` (or just `eval` for the worker, then on up) |
| `eval` | `eval runframe cli` |
| `runframe` (UI only) | `runframe cli` |
| `cli` | nothing — just `./tsc-dev dev` re-runs it (`bun --hot`) |

### Rendering an external circuit project with your local dev version

To open a project (e.g. `../tscircuit-local`, normally run via the global
`tsci dev`) using your **workspace** packages instead of the installed ones:

```bash
# 1. Build the chain so your local core gets re-inlined up through runframe:
./tsc-dev rebuild core eval runframe          # only rebuild what's below your change

# 2. Run the dev server from source, serving YOUR local runframe bundle:
./tsc-dev dev ../tscircuit-local --local      # add --port 3030 etc. as needed
```

How it works: the cli serves runframe's self-contained `standalone.min.js`
(which embeds the eval worker + core). `--local` points the cli at
`runframe/dist/standalone.min.js` in this workspace via the
`RUNFRAME_STANDALONE_FILE_PATH` env var, which the cli **re-reads on every
request**. So after editing core: `./tsc-dev rebuild core eval runframe`, then
just **refresh the browser** — no server restart.

- Without `--local`, `./tsc-dev dev ../tscircuit-local` runs the local CLI but
  with its installed (published) core/eval/runframe — useful for testing CLI
  changes against a real project.
- `dev` runs with cwd = your project, so your `package.json`/`tscircuit.config`
  entrypoint, `imports/`, and `node_modules` all resolve exactly as with `tsci`.

### Testing the actual published `tsci` binary / global install

The `tscircuit` umbrella package is what `npm i -g tscircuit` installs. To test
that exact artifact with your changes, also rebuild it after the chain:

```bash
./tsc-dev rebuild core eval runframe tscircuit
cd tscircuit && npm install -g .   # installs your local `tsci`/`tscircuit` globally
```

## Workflows

### Just hacking on `core` (no yalc needed)

`core`'s tests are self-contained snapshot tests:

```bash
cd core
bun install
bun test                              # run everything
bun test ./tests/.../resistor-schematic.test.tsx   # one file
BUN_UPDATE_SNAPSHOTS=1 bun test path/to/file.test.tsx  # update snapshots
bunx tsc --noEmit                     # typecheck
bun run format                        # biome format
```

### A change that spans repos (e.g. edit `props`, test in `core`)

```bash
./tsc-dev clone core props
./tsc-dev install core props
./tsc-dev publish props        # build props -> local yalc store
./tsc-dev link core props      # core now consumes your local props
cd core && bun test
# after editing props again:
cd .. && ./tsc-dev push props  # rebuild + push to every consumer
```

### Edit `core` and see it in the CLI / preview

```bash
./tsc-dev clone tscircuit core runframe
./tsc-dev install tscircuit core runframe
./tsc-dev publish core
./tsc-dev link tscircuit core
# (optionally also: publish/link runframe for UI changes)
```

### Before committing

Always remove yalc links so package.json points back at npm versions:

```bash
./tsc-dev unlink core    # yalc remove --all && bun install
./tsc-dev unlink eval    # ...repeat for every repo you linked into
```

## Upstream fixes while mid-feature

Large feature work keeps turning up small, self-contained upstream bugs that
should be PR'd immediately. Fixing them in your feature checkout is wrong on
both ends: the PR inherits unrelated feature commits and a yalc-dirtied
`package.json`, and testing it churns the build/link state you had set up.

`./tsc-dev pr` gives the fix its own git worktree off upstream `main`:

```bash
# a fix you have already committed on your feature branch:
./tsc-dev pr circuit-json fix/enum-snake-case --pick a1b2c3d

# a fix that only exists in your working tree:
./tsc-dev pr core fix/pad-transform --take lib/components/Pad.ts

./tsc-dev pr-check core fix/pad-transform      # exactly what CI runs on a PR
cd .worktrees/core/fix/pad-transform
git push -u fork fix/pad-transform && gh pr create -R tscircuit/core
./tsc-dev pr-rm core fix/pad-transform --delete-branch
```

Isolation is real in the three ways that matter:

1. **Separate checkout** — your feature branch and its dirty tree are untouched;
   `git worktree` shares the object store, so this costs no extra clone.
2. **Separate `node_modules`** — `bun install` runs inside the worktree.
3. **No yalc links** — the worktree's `package.json` comes from upstream `main`,
   so it carries none by construction. `--take package.json` is *refused* for
   exactly this reason. If the fix genuinely needs a local dependency, use
   `pr-link`, which publishes through a private store inside the worktree
   (`yalc --store-folder`) rather than the global `~/.yalc` your feature
   environment is running on.

### `pr-check` derives the gates, it doesn't hardcode them

Gates are read from the repo's own `pull_request`-triggered workflows, so the
repo-specific ones can't drift out of a hand-maintained table:

```
core          bunx tsc --noEmit · bunx @tscircuit/dependency-check · biome format .
              bun run build · bun run smoke-test:dist · bun test
circuit-json  bun test · bunx tsc --noEmit · bun run check-snake-case · bun run lint:zod
props         bun test · biome format . · bun run format:check · bunx tsc --noEmit
```

Order is workflow order, not alphabetical, so `build` precedes `smoke-test:dist`.
Release, bot and codegen jobs are excluded (they aren't PR gates), as are
mutating steps (`--write`) and CI-sharding helpers. `bun test` is appended when
the repo has test files, because several repos invoke it from a matrix-sharded
multi-line step that no line-level parse can reconstruct — and the correct local
equivalent is simply the whole suite.

## Local build versions

**Never hand-edit a `version` field to iterate locally.** Versions in this
ecosystem are minted by CI: `.github/workflows/bun-pver-release.yml` runs
`pver release` on every push to `main`, which bumps `package.json`, publishes to
npm, and commits the bump back as `vX.Y.Z` (authored by
`GitHub Actions <actions@github.com>`). Two consequences:

1. A fresh checkout's version **is** the published artifact's version. Anything
   you build locally from it is a *different package wearing the same name and
   version*.
2. Bumping it yourself only mints a number pver will later mint for real, moving
   the collision into the future instead of removing it.

This matters because the yalc store is keyed by version
(`~/.yalc/packages/<pkg>/<version>/`) and so is bun's module cache, so the local
and published builds land in the same slot and substitute for each other with no
error anywhere. That is exactly how a project ends up with two incompatible
`0.0.3`s.

`publish`, `push`, `watch` and `rebuild` therefore stamp a throwaway prerelease
into `package.json` for the duration of the build, then restore the file:

```
0.0.4  ->  published to the yalc store as  0.0.4-local.20260805T094955
```

A prerelease sorts *below* its release (`0.0.4-local.1` < `0.0.4`) and satisfies
no ordinary semver range, so it can never be confused with — or silently
accepted in place of — anything npm will ever publish. `package.json` is
restored from a byte copy (also on Ctrl-C, via a trap), so a fake version can
never reach a commit or a PR diff.

```bash
./tsc-dev doctor                     # audit every project yalc knows about
./tsc-dev doctor ../my-project core  # or specific paths / repo names
./tsc-dev prune-store --keep 2       # each publish adds a store dir; trim them
```

`doctor` reports the three ways a link goes wrong:

| Symptom | Meaning |
|---|---|
| `⚠ unstamped: claims a version npm can also mint` | published before stamping existed (or with `TSC_DEV_NO_STAMP=1`) — re-push it |
| `✗ node_modules holds an npm copy, not the link` | an install silently resolved the name from the registry; the local build is simply gone |
| `✗ stale: node_modules <sig> != .yalc <sig>` | the producing repo was rebuilt but never pushed |

Expect `bun install` to warn `incorrect peer dependency` for stamped packages
(a prerelease does not satisfy a caret range). That warning is advisory only and
is already routine in this workspace. Set `TSC_DEV_NO_STAMP=1` to publish the
literal version if you ever need to reproduce the un-stamped behaviour.

Note: this workspace's own files (`tsc-dev`, this README) and the cloned repos
are independent git checkouts — there is no top-level git repo tracking them.
