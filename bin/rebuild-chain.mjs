#!/usr/bin/env node
//
// rebuild-chain.mjs — resolve the bottom-up rebuild order for a change.
//
// tscircuit packages are inlined at BUILD time (core/props/circuit-json into
// eval's webworker, that worker base64-embedded into runframe's standalone
// bundle, which the cli serves), so a change is invisible downstream until each
// level below it is rebuilt in order. This computes that order from the
// `bundling.inlines` graph in workspace.json:
//
//   usage: rebuild-chain.mjs <manifest> <workspace-root> <from> [to]
//   prints one repo per line, dependencies first, including <from> itself.
//
// Manifest edges are advisory and deliberately a superset of literal inlining;
// each is verified here against the consumer's actual package.json, so an edge
// that a given branch does not really have is dropped instead of causing a
// pointless rebuild. Repos that are not cloned are skipped entirely.
import fs from "node:fs"
import path from "node:path"

const [manifestPath, root, from, to] = process.argv.slice(2)
if (!manifestPath || !root || !from) {
  console.error("usage: rebuild-chain.mjs <manifest> <workspace-root> <from> [to]")
  process.exit(2)
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
const inlines = manifest.bundling?.inlines ?? {}

const pkg = (repo) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, repo, "package.json"), "utf8"))
  } catch {
    return null
  }
}
const isCloned = (repo) => fs.existsSync(path.join(root, repo, ".git"))
const depNames = (repo) => {
  const p = pkg(repo)
  if (!p) return null
  return new Set(Object.keys({ ...p.dependencies, ...p.devDependencies, ...p.peerDependencies }))
}

// consumer -> packages it actually bakes in
const inlined = {}
for (const [consumer, deps] of Object.entries(inlines)) {
  if (!isCloned(consumer)) continue
  const declared = depNames(consumer)
  inlined[consumer] = deps.filter((dep) => {
    if (!isCloned(dep)) return false
    const name = pkg(dep)?.name
    // Unverifiable (no package.json on either side) => trust the manifest.
    if (!name || !declared) return true
    return declared.has(name)
  })
}

// reverse edges: package -> the packages that bake it in
const consumersOf = {}
for (const [consumer, deps] of Object.entries(inlined)) {
  for (const dep of deps) (consumersOf[dep] ??= []).push(consumer)
}

// everything downstream of `from`, inclusive
const affected = new Set()
const stack = [from]
while (stack.length) {
  const node = stack.pop()
  if (affected.has(node)) continue
  affected.add(node)
  for (const consumer of consumersOf[node] ?? []) stack.push(consumer)
}

// `to` truncates the chain to packages that can still reach `to`
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
  if (!affected.has(to)) {
    console.error(`error: '${to}' is not downstream of '${from}' in the bundling graph`)
    process.exit(1)
  }
}

// topological sort: a package is built after everything it inlines
const order = []
const visiting = new Set()
const done = new Set()
const visit = (node) => {
  if (done.has(node)) return
  if (visiting.has(node)) {
    console.error(`error: cycle in bundling.inlines at '${node}'`)
    process.exit(1)
  }
  visiting.add(node)
  for (const dep of inlined[node] ?? []) if (affected.has(dep)) visit(dep)
  visiting.delete(node)
  done.add(node)
  order.push(node)
}
for (const node of affected) visit(node)

if (order.length) console.log(order.join("\n"))
