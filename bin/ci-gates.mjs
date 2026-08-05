#!/usr/bin/env node
//
// ci-gates.mjs — the commands CI actually runs on a pull request.
//
// Read from each repo's own workflows rather than a hand-maintained table: the
// gate set varies per repo (circuit-json's lint:zod, core's smoke-test:dist,
// dependency-check) and a copied list is exactly what goes stale.
//
//   ci-gates.mjs <repo-dir>     one command per line, in the order to run them
//
// This was a grep/sed pipeline in tsc-dev and grew two bugs that only showed up
// when run against real repos, both pinned by tests now:
//   * a workflow file with no trailing newline fused its last command onto the
//     first command of the next file ("bun run format:checkbun i");
//   * `sort -u` alphabetised the gates, which happened to keep `bun run build`
//     before `bun run smoke-test:dist` and would silently stop doing so.
import fs from "node:fs"
import path from "node:path"

// Steps that are not gates: installs, release/bot machinery, anything that
// rewrites files, and CI-sharding helpers.
const EXCLUDE = [
  /\$\{\{/, // parameterised by a workflow expression — not runnable as-is
  /--write/, // formatters in fix mode mutate the tree
  /^bun\s+(install|i|add|update)\b/,
  /^npm\s+(install|ci|publish)\b/,
  /^npx?\s+.*publish/,
  /pver/,
  /bunaider/,
  /generate-test-plan/, // exists only to shard CI across matrix nodes
  /^echo\b/,
  /^exit\b/,
  /^git\s/,
]

export const parseWorkflow = (yaml) => {
  // Only single-line `run:` steps. Multi-line `run: |` blocks are shell
  // programs (retry loops, matrix shards); they are handled by the caller's
  // fallbacks rather than pretended to be parsed.
  const out = []
  for (const line of yaml.split("\n")) {
    const m = line.match(/^\s*(?:-\s*)?run:\s*(.+?)\s*$/)
    if (m && m[1] !== "|" && m[1] !== ">") out.push(m[1])
  }
  return out
}

export const isPullRequestTriggered = (yaml) => /^\s*pull_request\b/m.test(yaml)

export const isGate = (command) => command !== "" && !EXCLUDE.some((re) => re.test(command))

export const hasTests = (repoDir) => {
  const walk = (dir, depth) => {
    if (depth > 3) return false
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return false
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue
      if (e.isFile() && /\.test\.[cm]?[jt]sx?$/.test(e.name)) return true
      if (e.isDirectory() && walk(path.join(dir, e.name), depth + 1)) return true
    }
    return false
  }
  return walk(repoDir, 0)
}

export const ciGates = (repoDir) => {
  const workflowDir = path.join(repoDir, ".github", "workflows")
  let files = []
  try {
    files = fs
      .readdirSync(workflowDir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .sort()
  } catch {
    files = []
  }

  const gates = []
  for (const file of files) {
    const yaml = fs.readFileSync(path.join(workflowDir, file), "utf8")
    if (!isPullRequestTriggered(yaml)) continue
    for (const command of parseWorkflow(yaml)) if (isGate(command)) gates.push(command)
  }

  // `bun test` is frequently invoked from a matrix-sharded multi-line step that
  // no line-level parse can reconstruct, and the right local equivalent is the
  // whole suite. Appended last because it is also the slowest gate.
  if (hasTests(repoDir)) gates.push("bun test")

  // Dedup while preserving workflow order: `bun run build` must keep coming
  // before `bun run smoke-test:dist`.
  return [...new Set(gates)]
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  const repoDir = process.argv[2]
  if (!repoDir) {
    console.error("usage: ci-gates.mjs <repo-dir>")
    process.exit(2)
  }
  const gates = ciGates(repoDir)
  if (gates.length) console.log(gates.join("\n"))
}
