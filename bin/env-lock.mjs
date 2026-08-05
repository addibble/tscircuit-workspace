#!/usr/bin/env node
//
// env-lock.mjs — capture and compare a whole build environment.
//
// The workspace is a set of independent checkouts, so "my build environment" is
// not one commit: it is which repos are cloned, which remote and branch each one
// is on (frequently a fork, for patch sets that are not upstream yet), the exact
// SHA, and which yalc links are wired between them. That tuple is what makes two
// developers' `bun test` results comparable.
//
// The lock lives in the USER layer (.local/workspace.lock.json), versioned on an
// orphan branch pushed to your fork — so pointing at a colleague's workspace fork
// and reading their lock is enough to reproduce their environment exactly.
//
// Usage:
//   env-lock.mjs capture <root>                    write the lock JSON to stdout
//   env-lock.mjs diff <root> <lockfile> [--quiet]  compare a lock against this checkout
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const git = (dir, ...args) => {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return ""
  }
}

const SKIP = new Set([".local", ".worktrees", "node_modules"])

const clonedRepos = (root) =>
  fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !SKIP.has(e.name) && fs.existsSync(path.join(root, e.name, ".git")))
    .map((e) => e.name)
    .sort()

// Which remote does the checked-out branch actually come from? For patch-set
// work this is usually a fork, and the adopting developer needs its URL, not
// just the branch name, or they will silently reproduce upstream instead.
const branchRemote = (dir, branch) => {
  if (!branch || branch === "HEAD") return ""
  const remote = git(dir, "config", "--get", `branch.${branch}.remote`)
  return remote || ""
}

const captureRepo = (root, name) => {
  const dir = path.join(root, name)
  const branch = git(dir, "rev-parse", "--abbrev-ref", "HEAD")
  const remote = branchRemote(dir, branch)
  const remotes = {}
  for (const r of git(dir, "remote").split("\n").filter(Boolean)) {
    remotes[r] = git(dir, "remote", "get-url", r)
  }
  return {
    branch: branch === "HEAD" ? "(detached)" : branch,
    sha: git(dir, "rev-parse", "HEAD"),
    // the remote the branch tracks, plus its URL, so a peer can add it verbatim
    remote: remote || "origin",
    remoteUrl: remotes[remote || "origin"] ?? "",
    remotes,
    dirty: git(dir, "status", "--porcelain") !== "",
  }
}

// yalc links, i.e. which local build each consumer is actually running against.
const captureLinks = (root, repos) => {
  const links = {}
  for (const name of repos) {
    const lock = path.join(root, name, "yalc.lock")
    if (!fs.existsSync(lock)) continue
    try {
      const parsed = JSON.parse(fs.readFileSync(lock, "utf8"))
      const pkgs = Object.keys(parsed.packages ?? {}).sort()
      if (pkgs.length) links[name] = pkgs
    } catch {
      /* unreadable lock — not worth failing the capture over */
    }
  }
  return links
}

const capture = (root) => {
  const repos = clonedRepos(root)
  const out = {
    $comment:
      "Snapshot of a build environment: every cloned repo's remote/branch/SHA plus the yalc links between them. " +
      "Reproduce with `./tsc-dev env adopt <owner>`. Regenerate with `./tsc-dev freeze`.",
    generatedAt: new Date().toISOString(),
    tool: {
      workspaceCommit: git(root, "rev-parse", "HEAD"),
      bun: run("bun", ["--version"]),
      node: process.version,
    },
    repos: Object.fromEntries(repos.map((r) => [r, captureRepo(root, r)])),
    links: captureLinks(root, repos),
  }
  return out
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return ""
  }
}

// Compare two captures. The distinction matters: a *difference* means the
// environments genuinely disagree (wrong commit, missing repo, missing link) and
// should fail; a *warning* is something that cannot be reproduced but is normal
// here (a yalc link rewrites package.json, so a dirty tree is the usual working
// state — treating it as a difference would make every diff red and ignored).
export const compareEnvironments = (lock, here) => {
  const problems = []
  const warnings = []
  const matched = []

  for (const [name, want] of Object.entries(lock.repos ?? {})) {
    const got = here.repos?.[name]
    if (!got) {
      problems.push(`${name}: not cloned (want ${want.branch} @ ${want.sha.slice(0, 8)} from ${want.remoteUrl})`)
      continue
    }
    if (got.sha !== want.sha) {
      problems.push(
        `${name}: at ${got.branch} ${got.sha.slice(0, 8)}, lock wants ${want.branch} ${want.sha.slice(0, 8)}` +
          (want.remote !== "origin" ? ` (from ${want.remoteUrl})` : ""),
      )
      continue
    }
    if (got.dirty) warnings.push(`${name}: at the locked commit, but with uncommitted changes`)
    else matched.push({ name, branch: want.branch, sha: want.sha })
  }

  for (const name of Object.keys(here.repos ?? {})) {
    if (!(name in (lock.repos ?? {}))) warnings.push(`${name}: cloned here, absent from the lock`)
  }

  for (const [consumer, want] of Object.entries(lock.links ?? {})) {
    const got = here.links?.[consumer] ?? []
    const missing = want.filter((p) => !got.includes(p))
    const extra = got.filter((p) => !want.includes(p))
    if (missing.length) problems.push(`${consumer}: missing yalc link(s) ${missing.join(", ")}`)
    if (extra.length) warnings.push(`${consumer}: extra yalc link(s) ${extra.join(", ")}`)
  }

  return { problems, warnings, matched }
}

const diff = (root, lockFile, quiet) => {
  const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"))
  const { problems, warnings, matched } = compareEnvironments(lock, capture(root))

  if (!quiet) {
    for (const m of matched) console.log(`  \u2713 ${m.name.padEnd(30)} ${m.branch} @ ${m.sha.slice(0, 8)}`)
  }
  if (warnings.length) {
    console.log("")
    for (const w of warnings) console.log(`  \u26a0 ${w}`)
  }
  if (problems.length) {
    console.log("")
    for (const p of problems) console.log(`  \u2717 ${p}`)
    console.log(
      `\n\u2717 ${problems.length} difference(s) from ${path.basename(lockFile)}` +
        (warnings.length ? `, ${warnings.length} warning(s)` : ""),
    )
    process.exit(1)
  }
  console.log(
    `\n\u2713 this checkout matches ${path.basename(lockFile)}` +
      (warnings.length ? ` (${warnings.length} warning(s))` : ""),
  )
}

// Importing this module must have no side effects: the CLI body only runs when
// the file is executed directly. Compare REAL paths, since node resolves
// symlinks when loading a module (/tmp -> /private/tmp on macOS).
const realpath = (p) => {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}
const isMain = process.argv[1] && realpath(process.argv[1]) === realpath(fileURLToPath(import.meta.url))

if (isMain) {
  const [mode, root, arg] = process.argv.slice(2)
  if (mode === "capture" && root) {
    process.stdout.write(JSON.stringify(capture(root), null, 2) + "\n")
  } else if (mode === "diff" && root && arg) {
    diff(root, arg, process.argv.includes("--quiet"))
  } else if (mode === "summarize") {
    // read a lock on stdin (used to inspect a peer's without checking it out)
    let s = ""
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const l = JSON.parse(s)
      console.log(
        `captured ${l.generatedAt}  (bun ${l.tool?.bun || "?"}, workspace ${(l.tool?.workspaceCommit || "").slice(0, 8)})`,
      )
      for (const [n, r] of Object.entries(l.repos ?? {})) {
        console.log(
          `  ${n.padEnd(30)} ${String(r.branch).padEnd(34)} ${r.sha.slice(0, 8)}` +
            (r.remote !== "origin" ? `  ${r.remoteUrl}` : ""),
        )
      }
      const links = Object.entries(l.links ?? {})
      if (links.length) {
        console.log("\n  yalc links:")
        for (const [consumer, pkgs] of links) console.log(`    ${consumer.padEnd(28)} ${pkgs.join(", ")}`)
      }
    })
  } else {
    console.error("usage: env-lock.mjs capture <root> | diff <root> <lockfile> [--quiet] | summarize -")
    process.exit(2)
  }
}
