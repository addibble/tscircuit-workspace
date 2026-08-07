#!/usr/bin/env node
//
// build-cache.mjs — a local content-addressed store for build artifacts.
//
// The workspace had no cache at all, and the clock-based version stamp
// guaranteed it never could: two builds of identical source produced different
// bytes. With identity fixed (bin/action-key.mjs) the cache is small:
//
//   dist/ for a given action key is put in a tarball under
//   $XDG_CACHE_HOME/tsc-dev/v<schema>/<package>/<profile>/<key>.tar, beside a
//   manifest recording what it was built from and what its bytes digest to.
//
// What it buys is precisely what the measurements said was left: switching
// branches back, restarting a watcher, retrying after a downstream failure —
// cases where the work has already been done. It does NOT make a first build
// faster; that is what the dev profile is for.
//
// Three rules, each from a real hazard:
//
//   * NEVER admit a failed or interrupted build. Entries are written to a temp
//     path and renamed into place, so a killed build leaves no entry rather
//     than a truncated one.
//   * One writer per key. Two watchers can race on the same repo (a chain sync
//     and a save landing together); a lock directory serializes them.
//   * A restore must be verifiable. The manifest carries the artifact digest,
//     and `cache verify` rebuilds and compares — because a wrong cache hit is
//     indistinguishable from a right one at the point of use.
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { isMain } from "./is-main.mjs"
import { SCHEMA } from "./action-key.mjs"
import { SIDECAR } from "./provenance.mjs"

export const cacheRoot = () =>
  process.env.TSC_DEV_CACHE_DIR ??
  path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "tsc-dev", `v${SCHEMA}`)

const safe = (name) => name.replace(/[^\w.-]+/g, "_")

export const entryPaths = (root, pkg, profile, key) => {
  const dir = path.join(root, safe(pkg), profile)
  return { dir, tar: path.join(dir, `${key}.tar`), manifest: path.join(dir, `${key}.json`) }
}

/**
 * The decision, kept free of the filesystem so it can be stated as a rule.
 *
 * "no-op" is the common case in a watcher loop and the reason the sidecar is
 * rewritten even then: `stale-bundles` reads dist mtimes, so a build that
 * changed nothing must still say "checked just now", or a chain sync would see
 * an unchanged consumer as permanently behind and rebuild it every pass.
 */
export const decideBuild = ({ sidecar, key, profile, distExists, hasCacheEntry, force = false }) => {
  if (force) return { action: "build", reason: "forced" }
  if (distExists && sidecar && sidecar.key === key && sidecar.profile === profile)
    return { action: "noop", reason: "dist already carries this action key" }
  if (hasCacheEntry) return { action: "restore", reason: "cache hit" }
  if (!sidecar) return { action: "build", reason: distExists ? "no provenance for existing dist" : "no dist" }
  if (sidecar.profile !== profile) return { action: "build", reason: `profile ${sidecar.profile} -> ${profile}` }
  return { action: "build", reason: "inputs changed" }
}

/**
 * Digest of a directory's bytes: sorted path + content hash of each file. The
 * provenance sidecar is excluded — it records the digest, so including it would
 * be a cycle — and so are the banners' own file mtimes, which are not bytes.
 */
export const digestDir = (dir) => {
  const h = crypto.createHash("sha256")
  const walk = (abs, rel) => {
    let entries
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (childRel === SIDECAR) continue
      const full = path.join(abs, entry.name)
      if (entry.isDirectory()) {
        walk(full, childRel)
        continue
      }
      h.update(childRel)
      h.update("\0")
      try {
        h.update(fs.readFileSync(full))
      } catch {
        h.update("unreadable")
      }
    }
  }
  walk(dir, "")
  return h.digest("hex")
}

const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Serialize writers of one key. Stale locks (dead pid) are broken, not obeyed. */
export const withLock = (lockDir, fn, { timeoutMs = 15 * 60_000 } = {}) => {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true })
  const started = Date.now()
  for (;;) {
    try {
      fs.mkdirSync(lockDir)
      fs.writeFileSync(path.join(lockDir, "pid"), String(process.pid))
      break
    } catch (e) {
      if (e.code !== "EEXIST") throw e
      const pid = Number(fs.readFileSync(path.join(lockDir, "pid"), "utf8").trim() || 0)
      let alive = false
      try {
        process.kill(pid, 0)
        alive = true
      } catch {}
      if (!alive || Date.now() - started > timeoutMs) {
        fs.rmSync(lockDir, { recursive: true, force: true })
        continue
      }
      sleepSync(500)
    }
  }
  try {
    return fn()
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true })
  }
}

export const hasEntry = (root, pkg, profile, key) => {
  const { tar, manifest } = entryPaths(root, pkg, profile, key)
  return fs.existsSync(tar) && fs.existsSync(manifest)
}

export const readManifest = (root, pkg, profile, key) => {
  try {
    return JSON.parse(fs.readFileSync(entryPaths(root, pkg, profile, key).manifest, "utf8"))
  } catch {
    return null
  }
}

/** Publish dist/ into the store, atomically. */
export const storeEntry = ({ root, pkg, profile, key, repoDir, dist = "dist", manifest }) => {
  const { dir, tar, manifest: manifestPath } = entryPaths(root, pkg, profile, key)
  fs.mkdirSync(dir, { recursive: true })
  const tmpTar = `${tar}.${process.pid}.tmp`
  execFileSync("tar", ["-C", repoDir, "-cf", tmpTar, dist])
  fs.renameSync(tmpTar, tar)
  const tmpManifest = `${manifestPath}.${process.pid}.tmp`
  fs.writeFileSync(tmpManifest, `${JSON.stringify(manifest, null, 2)}\n`)
  fs.renameSync(tmpManifest, manifestPath)
  return { tar, manifest: manifestPath, bytes: fs.statSync(tar).size }
}

/** Replace dist/ with the cached artifact, atomically from the repo's view. */
export const restoreEntry = ({ root, pkg, profile, key, repoDir, dist = "dist" }) => {
  const { tar } = entryPaths(root, pkg, profile, key)
  const staging = path.join(repoDir, `.tsc-dev-restore.${process.pid}`)
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  try {
    execFileSync("tar", ["-C", staging, "-xf", tar])
    const target = path.join(repoDir, dist)
    const old = `${target}.old.${process.pid}`
    if (fs.existsSync(target)) fs.renameSync(target, old)
    fs.renameSync(path.join(staging, dist), target)
    fs.rmSync(old, { recursive: true, force: true })
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
  return readManifest(root, pkg, profile, key)
}

const listEntries = (root) => {
  const out = []
  let pkgs
  try {
    pkgs = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const pkg of pkgs) {
    if (!pkg.isDirectory()) continue
    for (const profile of fs.readdirSync(path.join(root, pkg.name), { withFileTypes: true })) {
      if (!profile.isDirectory()) continue
      const dir = path.join(root, pkg.name, profile.name)
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".tar")) continue
        const full = path.join(dir, file)
        const { size, mtimeMs } = fs.statSync(full)
        out.push({ pkg: pkg.name, profile: profile.name, key: file.slice(0, -4), tar: full, size, mtimeMs })
      }
    }
  }
  return out
}

/** Which entries a keep-N-newest-per-target policy would delete. Pure. */
export const entriesToPrune = (entries, keep) => {
  const groups = new Map()
  for (const e of entries) {
    const k = `${e.pkg}/${e.profile}`
    groups.set(k, [...(groups.get(k) ?? []), e])
  }
  const doomed = []
  for (const list of groups.values()) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs)
    doomed.push(...list.slice(keep))
  }
  return doomed
}

export const cacheEnabled = () => process.env.TSC_DEV_NO_CACHE !== "1"

if (isMain(import.meta.url)) {
  const [sub, ...rest] = process.argv.slice(2)
  const root = cacheRoot()
  const human = (n) => `${(n / 1e6).toFixed(1)}MB`
  if (sub === "status" || !sub) {
    const entries = listEntries(root)
    console.log(`• ${root}`)
    if (entries.length === 0) {
      console.log("  (empty)")
    } else {
      const byTarget = new Map()
      for (const e of entries) {
        const k = `${e.pkg} ${e.profile}`
        const cur = byTarget.get(k) ?? { n: 0, size: 0 }
        byTarget.set(k, { n: cur.n + 1, size: cur.size + e.size })
      }
      for (const [k, v] of [...byTarget].sort())
        console.log(`  ${k.padEnd(44)} ${String(v.n).padStart(3)} entr${v.n === 1 ? "y" : "ies"}  ${human(v.size)}`)
      console.log(`  total ${entries.length} entries, ${human(entries.reduce((a, e) => a + e.size, 0))}`)
    }
  } else if (sub === "prune") {
    const i = rest.indexOf("--keep")
    const keep = i === -1 ? 3 : Number(rest[i + 1])
    const doomed = entriesToPrune(listEntries(root), keep)
    for (const e of doomed) {
      fs.rmSync(e.tar, { force: true })
      fs.rmSync(e.tar.replace(/\.tar$/, ".json"), { force: true })
      console.log(`  ✗ ${e.pkg} ${e.profile} ${e.key.slice(0, 12)} (${human(e.size)})`)
    }
    console.log(`✓ pruned ${doomed.length} entr${doomed.length === 1 ? "y" : "ies"} (kept ${keep} newest per target)`)
  } else {
    console.error("usage: build-cache.mjs <status|prune [--keep N]>")
    process.exit(2)
  }
}
