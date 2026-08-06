#!/usr/bin/env node
//
// find-helpers.mjs — does this helper already exist somewhere in the workspace?
//
//   find-helpers.mjs <root> <query> [--dupes]
//
// Writing a small utility that already exists is the most common avoidable
// defect here: the copy is usually *subtly* wrong (a hand-rolled toMm that
// parseFloat's "1cm" to 1 instead of 10), and it is wrong silently, because the
// happy-path unit is the one the author tested.
//
// This searches EXPORTED symbols across every cloned repo, so the answer to
// "is there already a bounds helper?" is one command rather than five greps.
// --dupes lists names exported by more than one package, which is where the
// existing duplication already lives.
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { isMain } from "./is-main.mjs"

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".yalc", ".worktrees", ".local", ".run", "cosmos-export"])

// Scratch copies of a repo (foo.bak, foo.bak2) are not the project; counting
// them would report every symbol in them as "duplicated".
const isScratchRepo = (name) => /\.(bak|old|orig|copy)\d*$/.test(name)

// `export const foo =`, `export function foo(`, `export type Foo =`, `export class Foo`
const EXPORT_RE =
  /^\s*export\s+(?:declare\s+)?(?:async\s+)?(const|let|var|function|class|type|interface)\s+([A-Za-z_$][\w$]*)/

export const parseExports = (source) => {
  const out = []
  for (const [i, line] of source.split("\n").entries()) {
    const m = line.match(EXPORT_RE)
    if (m) out.push({ kind: m[1], name: m[2], line: i + 1 })
  }
  return out
}

const walk = function* (dir, depth = 0) {
  if (depth > 6) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(full, depth + 1)
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.|\.d\.ts$/.test(e.name)) yield full
  }
}

export const collectExports = (root) => {
  const found = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue
    if (isScratchRepo(entry.name)) continue
    const repo = entry.name
    if (!fs.existsSync(path.join(root, repo, ".git"))) continue
    for (const file of walk(path.join(root, repo))) {
      let source
      try {
        source = fs.readFileSync(file, "utf8")
      } catch {
        continue
      }
      for (const sym of parseExports(source)) {
        found.push({ ...sym, repo, file: path.relative(root, file) })
      }
    }
  }
  return found
}

// Fixture and example files legitimately repeat definitions (a part copied
// into a test), so they are excluded from the duplicate GATE. Duplication in
// library code is the thing worth blocking.
const FIXTURE_PATH = /(^|\/)(tests?|fixtures?|examples?|__fixtures__|__snapshots__|stories)\//

// Exported symbols ADDED by a branch, from its diff against the base. Used to
// answer the only question that matters at review time: does this new helper
// already exist somewhere?
export const addedExports = (repoDir, baseRef) => {
  const diff = execFileSync("git", ["-C", repoDir, "diff", "--unified=0", `${baseRef}...HEAD`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  const out = []
  let file = null
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) file = line.slice(6)
    else if (line.startsWith("+") && !line.startsWith("+++")) {
      const m = line.slice(1).match(EXPORT_RE)
      if (m && file && !/\.test\.|\.d\.ts$/.test(file) && !FIXTURE_PATH.test(file)) out.push({ kind: m[1], name: m[2], file })
    }
  }
  return out
}


if (isMain(import.meta.url)) {
  const [root, query, flag] = process.argv.slice(2)
  if (!root || (!query && flag !== "--dupes")) {
    console.error("usage: find-helpers.mjs <root> <query> [--dupes]")
    process.exit(2)
  }

  const all = collectExports(root)

  // --added <repo-dir> <base-ref>: warn when a branch introduces a helper whose
  // name already exists elsewhere in the workspace.
  if (query === "--added") {
    const [, , repoDir, baseRef] = process.argv.slice(2)
    if (!repoDir || !baseRef) {
      console.error("usage: find-helpers.mjs <root> --added <repo-dir> <base-ref>")
      process.exit(2)
    }
    let added
    try {
      added = addedExports(repoDir, baseRef)
    } catch (e) {
      console.error(`could not diff ${repoDir} against ${baseRef}: ${e.message}`)
      process.exit(0) // advisory only
    }
    const collisions = []
    for (const sym of added) {
      if (sym.kind === "type" || sym.kind === "interface") continue
      const elsewhere = all.filter((s) => s.name === sym.name && !s.file.endsWith(sym.file))
      if (elsewhere.length) collisions.push({ sym, elsewhere })
    }
    if (!collisions.length) {
      console.log(`\u2713 none of the ${added.length} new export(s) shadow an existing helper`)
      process.exit(0)
    }
    console.log(`\u2717 ${collisions.length} new export(s) share a name with something that already exists:\n`)
    for (const { sym, elsewhere } of collisions) {
      console.log(`  ${sym.name}  (new: ${sym.file})`)
      for (const e of elsewhere.slice(0, 4)) console.log(`      also in ${e.repo}: ${e.file}:${e.line}`)
    }
    console.log("\n  Reuse the existing one, or fix it where it lives.")
    console.log("  If this really must differ, say why in a comment and re-run with --allow-dupes.")
    process.exit(1)
  }

  if (query === "--dupes" || flag === "--dupes") {
    const byName = new Map()
    for (const s of all) {
      if (s.kind === "type" || s.kind === "interface") continue
      if (!byName.has(s.name)) byName.set(s.name, [])
      byName.get(s.name).push(s)
    }
    const dupes = [...byName.entries()]
      .map(([name, hits]) => [name, [...new Set(hits.map((h) => h.repo))], hits])
      .filter(([, repos]) => repos.length > 1)
      .sort((a, b) => b[1].length - a[1].length)
    console.log(`${dupes.length} symbol(s) exported by more than one package:\n`)
    for (const [name, repos] of dupes.slice(0, 40)) {
      console.log(`  ${name.padEnd(34)} ${repos.join(", ")}`)
    }
    process.exit(0)
  }

  const needle = query.toLowerCase()
  const hits = all.filter((s) => s.name.toLowerCase().includes(needle))
  if (!hits.length) {
    console.log(`no exported symbol matching '${query}' — check node_modules too before writing one`)
    process.exit(0)
  }
  const byRepo = new Map()
  for (const h of hits) {
    if (!byRepo.has(h.repo)) byRepo.set(h.repo, [])
    byRepo.get(h.repo).push(h)
  }
  console.log(`${hits.length} exported symbol(s) matching '${query}':\n`)
  for (const [repo, syms] of [...byRepo.entries()].sort()) {
    console.log(`  ${repo}`)
    for (const s of syms.slice(0, 12)) {
      console.log(`    ${s.kind.padEnd(9)} ${s.name.padEnd(34)} ${s.file}:${s.line}`)
    }
    if (syms.length > 12) console.log(`    … ${syms.length - 12} more`)
  }

}
