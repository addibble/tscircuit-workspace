import { expect, test } from "bun:test"
import { describeStale, findStaleBundles } from "../bin/stale-bundles.mjs"

// The failure this guards against costs hours, not minutes: a watcher rebuilds
// and pushes a package, every runtime consumer picks it up, and the browser
// keeps running the copy that was inlined into eval's worker hours earlier.
// Nothing errors. You debug code that is not running.

const graph = {
  core: ["create-fdm-enclosure", "circuit-json"],
  eval: ["core", "props"],
  runframe: ["eval", "3d-viewer"],
  "3d-viewer": ["circuit-json"],
}

const at = (times: Record<string, number | null>) => (repo: string) =>
  repo in times ? times[repo]! : null

test("a consumer built after everything it inlines is not stale", () => {
  const stale = findStaleBundles({
    inlines: graph,
    builtAt: at({ "create-fdm-enclosure": 10, core: 20, eval: 30, runframe: 40 }),
  })

  expect(stale).toEqual([])
})

/**
 * The exact timeline that burned us, in minutes-past-midnight:
 *
 *   12:46  eval built (its worker inlines core, which inlines the solver)
 *   17:47  core built
 *   19:00  create-fdm-enclosure rebuilt by its watcher, and pushed everywhere
 *   19:49  runframe rebuilt -- AFTER the fix, yet embedding the 12:46 eval
 *
 * `tsci build` read the fix straight out of node_modules and looked correct.
 * The browser ran the 12:46 copy. Note runframe: its own mtime is newer than
 * every source, so nothing a timestamp comparison alone can see is wrong with
 * it -- what it baked in was stale, which is why staleness has to propagate
 * through consumers as well as up from sources.
 */
test("staleness travels transitively, and through a consumer that was itself rebuilt", () => {
  const stale = findStaleBundles({
    inlines: graph,
    builtAt: at({
      "create-fdm-enclosure": 1900,
      "circuit-json": 1200,
      props: 1200,
      "3d-viewer": 1200,
      core: 1747,
      eval: 1246,
      runframe: 1949,
    }),
  })

  expect(stale.map((s) => s.repo)).toEqual(["core", "eval", "runframe"])
  // core and eval predate the solver rebuild ...
  expect(stale[0]!.staleAgainst[0]!.repo).toBe("create-fdm-enclosure")
  expect(stale[1]!.staleAgainst[0]!.repo).toBe("create-fdm-enclosure")
  // ... and runframe is stale despite being the newest build of the lot,
  // because what it embedded was not.
  expect(stale[2]!.staleAgainst.some((s: any) => s.repo === "eval")).toBe(true)
})

test("a stale consumer is reported after the stale consumer it inlines", () => {
  const stale = findStaleBundles({
    inlines: graph,
    builtAt: at({ "circuit-json": 100, core: 10, eval: 20, runframe: 30, "3d-viewer": 5 }),
  })
  const order = stale.map((s) => s.repo)

  // Rebuilding in the reported order has to fix it in one pass: runframe last,
  // or it re-inlines a stale eval.
  expect(order.indexOf("core")).toBeLessThan(order.indexOf("eval"))
  expect(order.indexOf("eval")).toBeLessThan(order.indexOf("runframe"))
  expect(order.indexOf("3d-viewer")).toBeLessThan(order.indexOf("runframe"))
})

/**
 * A repo with no build output at all cannot be serving anything current, but
 * only counts as stale if something it inlines has in fact been built --
 * otherwise a source-only repo would be permanently "stale".
 */
test("a never-built consumer is stale, a never-built dependency is not a trigger", () => {
  expect(
    findStaleBundles({
      inlines: { eval: ["core"] },
      builtAt: at({ core: 100, eval: null }),
    }).map((s) => s.repo),
  ).toEqual(["eval"])

  expect(
    findStaleBundles({
      inlines: { eval: ["core"] },
      builtAt: at({ core: null, eval: 100 }),
    }),
  ).toEqual([])
})

test("roots narrow the report to the consumers a caller cares about", () => {
  const stale = findStaleBundles({
    inlines: graph,
    builtAt: at({ "create-fdm-enclosure": 1900, core: 1246, eval: 1246, runframe: 1246 }),
    roots: ["runframe"],
  })

  expect(stale.map((s) => s.repo)).toEqual(["runframe"])
})

/**
 * The real graph is a DAG, but a manifest edit could make it cyclic, and a
 * hang in a status command is a worse failure than an imprecise answer. In a
 * cycle nothing can be shown fresh -- each side inlines the other -- so both
 * being reported is the honest result; what matters is that it terminates.
 */
test("a cycle in the graph does not hang the walk", () => {
  const stale = findStaleBundles({
    inlines: { a: ["b"], b: ["a"] },
    builtAt: at({ a: 10, b: 20 }),
  })

  expect(stale.map((s) => s.repo).sort()).toEqual(["a", "b"])
})

test("the description names the newest offender", () => {
  const stale = findStaleBundles({
    inlines: graph,
    builtAt: at({ "create-fdm-enclosure": 1900, "circuit-json": 1800, core: 1000, eval: 1000 }),
  })

  expect(describeStale(stale)[0]).toContain("is older than")
})
