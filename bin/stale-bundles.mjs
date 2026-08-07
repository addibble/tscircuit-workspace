#!/usr/bin/env node
//
// stale-bundles.mjs — which inlining consumers are older than what they inline.
//
// tscircuit packages are baked in at BUILD time, so `yalc push`ing a rebuilt
// package into a consumer does NOT update that consumer's bundle: the copy that
// runs is the one that was inlined the last time the consumer itself was built.
// The playground watchers build and push each watched repo individually, which
// is enough for anything that resolves at runtime (the `tsci build` path reads
// core and create-fdm-enclosure straight out of node_modules) and is silently
// not enough for anything that bundles (the browser preview runs core inside
// eval's prebuilt worker, base64-embedded into runframe's standalone).
//
// That gap is a graph traversal, not a fact to remember: the bundling graph
// already says who inlines whom, and every build writes a timestamp. A consumer
// whose own build predates the build of anything it inlines is stale, and what
// it serves is not what the source says.
//
// Kept pure with timestamps injected so the rule is testable as a rule, rather
// than by building a workspace on disk and waiting for tsup.
import { isMain } from "./is-main.mjs"

/**
 * @param inlines   consumer -> repos baked into it (already verified/filtered)
 * @param builtAt   repo -> epoch ms of its last build output, or null if never
 *                  built / has no build artifact
 * @param roots     repos to consider as consumers worth reporting (e.g. the
 *                  ones the playground actually serves). Defaults to every
 *                  consumer in the graph.
 * @param injectedAtServeTime
 *                  consumer -> deps that do NOT require rebuilding it, because
 *                  the serving path splices them in afterwards. runframe ships
 *                  its standalone bundle with a placeholder where the eval
 *                  worker goes, and `dev --local` fills it per serve, so an
 *                  eval change reaches the browser through a 0.1s injection
 *                  rather than through a full runframe rebuild. Nothing
 *                  else in runframe's closure works this way: a 3d-viewer change
 *                  really is compiled into the bundle.
 * @returns [{ repo, staleAgainst: [{ repo, builtAt }], builtAt }]
 *          in dependency order (a stale consumer is listed after the stale
 *          dependency that made it stale, so rebuilding in order fixes it).
 */
export const findStaleBundles = ({
  inlines,
  builtAt,
  roots = null,
  injectedAtServeTime = {},
}) => {
  const isInjected = (consumer, dep) =>
    (injectedAtServeTime[consumer] ?? []).includes(dep)
  // Transitive closure: eval inlines core, core inlines create-fdm-enclosure,
  // so a create-fdm-enclosure build makes eval stale even though the graph has
  // no direct edge between them.
  //
  // A dep spliced in at serve time prunes its whole subtree, not just its own
  // edge: if runframe receives eval by injection, it receives everything eval
  // inlined -- core, props, circuit-json -- by the same route. Pruning only the
  // edge leaves runframe stale against core and rebuilds it anyway, which is
  // the entire cost this exists to avoid.
  const closure = (root, consumer = root, seen = new Set()) => {
    for (const dep of inlines[consumer] ?? []) {
      if (seen.has(dep)) continue
      if (isInjected(root, dep)) continue
      seen.add(dep)
      closure(root, dep, seen)
    }
    return seen
  }

  // Depth in the inlining graph, so consumers are always settled after the
  // things they inline. Cycle-safe: a repo already on the path contributes 0.
  const rank = (repo, seen = new Set()) => {
    if (seen.has(repo)) return 0
    seen.add(repo)
    const deps = inlines[repo] ?? []
    return deps.length === 0
      ? 0
      : 1 + Math.max(0, ...deps.map((d) => rank(d, new Set(seen))))
  }

  const everyConsumer = Object.keys(inlines).sort((a, b) => rank(a) - rank(b))
  const staleness = new Map()

  for (const consumer of everyConsumer) {
    const own = builtAt(consumer)
    const offenders = []

    // (1) Built before something it bakes in: it inlined an older copy.
    for (const dep of closure(consumer)) {
      const depBuilt = builtAt(dep)
      if (depBuilt == null) continue
      if (own == null || depBuilt > own) offenders.push({ repo: dep, builtAt: depBuilt })
    }

    // (2) Bakes in something that is itself stale. Timestamps cannot see this:
    //     runframe rebuilt at 19:49 looks newer than every source, but what it
    //     embedded was an eval worker built at 12:46, so it ships the old code
    //     regardless of its own mtime. Staleness has to propagate through
    //     consumers, not just up from sources.
    for (const dep of inlines[consumer] ?? []) {
      if (isInjected(consumer, dep)) continue
      if (!staleness.has(dep)) continue
      offenders.push({ repo: dep, builtAt: builtAt(dep), inheritedStale: true })
    }

    if (offenders.length > 0) {
      offenders.sort((a, b) => (b.builtAt ?? 0) - (a.builtAt ?? 0))
      staleness.set(consumer, { repo: consumer, builtAt: own, staleAgainst: offenders })
    }
  }

  const wanted = roots ?? everyConsumer
  return everyConsumer
    .filter((repo) => wanted.includes(repo) && staleness.has(repo))
    .map((repo) => staleness.get(repo))
}

/**
 * Deps a consumer receives at serve time rather than at build time.
 *
 * runframe's standalone bundle ships with a placeholder where the eval worker
 * goes; `tsc-dev dev --local` fills it from `eval/dist` on every serve. So an
 * eval change -- and everything eval inlines, which is core, props and
 * circuit-json -- reaches the browser through a 0.1s injection instead of a
 * full runframe rebuild.
 *
 * Measured on this workspace (2026-08-07, after the orchestration fixes and the
 * dev profile): eval builds in 1.4s and runframe in 9.8s, of which 8.4s is one
 * Vite bundle of 3,031 modules. Earlier versions of this comment claimed
 * runframe took ~480s and the chain 496s; both figures came from logs of a
 * build that was spending its time in a pre-build `yalc add` loop, not in a
 * compiler, and both outlived the defect by weeks while being quoted as reasons
 * for design decisions. The carve-out below is right for a STRUCTURAL reason
 * that no timing changes: the standalone ships a placeholder precisely so the
 * worker can be spliced in afterwards, so rebuilding runframe to deliver an
 * eval change is work with no product. `./tsc-dev timings` has the current
 * numbers; do not restate them here.
 */
export const INJECTED_AT_SERVE_TIME = { runframe: ["eval"] }

/** Human-readable one-liner per stale consumer. */
export const describeStale = (stale) =>
  stale.map(({ repo, staleAgainst }) => {
    const [newest] = staleAgainst
    const others =
      staleAgainst.length > 1 ? ` (+${staleAgainst.length - 1} more)` : ""
    const why = newest.inheritedStale
      ? `inlines a stale ${newest.repo}`
      : `is older than ${newest.repo}`
    return `${repo} ${why}${others}`
  })

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2)
  const useInjection = argv.includes("--injected")
  const [root, ...roots] = argv.filter((a) => a !== "--injected")
  const { loadConfig } = await import("./workspace-config.mjs")
  const fs = await import("node:fs")
  const path = await import("node:path")

  const config = loadConfig(root)
  const inlines = config?.bundling?.inlines ?? {}

  // The newest file under dist/ is the build time. Cheap, and it does not
  // assume a particular bundler's output name.
  const builtAt = (repo) => {
    const dist = path.join(root, repo, "dist")
    let newest = null
    const walk = (dir, depth = 0) => {
      if (depth > 2) return
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full, depth + 1)
          continue
        }
        try {
          const { mtimeMs } = fs.statSync(full)
          if (newest == null || mtimeMs > newest) newest = mtimeMs
        } catch {}
      }
    }
    walk(dist)
    return newest
  }

  const stale = findStaleBundles({
    inlines,
    builtAt,
    roots: roots.length > 0 ? roots : null,
    injectedAtServeTime: useInjection ? INJECTED_AT_SERVE_TIME : {},
  })
  for (const line of describeStale(stale)) console.log(line)
  for (const { repo } of stale) console.error(repo)
}
