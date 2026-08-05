# tscircuit repo map

There are ~300 active repos in https://github.com/tscircuit. You almost never
want all of them. This is a curated guide to the ones worth exploring, grouped
by what they do. Clone a whole group with `./tsc-dev clone-group <group>`, or
clone everything a repo depends on with `./tsc-dev clone-deps <repo> -r`.

> Tip: the live internal dependency graph is at https://deps.tscircuit.com
> and a directory of the major packages is the `make-electronics-with-code` repo.

## Runtime / rendering chain  (`clone-group runtime`)
The packages that turn your React/TSX into a rendered board. This is the
"system" — see the bundling chain notes in the workspace README.
- **tscircuit** — umbrella package + the `tsci` CLI binary
- **cli** (`@tscircuit/cli`) — `tsci dev` local server, push/export/build commands
- **runframe** (`@tscircuit/runframe`) — React preview UI (PCB/schematic/3D), runs eval in a worker
- **eval** (`@tscircuit/eval`) — transpiles + evaluates TSX to Circuit JSON (in a web worker)
- **core** (`@tscircuit/core`) — the React reconciler + component engine (you have this)
- **props** (`@tscircuit/props`) — zod prop schemas for every component
- **circuit-json** — the low-level data format everything speaks

## Viewers  (`clone-group viewers`)
React components / libs that render Circuit JSON.
- **pcb-viewer**, **schematic-viewer**, **3d-viewer**, **assembly-viewer**, **table-viewer**
- **circuit-to-svg** — Circuit JSON → schematic/PCB/assembly SVG (used everywhere, incl. snapshot tests)
- **circuit-to-canvas**, **circuit-to-png**

## Exporters  (`clone-group exporters`)
Circuit JSON → manufacturing / interchange formats.
- **circuit-json-to-gerber**, **circuit-json-to-kicad**, **circuit-json-to-step**
- **circuit-json-to-spice**, **circuit-json-to-gltf**, **circuit-json-to-bom-csv**, **circuit-json-to-pnp-csv**
- **circuit-json-to-readable-netlist**, **circuit-json-to-dsn**

## Importers / converters  (`clone-group importers`)
- **easyeda-converter**, **kicad-to-circuit-json**, **kicad-converter**
- **svg-to-tscircuit**, **circuit-json-to-tscircuit**, **dsn-converter**

## Autorouting  (`clone-group autorouting`)
- **tscircuit-autorouter** / **capacity-autorouter** — the main MIT autorouter
- **infgrid-ijump-astar**, **bus-router**, **high-density-a01**, **freerouting-cli**
- **schematic-trace-solver** — schematic trace + net-label placement

## Layout solvers  (`clone-group solvers`)
Standalone 2D algorithms, each with its own Cosmos/`bun run start` debugger.
- **matchpack**, **calculate-packing** (`pack`), **copper-pour-solver**, **breakout-point-solver**
- **schematic-match-adapt**, **solver-utils** (the `BaseSolver` framework + `GenericSolverDebugger`)
- **miniflex** (flexbox), **minicssgrid** (css grid), **bpc-graph** (box-pin-color graph)

## Formats / parsers  (`clone-group formats`)
- **footprinter** — footprint DSL (`0402`, `soic8`, ...)
- **schematic-symbols** — schematic symbol SVG library
- **kicadts**, **dsnts**, **gerberts**, **stepts** — typed bindings for KiCad/DSN/Gerber/STEP
- **circuit-json-util** — helpers for querying/transforming Circuit JSON
- **props**, **circuit-json** (also in runtime)

## Utilities you'll see in lots of package.jsons
- **graphics-debug** — turn debug output into visual markdown (used by solvers)
- **math-utils**, **format-si-unit**, **mm**, **connectivity-map**, **calculate-elbow**

## Apps / sites (mostly for reference, not libraries)
- **tscircuit.com** — playground / online editor
- **docs** — the documentation site
- **handbook** — contributor guides (yalc, bootstrapping, etc.)
- **registry / api / file-server** — backend pieces

## Datasets & benchmarks (large; clone only if you need them)
- `dataset-*`, `autorouting-dataset-01`, `schematic-corpus`, `agent-benchmarking-*`
