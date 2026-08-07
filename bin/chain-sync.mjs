#!/usr/bin/env node
//
// chain-sync.mjs — keep the inlining consumers current with what the watchers build.
//
// A watcher owns one repo: it builds it and pushes it. That is everything a
// runtime consumer needs, and nothing a bundling consumer needs. The browser
// preview runs core inside eval's prebuilt worker, base64-embedded into
// runframe's standalone, so until eval and runframe are rebuilt the page keeps
// running the copy inlined at their last build -- silently, with no error and
// no log line, which is how a solver fix took six hours to reach a browser
// while `tsci build` had it immediately.
//
// Whose problem that is matters: no watcher can fix it, because re-inlining is
// a property of the GRAPH, not of the repo that changed. This daemon owns the
// graph edge. It is the automated form of what AGENTS.md used to ask a human to
// remember.
//
//   usage: chain-sync.mjs <workspace-root> <tsc-dev> [--interval ms] [--quiet-for ms]
//                         [--roots eval,runframe]
//
// Rebuilding the chain is the most expensive thing this workspace does, so it
// is deliberately NOT triggered per save: it waits for the watchers to go
// quiet, then catches everything up in one pass. A burst of edits therefore
// costs one chain rebuild, not one per file. (How expensive is a moving target
// and does not belong in a comment: `./tsc-dev timings` reports it. What was
// here before -- "minutes", from a 496s average -- was measured on a build
// spending its time in a yalc loop rather than in a compiler, and stayed here
// long after that was fixed.)
//
// It is also scoped to what the playground actually SERVES. The browser needs
// eval (the worker) and runframe (the bundle embedding it); it does not need
// `cli`, which `tsc-dev dev` runs from source, nor the `tscircuit` umbrella,
// which only matters for a global install. Including those roughly doubled the
// pass, for artifacts nothing in the loop reads.
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { isMain } from "./is-main.mjs"
import { findStaleBundles, describeStale, INJECTED_AT_SERVE_TIME } from "./stale-bundles.mjs"
import { loadConfig } from "./workspace-config.mjs"

const now = () => Date.now()
const log = (msg) =>
  console.log(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`)

/**
 * Newest build artifact under <repo>/dist, or null. Shallow on purpose: deep
 * trees (runframe ships assets) cost more to walk than the answer is worth.
 */
export const distBuiltAt = (root, repo, depth = 2) => {
  let newest = null
  const walk = (dir, level) => {
    if (level > depth) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, level + 1)
        continue
      }
      try {
        const { mtimeMs } = fs.statSync(full)
        if (newest == null || mtimeMs > newest) newest = mtimeMs
      } catch {}
    }
  }
  walk(path.join(root, repo, "dist"), 0)
  return newest
}

/**
 * The decision, isolated from the clock and the filesystem so it can be stated
 * as a rule: rebuild when something is stale AND the watchers have settled.
 * Rebuilding mid-burst would be thrown away by the next save.
 */
export const shouldSync = ({ stale, newestBuildAt, at, quietForMs }) => {
  if (stale.length === 0) return { sync: false, reason: "nothing stale" }
  if (newestBuildAt == null) return { sync: true, reason: "no recent build" }
  const idleMs = at - newestBuildAt
  if (idleMs < quietForMs) {
    return { sync: false, reason: `watchers busy (${Math.round(idleMs / 1000)}s idle)` }
  }
  return { sync: true, reason: `idle ${Math.round(idleMs / 1000)}s` }
}

if (isMain(import.meta.url)) {
  const [root, tscDev, ...rest] = process.argv.slice(2)
  const arg = (flag, fallback) => {
    const i = rest.indexOf(flag)
    return i === -1 ? fallback : Number(rest[i + 1])
  }
  const intervalMs = arg("--interval", 20_000)
  const quietForMs = arg("--quiet-for", 45_000)
  const rootsArg = (() => {
    const i = rest.indexOf("--roots")
    return i === -1 ? null : String(rest[i + 1]).split(",").filter(Boolean)
  })()
  // What the browser preview reads. `cli` is run from source by `tsc-dev dev`,
  // and `tscircuit` is only for a global install, so neither is worth a rebuild
  // on every pass.
  const roots = rootsArg ?? ["eval", "runframe"]

  const inlines = loadConfig(root)?.bundling?.inlines ?? {}
  log(
    `watching the bundling graph for ${roots.join(", ")}, ` +
      `sync after ${quietForMs / 1000}s of quiet`,
  )

  let lastFailureAt = 0
  for (;;) {
    const builtAt = (repo) => distBuiltAt(root, repo)
    const stale = findStaleBundles({
      inlines,
      builtAt,
      roots,
      injectedAtServeTime: INJECTED_AT_SERVE_TIME,
    })
    const everyRepo = new Set(Object.keys(inlines).concat(...Object.values(inlines)))
    const newestBuildAt = [...everyRepo]
      .map(builtAt)
      .filter((t) => t != null)
      .reduce((a, b) => (a == null || b > a ? b : a), null)

    const { sync, reason } = shouldSync({
      stale,
      newestBuildAt,
      at: now(),
      quietForMs,
    })

    // A failing build should not spin: back off for a minute before retrying,
    // so the log stays readable and the machine stays usable.
    if (sync && now() - lastFailureAt > 60_000) {
      for (const line of describeStale(stale)) log(`stale: ${line}`)
      const order = stale.map((s) => s.repo)
      log(`▶ rebuild ${order.join(" ")}  (${reason})`)
      // Recorded so `playground status` can say "rebuilding" instead of
      // reporting the timestamps it happens to see mid-build, which look
      // current the moment the first artifact is written.
      const marker = path.join(root, ".run", "chain.building")
      fs.writeFileSync(
        marker,
        JSON.stringify({ repos: order, startedAt: new Date().toISOString() }),
      )
      const result = spawnSync(tscDev, ["rebuild", ...order], {
        cwd: root,
        stdio: "inherit",
      })
      try {
        fs.unlinkSync(marker)
      } catch {}
      if (result.status === 0) {
        log(`✓ chain current: ${order.join(" ")}`)
      } else {
        lastFailureAt = now()
        log(`✗ rebuild failed (exit ${result.status}) — backing off 60s`)
      }
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
