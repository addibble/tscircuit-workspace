#!/usr/bin/env node
//
// build-inputs.mjs — which files in a repo are inputs to its BUILD.
//
// One declaration, two consumers, and that is the whole point:
//
//   * the watchers, which must not rebuild on a file the build never reads
//     (core rebuilt repeatedly from `tests/**` edits alone, ~13s each, producing
//     byte-identical dist);
//   * the action key (bin/action-key.mjs), which must hash exactly the set of
//     files a rebuild would depend on.
//
// If those two lists were maintained separately they would drift, and the drift
// is invisible in both directions: a watched non-input burns CPU, an unwatched
// input silently ships a stale bundle. So they come from here.
//
// The rule is EXCLUSION, not inclusion. An over-narrow include list fails
// silently (a real source file stops invalidating the build); an over-broad
// input set only costs a rebuild that was not needed. When in doubt a file IS
// an input.
import path from "node:path"
import fs from "node:fs"
import { isMain } from "./is-main.mjs"

// Never inputs, in any repo. Build output, dependencies, tests, docs and the
// files the build itself writes back into the source tree.
export const DEFAULT_EXCLUDE = [
  // build output / vendored / tooling state
  "node_modules/**",
  "dist/**",
  ".git/**",
  ".yalc/**",
  "cosmos-export/**",
  "benchmarking-dist/**",
  "coverage/**",
  ".next/**",
  "build/**",
  ".run/**",
  ".worktrees/**",
  // tests and their fixtures: 2,185 tracked test files in core alone, and a
  // snapshot update must not invalidate the library build
  "tests/**",
  "test/**",
  "__tests__/**",
  "**/__snapshots__/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/*.snap",
  "browser-tests/**",
  "playwright.config.*",
  // documentation, examples, debug dumps, CI config
  "docs/**",
  "examples/**",
  "benchmarking/**",
  "debug-graphics/**",
  ".github/**",
  ".vscode/**",
  "**/*.md",
  // build OUTPUT that lands in the source tree: runframe's build:css writes
  // lib/hooks/styles.generated.ts back into lib/, so hashing it would make
  // every build change its own inputs and trigger one more rebuild. It is
  // derived from files that ARE inputs (the tailwind config and the components
  // it scans), so nothing is lost by ignoring the derived copy.
  "**/*.generated.*",
  // files tsc-dev / the build / yalc write into the tree
  "yalc.lock",
  "bun.lock",
  "bun.lockb",
  "**/tsup.config.bundled_*",
  "**/tsup.tsc-dev-*.config.*",
  "**/*.tsbuildinfo",
  "**/.DS_Store",
]

// Always inputs, even if an exclusion above would have caught them.
export const DEFAULT_INCLUDE = ["package.json"]

const globToRegExp = (glob) => {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` spans any number of directories (including none); a bare `**`
        // spans anything at all.
        if (glob[i + 2] === "/") {
          re += "(?:[^/]+/)*"
          i += 2
        } else {
          re += ".*"
          i += 1
        }
      } else {
        re += "[^/]*"
      }
    } else if (c === "?") {
      re += "[^/]"
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    }
  }
  return new RegExp(`^${re}$`)
}

const cache = new Map()
const matcher = (glob) => {
  let m = cache.get(glob)
  if (!m) cache.set(glob, (m = globToRegExp(glob)))
  return m
}

export const matchesAny = (relPath, patterns) => {
  const rel = relPath.split(path.sep).join("/")
  return patterns.some((p) => {
    if (matcher(p).test(rel)) return true
    // A directory pattern (`tests/**`) also matches the directory itself, so a
    // walker can prune before descending.
    if (p.endsWith("/**") && matcher(p.slice(0, -3)).test(rel)) return true
    return false
  })
}

/**
 * Is this repo-relative path an input to the repo's build?
 *
 * Dotfiles and editor scratch files are never inputs; everything else is unless
 * it is excluded, and `include` wins over `exclude` (that is how package.json —
 * which tsc-dev itself rewrites during stamping — stays an input to the key
 * while remaining ignorable by the watcher).
 */
export const isBuildInput = (relPath, opts = {}) => {
  if (!relPath) return false
  const rel = relPath.split(path.sep).join("/")
  const include = opts.include ?? DEFAULT_INCLUDE
  const exclude = opts.exclude ?? DEFAULT_EXCLUDE
  if (matchesAny(rel, include)) return true
  const base = rel.split("/").pop()
  if (rel.split("/").some((seg) => seg.startsWith(".") && seg !== ".")) return false
  if (base.endsWith("~") || base.endsWith(".log") || base.endsWith(".tmp")) return false
  return !matchesAny(rel, exclude)
}

/** The per-repo input rules from workspace.json's `build.inputs`. */
export const inputRulesFor = (config, repo) => {
  const inputs = config?.build?.inputs ?? {}
  const extraExclude = inputs.exclude ?? []
  const perRepo = inputs.repos?.[repo] ?? {}
  return {
    exclude: [...DEFAULT_EXCLUDE, ...extraExclude, ...(perRepo.exclude ?? [])],
    include: [...DEFAULT_INCLUDE, ...(inputs.include ?? []), ...(perRepo.include ?? [])],
  }
}

/**
 * Every build input under `dir`, repo-relative and sorted. Directories that can
 * only contain non-inputs are pruned rather than walked — core's `tests/` alone
 * is 87MB.
 */
export const listBuildInputs = (dir, opts = {}) => {
  const out = []
  const walk = (abs, rel) => {
    let entries
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (isBuildInput(childRel, opts)) walk(path.join(abs, entry.name), childRel)
        continue
      }
      if (isBuildInput(childRel, opts)) out.push(childRel)
    }
  }
  walk(dir, "")
  return out.sort()
}

if (isMain(import.meta.url)) {
  const [dir] = process.argv.slice(2)
  if (!dir) {
    console.error("usage: build-inputs.mjs <repo-dir>")
    process.exit(2)
  }
  for (const f of listBuildInputs(dir)) console.log(f)
}
