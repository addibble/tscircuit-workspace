# tscircuit repo map

There are ~300 active repos in https://github.com/tscircuit. You almost never
want all of them. This is a curated guide to the ones worth exploring, grouped
by what they do. Clone a whole group with `./tsc-dev clone-group <group>`, or
clone everything a repo depends on with `./tsc-dev clone-deps <repo> -r`.

> Tip: the live internal dependency graph is at https://deps.tscircuit.com
> and a directory of the major packages is the `make-electronics-with-code` repo.

<!-- BEGIN GENERATED: groups (./tsc-dev gen-map) -->

## Runtime / rendering chain  (`clone-group runtime`)
The packages that turn React/TSX into a rendered board — the 'system'. See `bundling` below before rebuilding any of these.
- **core** — the React reconciler + component engine
- **eval** — transpiles + evaluates TSX to Circuit JSON (in a web worker)
- **runframe** — React preview UI (PCB/schematic/3D), runs eval in a worker
- **cli** — `tsci dev` local server, push/export/build commands
- **tscircuit** — umbrella package + the `tsci` CLI binary
- **props** — zod prop schemas for every component
- **circuit-json** — the low-level data format everything speaks

## Viewers  (`clone-group viewers`)
React components / libs that render Circuit JSON.
- **pcb-viewer** — interactive PCB canvas
- **schematic-viewer** — interactive schematic canvas
- **3d-viewer** — three.js board + component preview
- **assembly-viewer** — assembly-drawing view
- **runframe** — React preview UI (PCB/schematic/3D), runs eval in a worker
- **circuit-to-svg** — Circuit JSON to schematic/PCB/assembly SVG (used everywhere, incl. snapshot tests)
- **circuit-to-canvas** — Circuit JSON to a canvas renderer

## Exporters  (`clone-group exporters`)
Circuit JSON to manufacturing / interchange formats.
- **circuit-json-to-gerber** — Gerber + drill files for fabrication
- **circuit-json-to-kicad** — KiCad project/board output
- **circuit-json-to-step** — STEP solid model output
- **circuit-json-to-spice** — SPICE netlist for simulation
- **circuit-json-to-gltf** — glTF scene for 3D preview and export
- **circuit-json-to-bom-csv** — bill of materials CSV
- **circuit-json-to-pnp-csv** — pick-and-place CSV

## Autorouting  (`clone-group autorouting`)
Trace routing: the main MIT autorouter plus the solvers it is built from.
- **tscircuit-autorouter** — the main MIT autorouter
- **capacity-autorouter** — capacity-based routing strategy used by it
- **infgrid-ijump-astar** — infinite-grid jump-point A* router
- **bus-router** — bus/parallel-trace routing
- **high-density-a01** — high-density interconnect routing experiment
- **schematic-trace-solver** — schematic trace + net-label placement
- **freerouting-cli** — wrapper around the Freerouting engine
- **dsn-converter** — Specctra DSN in/out for external routers

## Layout solvers  (`clone-group solvers`)
Standalone 2D algorithms, each with its own Cosmos debugger (`bun run start`).
- **matchpack** — component placement by matching + packing
- **calculate-packing** — 2D packing (`pack`)
- **copper-pour-solver** — copper pour / ground plane generation
- **breakout-point-solver** — escape routing from dense footprints
- **schematic-match-adapt** — fit a schematic to a known template
- **solver-utils** — the `BaseSolver` framework + `GenericSolverDebugger`
- **miniflex** — flexbox layout
- **minicssgrid** — CSS grid layout
- **bpc-graph** — box-pin-color graph

## Formats / parsers  (`clone-group formats`)
The data format and the parsers/DSLs around it.
- **circuit-json** — the low-level data format everything speaks
- **props** — zod prop schemas for every component
- **footprinter** — footprint DSL (`0402`, `soic8`, ...)
- **schematic-symbols** — schematic symbol SVG library
- **kicadts** — typed KiCad file bindings
- **dsnts** — typed Specctra DSN bindings
- **gerberts** — typed Gerber bindings
- **stepts** — typed STEP bindings
- **circuit-json-util** — helpers for querying/transforming Circuit JSON

## Importers / converters  (`clone-group importers`)
Foreign formats into Circuit JSON / tscircuit source.
- **easyeda-converter** — EasyEDA / LCSC parts into tscircuit
- **kicad-to-circuit-json** — KiCad boards into Circuit JSON
- **kicad-converter** — KiCad format conversions both ways
- **svg-to-tscircuit** — SVG artwork into tscircuit source
- **circuit-json-to-tscircuit** — Circuit JSON back into TSX source

<!-- END GENERATED -->

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
