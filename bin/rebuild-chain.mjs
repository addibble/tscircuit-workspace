#!/usr/bin/env node
//
// rebuild-chain.mjs — resolve the bottom-up rebuild order for a change.
//
// tscircuit packages are inlined at BUILD time (core/props/circuit-json into
// eval's webworker, that worker base64-embedded into runframe's standalone
// bundle, which the cli serves), so a change is invisible downstream until each
// level below it is rebuilt in order. This computes that order from the
// `bundling.inlines` graph in the layered workspace config:
//
//   usage: rebuild-chain.mjs <workspace-root> <from> [to]
//   prints one repo per line, dependencies first, including <from> itself.
//
// Manifest edges are advisory and deliberately a superset of literal inlining;
// each is verified against the consumer's actual package.json, so an edge that a
// given branch does not really have is dropped instead of causing a pointless
// rebuild. Repos that are not cloned are skipped entirely.
import fs from "node:fs"
import path from "node:path"
import { loadConfig } from "./workspace-config.mjs"
import { isMain } from "./is-main.mjs"

/**
 * Pure graph resolution, with the filesystem injected so it can be tested
 * without building a workspace on disk.
 *
 * @param inlines  consumer -> packages baked into it (repo names)
 * @param isCloned repo -> boolean
 * @param declares consumer, depPackageName -> boolean ("does its package.json list it?")
 * @param pkgName  repo -> published package name, or null if unknown
 */
export const resolveChain = ({ inlines, isCloned, declares, pkgName, from, to }) => {
  const inlined = {}
  for (const [consumer, deps] of Object.entries(inlines)) {
    if (!isCloned(consumer)) continue
    inlined[consumer] = deps.filter((dep) => {
      if (!isCloned(dep)) return false
      const name = pkgName(dep)
      // Unverifiable (package name unknown) => trust the manifest.
      if (!name) return true
      return declares(consumer, name)
    })
  }

  const consumersOf = {}
  for (const [consumer, deps] of Object.entries(inlined)) {
    for (const dep of deps) (consumersOf[dep] ??= []).push(consumer)
  }

  const affected = new Set()
  const stack = [from]
  while (stack.length) {
    const node = stack.pop()
    if (affected.has(node)) continue
    affected.add(node)
    for (const consumer of consumersOf[node] ?? []) stack.push(consumer)
  }

  if (to) {
    const canReachTo = new Set()
    const st = [to]
    while (st.length) {
      const node = st.pop()
      if (canReachTo.has(node)) continue
      canReachTo.add(node)
      for (const dep of inlined[node] ?? []) st.push(dep)
    }
    for (const node of [...affected]) if (!canReachTo.has(node)) affected.delete(node)
    if (!affected.has(to)) throw new Error(`'${to}' is not downstream of '${from}' in the bundling graph`)
  }

  const order = []
  const visiting = new Set()
  const done = new Set()
  const visit = (node) => {
    if (done.has(node)) return
    if (visiting.has(node)) throw new Error(`cycle in bundling.inlines at '${node}'`)
    visiting.add(node)
    for (const dep of inlined[node] ?? []) if (affected.has(dep)) visit(dep)
    visiting.delete(node)
    done.add(node)
    order.push(node)
  }
  for (const node of affected) visit(node)
  return order
}

export const chainForWorkspace = (root, from, to) => {
  const config = loadConfig(root)
  const pkg = (repo) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, repo, "package.json"), "utf8"))
    } catch {
      return null
    }
  }
  const depCache = new Map()
  const deps = (repo) => {
    if (!depCache.has(repo)) {
      const p = pkg(repo)
      depCache.set(
        repo,
        p ? new Set(Object.keys({ ...p.dependencies, ...p.devDependencies, ...p.peerDependencies })) : null,
      )
    }
    return depCache.get(repo)
  }
  return resolveChain({
    inlines: config.bundling?.inlines ?? {},
    isCloned: (repo) => fs.existsSync(path.join(root, repo, ".git")),
    declares: (consumer, name) => {
      const declared = deps(consumer)
      return declared ? declared.has(name) : true
    },
    pkgName: (repo) => pkg(repo)?.name ?? null,
    from,
    to,
  })
}

if (isMain(import.meta.url)) {
  const [root, from, to] = process.argv.slice(2)
  if (!root || !from) {
    console.error("usage: rebuild-chain.mjs <workspace-root> <from> [to]")
    process.exit(2)
  }
  try {
    const order = chainForWorkspace(root, from, to)
    if (order.length) console.log(order.join("\n"))
  } catch (e) {
    console.error(`error: ${e.message}`)
    process.exit(1)
  }
}
