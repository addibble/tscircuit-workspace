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

Configuration comes in two layers, with different homes and different git
histories:

| Layer | File | Lives on | Holds |
|---|---|---|---|
| **shared** | `workspace.json` | this repo's `main` | clone groups, the bundling graph, the default clone set |
| **yours** | `.local/workspace.local.json` | orphan branch `user/<login>`, pushed to **your fork** | your patch-set effort, personal overrides, the environment lock |

The local layer is deep-merged over the shared one and wins. The test for where
a key belongs: *would every developer's copy hold the same value?* Shared if
yes, local if no.

```bash
./tsc-dev local init --remote git@github.com:<you>/<workspace-repo>.git
./tsc-dev config                 # effective config + which layer each key came from
./tsc-dev local save -m "..."    # commit + push your layer to your fork
```

The local layer is an **orphan branch** — built from an empty tree with no
parent, so it shares no history with `main`. It therefore cannot be
fast-forwarded or merged into `main` by accident, and a PR branched from `main`
can never drag it along. `local save` additionally refuses to push if `fork` and
`origin` resolve to the same URL.

`workspace.json` holds the shared configuration — the curated clone groups, the
build-time **bundling graph** that `rebuild --from` walks, and the fork/patch-set
efforts `sync-forks` updates. Add a group, a bundling edge or an effort there
rather than editing the script; `MAP.md` is its prose companion.

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
| `./tsc-dev watch <repo>` | rebuild + `yalc push` that repo on every source change (debounced) |
| `./tsc-dev playground <sub>` | register a test project and manage its watcher/dev-server daemons |
| `./tsc-dev unlink <consumer>` | `yalc remove --all` + `bun install` (restore npm versions) |
| `./tsc-dev doctor [target...]` | audit yalc links: unstamped versions, npm copies that overwrote a link, stale links |
| `./tsc-dev prune-store [--keep N]` | delete old `-local.*` builds from the yalc store (released versions untouched) |
| `./tsc-dev pr <repo> <branch>` | isolated worktree off upstream main for a small upstream fix (`--pick`, `--take`) |
| `./tsc-dev pr-check <repo> <branch>` | run the gates CI runs on a PR, derived from that repo's workflows |
| `./tsc-dev pr-push <repo> <branch>` | push the branch to your fork (or origin) and open the PR |
| `./tsc-dev fork <repo...>` | create your fork and wire it up as the `fork` remote (`--org` for orgs) |
| `./tsc-dev pr-link <repo> <br> <dep>` | link a workspace package into a PR worktree via a private yalc store |
| `./tsc-dev pr-list` / `pr-rm` | list / remove PR worktrees |
| `./tsc-dev rebuild <repo...>` | link local deps + build + `yalc push` for each repo **in order** (propagate a change up the chain) |
| `./tsc-dev dev [path] [--local]` | run the CLI dev server **from source** on a circuit project; `--local` serves your locally-built runframe |
| `./tsc-dev status` | list cloned repos, package names, and active links |
| `./tsc-dev local <init\|save\|sync\|status>` | manage your config layer (orphan branch, pushed to your fork) |
| `./tsc-dev config [key]` | effective merged config + which layer each key came from |
| `./tsc-dev freeze` | snapshot this build environment into your layer |
| `./tsc-dev env <add\|show\|diff\|adopt>` | read and reproduce a peer's build environment |
| `./tsc-dev helpers <query>` | does this helper already exist? (`--dupes`, `--added <repo>`) |
| `./tsc-dev gen-map [--check]` | regenerate (or verify) MAP.md's group sections from `workspace.json` |
| `./tsc-dev test` | run the workspace's own test suite |

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
./tsc-dev rebuild --from core          # chain computed from workspace.json
./tsc-dev rebuild core eval runframe cli   # or spell it out

# Run the dev server from source against your circuit file:
./tsc-dev dev ../my-project/index.circuit.tsx
```

`rebuild` auto-links any dependency that is also cloned in this workspace, builds
each repo, and `yalc push`es it before moving to the next — so the change is
re-inlined at every level. **Only rebuild what's below your change** — which is
what `--from` computes for you, from the `bundling.inlines` graph in
`workspace.json`:

```bash
./tsc-dev rebuild --from core --dry-run
▶ chain from core: core eval runframe cli tscircuit

./tsc-dev rebuild --from circuit-json --to cli --dry-run
▶ chain from circuit-json: circuit-json core eval 3d-viewer runframe cli
```

The graph is advisory and deliberately a superset of literal inlining — one
level too many is harmless, one level too few silently ships a stale bundle —
but every edge is verified against the consumer's real `package.json` before use,
so an edge a given branch doesn't actually have is dropped rather than costing a
rebuild. Uncloned repos are skipped. The explicit equivalents:

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

### Don't write a helper that already exists

The most common avoidable defect in this codebase is a small utility written
from scratch that already exists — and the copy is usually subtly wrong, in a
way nothing throws on. A hand-rolled `toMm` doing `Number.parseFloat` handles
`"2mm"` correctly and turns `"1cm"` into 1 instead of 10.

```bash
./tsc-dev helpers bounds          # exported symbols matching a name, across every cloned repo
./tsc-dev helpers --dupes         # names already exported by several packages (currently 135)
./tsc-dev helpers --added core    # new exports on a branch that shadow an existing helper
```

`pr-check` **gates** on this: a branch exporting a name that already exists
fails, alongside the repo's own CI gates. Tests, fixtures and examples are
excluded. Reuse the existing helper, fix it where it lives, or rename yours —
and if it genuinely must differ, say why in a comment and pass `--allow-dupes`.

The canonical homes are listed in `AGENTS.md` — `format-si-unit` (via
`circuit-json`'s `length`/`distance`) for units, `@tscircuit/math-utils` and
`@tscircuit/circuit-json-util` for bounds, `transformation-matrix` for 2D
transforms, `@jscad/modeling` for solids, `@tscircuit/solver-utils` for solvers.

Finding an existing helper is the start, not the end: read it before reusing it.
`helpers rotatePoint` returns four implementations with four different
conventions (radians vs degrees, with and without an origin, 2D vs 3D), and
picking the wrong one compiles perfectly.

## Working on the tooling

```bash
./tsc-dev test              # bun test ./test/
./tsc-dev gen-map --check   # MAP.md must match workspace.json
```

The parts that can silently give a *wrong answer* live in `bin/*.mjs` with tests
in `test/`, rather than in the bash:

| Module | Pinned behaviour |
|---|---|
| `workspace-config.mjs` | layer merge: objects merge per key, arrays replace, inputs are not mutated |
| `rebuild-chain.mjs` | dependencies precede consumers; `--to` truncation; unverified edges dropped; uncloned repos skipped; cycles reported |
| `ci-gates.mjs` | only `pull_request` workflows; workflow order preserved; installs/bots/mutating steps excluded; no cross-file fusion |
| `find-helpers.mjs` | which export forms are indexed; non-exports and re-exports ignored |
| `is-main.mjs` | a CLI run through a symlinked path still counts as main |
| `env-lock.mjs` | which discrepancies are *differences* (fail) vs *warnings* (dirty tree, extra repos) |
| `gen-map.mjs` | only the marked block is replaced; regeneration is idempotent; missing markers error |

Two conventions those modules follow, both learned from bugs found here.

**Importing a module must have no side effects.** Every CLI body sits behind
`if (isMain(import.meta.url))` from `bin/is-main.mjs`. This has failed twice, in
two ways that look nothing alike:

- *no guard* — the CLI runs on import, inherits the test runner's argv, prints
  usage and calls `process.exit()`, taking the whole test run with it;
- *naive guard* — `import.meta.url === pathToFileURL(process.argv[1]).href` is
  false whenever any path component is a symlink, because node resolves symlinks
  when loading a module and the shell does not. The CLI then does nothing and
  exits 0, which looks like success. `/tmp` is a symlink on macOS, so this is
  not theoretical: it silently broke `workspace-config.mjs --explain` inside an
  adopted workspace.

`test/bin-modules.test.ts` imports every `bin/*.mjs` in a subprocess and fails
if it produces any output, so neither form can return.

**Decision logic is pure with the filesystem injected**, so a test states the
rule instead of building a workspace on disk.

There is deliberately **no root `package.json`**: bun walks up from a
subdirectory to find one, so a root manifest would change how `bun install`
resolves inside every cloned repo and diverge from CI. The tests need no
dependencies, so none is required — but always pass an explicit path (as
`./tsc-dev test` does), or `bun test` will walk into all ~60 cloned repos.

## Contributing from a fork (this workspace is not tied to any one account)

Nothing in this repo names a person. Your GitHub identity lives in each
checkout's **git remotes**, which are per-user and untracked, under a convention
that means the same thing for everyone:

```
origin  = github.com/tscircuit/<repo>    upstream — identical for every developer
fork    = github.com/<you>/<repo>        yours
```

```bash
./tsc-dev fork core circuit-json          # creates the forks + wires the remotes
./tsc-dev fork core --org my-org          # or fork into an organization
```

This deliberately does *not* use `gh repo fork`'s default behaviour, which
renames `origin` to `upstream` and makes your fork `origin`. Every other command
here — `pr --base origin/main`, `sync-forks`, `rebuild_chain` — means "upstream"
when it says `origin`, and that has to hold in your checkout and a new
contributor's alike, so `fork` is added as an extra remote instead.

**Maintainers with write access need no fork.** `./tsc-dev fork` detects push
permission and tells you to branch on origin instead, and `pr-push` picks the
remote the same way: `fork` if the remote exists, otherwise `origin` if GitHub
reports push access, otherwise it stops and tells you to run `./tsc-dev fork`.

```bash
./tsc-dev pr-push core fix/pad-transform              # push + open a DRAFT pr
./tsc-dev pr-push core fix/pad-transform --url-only   # push only, print the compare URL
```

**Every PR this tool opens is a draft, and nothing here ever takes one out of
draft.** There is no flag for a ready-for-review PR; `--ready`, `--no-draft` and
friends are refused rather than silently ignored. Moving a PR out of draft is a
human decision — click "Ready for review" when you mean it. `--url-only` goes
further and creates nothing, printing the compare URL for you to click.

Re-running `pr-push` after a PR exists reports the existing one instead of
failing, and `--fill` takes the title and body from the branch's commit, so it
never stops to prompt when run unattended.

When pushing to a fork, the PR head is qualified as `<owner>:<branch>` — that
qualification is what makes a cross-repo PR work for a contributor without write
access. `pr-push` also refuses to push a `package.json` that still contains
`file:.yalc/` links.

**Rule for anything added to this repo:** no absolute paths, no usernames, no
machine-specific state. Per-developer facts belong in git remotes or git config.
(`bin/tsci` hardcoded one developer's `/Users/.../src/tscircuit` and now derives
the workspace root from its own location.)

## Sharing a build environment

"My build environment" here is not one commit: it is which repos are cloned,
which **remote and branch** each is on (often a fork, for patch sets that aren't
upstream yet), the exact SHA, and which yalc links are wired between them. That
tuple is what makes two developers' `bun test` runs comparable.

```bash
./tsc-dev freeze                 # snapshot it into .local/workspace.lock.json
./tsc-dev local save -m "snapshot: parametric-enclosures"
```

Because the lock rides on your user branch on your fork, anyone can reproduce it:

```bash
./tsc-dev env add addibble https://github.com/addibble/tscircuit-workspace.git
./tsc-dev env show addibble       # their repos, branches, SHAs, fork URLs, links
./tsc-dev env diff addibble       # how your checkout differs from theirs
./tsc-dev env adopt addibble --into ~/src/tsc-addibble    # reproduce it
```

A peer's branch is read with `git show` — nothing of theirs is ever checked out
over your work. `adopt --into <dir>` builds a **fresh** workspace (clone of the
tooling + every locked repo at its locked SHA), which is the only way to get an
exact copy without disturbing your own; `--here` mutates the current workspace
and skips any repo with uncommitted changes.

The critical detail is that the lock records each branch's **remote URL**, not
just its name. Six of the repos here sit on `addibble/*` forks; without the URL,
adopting would silently reproduce upstream instead and the difference wouldn't
surface until a test failed. `adopt` adds that remote verbatim (named for the
peer) before checking out the SHA.

`env diff` separates **differences** (not cloned, wrong SHA, missing yalc link —
exit 1) from **warnings** (uncommitted changes, extra repos or links — exit 0),
because a yalc link rewrites `package.json` and so a dirty tree is the normal
working state here, not a discrepancy.

## Playgrounds: keeping a test project current

A playground is an ordinary circuit project outside this workspace with yalc
links into it. Register it once; watchers then keep it current on every save.

```bash
./tsc-dev playground init ../tsc-playground --effort parametric-enclosures
./tsc-dev playground start             # watchers + the web viewer on :3020
./tsc-dev playground start --no-dev    # watchers only
./tsc-dev playground status            # from any shell, in any later session
./tsc-dev playground logs dev-tsc-playground
./tsc-dev playground stop
```

The web viewer starts **by default** — `start` runs `tsc-dev dev --local`,
serving your locally-built runframe standalone with the local eval worker
injected, at `http://localhost:3020/#file=<entrypoint>`. `--no-dev` (or
`"dev": false` on the playground) starts watchers only. If runframe has never
been built locally, `start` says so instead of failing silently.

What the running viewer picks up, and what it does not:

| Edit | Seen after |
|---|---|
| the playground's own `.tsx` | saving — the dev server watches the project |
| a watched package (`core`, `props`, …) on the **Node** path (`tsci build`, exports) | the watcher's push, ~10-20s |
| a watched package in the **browser** view | rebuilding `eval` (its webworker inlines core) and restarting the dev server, which re-injects the worker |
| `runframe`'s own UI | rebuilding runframe (~5 min) |

That asymmetry is inherent: the browser runs eval inside runframe's prebuilt
bundle, so package changes reach it only when that bundle is re-inlined.

### Bind the playground to an effort, not to a list of repos

An effort already names the repos a change spans, so `--effort <name>` derives
the watch set from it. Add a repo to the effort and it is watched; remove it and
it stops being watched — there is no second list to keep in sync. Repos in the
effort with no `package.json` (docs repos like `rfc` and `skill`) are skipped,
since there is nothing to build or push from them.

Resolution order, most specific first:

1. an explicit `--watch a,b` list on the playground,
2. `--effort <name>` — every package in that patch set,
3. otherwise the playground's own `yalc.lock`.

`start` is **idempotent**: already-running watchers are left alone, so after
adding a repo to the effort, re-running it starts only the new watcher.
`status` reports drift in both directions — a repo in the set with no watcher,
and a watcher for a repo that has left the set.

`watch` drives each repo's **own** `bun run build` through `push` (build, stamp,
propagate). Nothing is added to any repo's `package.json`, so none of this
depends on a change being accepted upstream.

Daemons are `nohup`ed with a pid and log in `.run/`, so they survive the shell
— and the agent session — that started them. That is the point (a later session
can `status`/`stop` them), but it also means **whoever starts them must stop
them**.

### A watcher must not react to its own build

The first run of this exposed three self-trigger loops within seconds: `tsup`
writes `tsup.config.bundled_*.mjs` beside its config, `push` stamps and restores
`package.json`, and `yalc push` rewrites `yalc.lock` — each retriggering the
build that wrote it. Those paths are excluded (with tests, in
`test/watch-run.test.ts`), and the watcher debounces, serializes runs, and keeps
at most one queued.

The trade-off: a genuine `package.json` edit no longer retriggers a build.
Restart the watcher after one. A missed rebuild is cheap and visible; an
infinite rebuild loop burns a core until noticed.

### Rebuild only what the path you are testing needs

Measured here, rebuilding the whole chain takes ~380s — and **runframe is 314s
of it** (two full vite bundles). Nothing else exceeds 25s; `core` builds in 10s
and the yalc copy costs 0.6s.

The Node path does not need runframe: `eval`'s node entry and the `tscircuit`
umbrella keep `@tscircuit/core` **external** and resolve it from `node_modules`.
Only the browser preview needs the standalone bundle, because that inlines the
eval worker, which inlines core.

| Testing | Rebuild | Cost |
|---|---|---|
| circuit JSON, exports, `tsci build`, tests | the edited package only | **~10-20s** |
| browser preview (`tsci dev`) | + `eval` + `runframe` | ~6 min |

Verified with a probe: editing `core` and pushing **only** `core` changed the
circuit JSON produced in the playground, via both `bin/tsci` and the
playground's own `bunx tsci`.

### Does yalc do live linking?

No. `yalc link` symlinks `node_modules/<pkg>` to `.yalc/<pkg>`, which is a
*snapshot copied from the store* — tested directly: editing the source without
republishing leaves the consumer on the old code. Every yalc mode publishes
built output, so yalc can shorten the copy, not the build. Since the copy is
0.6s of an 11s cycle, the watcher (which removes the manual step, not the build)
is the practical answer.

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
