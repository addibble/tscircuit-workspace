#!/usr/bin/env node
//
// build.mjs — build one repo, once, under a known identity.
//
// This is the single place a repo's build is invoked from (tsc-dev's publish,
// push, rebuild, watch and playground paths all come through here), so the four
// things that must be true of every local build are true by construction rather
// than by remembering:
//
//   1. its identity is derived from its inputs, not from the clock
//      (action-key.mjs) — so an unchanged build reuses its version and the yalc
//      store stops growing one directory per publish;
//   2. it does only the work the requested profile needs (build-profile.mjs) —
//      declaration emit is 61% of a full chain and the inner loop reads none of
//      it;
//   3. what it produced can be identified later from the artifact itself
//      (provenance.mjs) — a cache makes "am I running my change?" harder, not
//      easier, so the answer is written into the bytes;
//   4. work already done is not repeated (build-cache.mjs).
//
// Usage:
//   build.mjs key    <root> <repo> [--profile dev|full]
//   build.mjs build  <root> <repo> [--profile dev|full] [--force] [--no-cache]
//   build.mjs verify <root> <repo> [--profile dev|full]   rebuild and compare with the cache
//   build.mjs expect <root> [repo...]                     current provenance, as JSON
import fs from "node:fs"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { isMain } from "./is-main.mjs"
import { loadConfig } from "./workspace-config.mjs"
import { inputRulesFor, listBuildInputs } from "./build-inputs.mjs"
import { planBuild, skipStepsFor, wrapperSource } from "./build-profile.mjs"
import { computeActionKey, hashFile, installedIdentity, normalizePackageJson, stampFor } from "./action-key.mjs"
import { readProvenance, stampArtifacts, writeProvenance } from "./provenance.mjs"
import {
  cacheEnabled,
  cacheRoot,
  decideBuild,
  digestDir,
  hasEntry,
  readManifest,
  restoreEntry,
  storeEntry,
  withLock,
} from "./build-cache.mjs"
import { record as recordTiming } from "./timings.mjs"

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

/** package name -> repo directory name, for every cloned sibling. */
export const workspacePackages = (root) => {
  const map = new Map()
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pkg = readJson(path.join(root, entry.name, "package.json"))
    if (pkg?.name) map.set(pkg.name, entry.name)
  }
  return map
}

let bunVersion = null
const toolchain = () => {
  if (bunVersion === null) {
    try {
      bunVersion = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim()
    } catch {
      bunVersion = "absent"
    }
  }
  return { bun: bunVersion, node: process.version, platform: process.platform, arch: process.arch }
}

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies"]

/**
 * Everything the key is computed from, plus the plan the build will run — the
 * two are returned together because they must agree: the commands are part of
 * the identity, so a profile that changes the commands changes the key.
 */
export const describeTarget = (root, repo, profile) => {
  const repoDir = path.resolve(root, repo)
  const pkg = readJson(path.join(repoDir, "package.json"))
  if (!pkg) throw new Error(`no package.json in ${repo}`)
  const config = loadConfig(root)
  const rules = inputRulesFor(config, repo)
  const { steps, skipped } = planBuild({
    scripts: pkg.scripts ?? {},
    profile,
    skipSteps: skipStepsFor(config, repo, profile),
  })
  const files = listBuildInputs(repoDir, rules)
    .filter((rel) => rel !== "package.json")
    .map((rel) => [rel, hashFile(path.join(repoDir, rel))])
  const local = workspacePackages(root)
  const deps = {}
  for (const field of DEP_FIELDS)
    for (const name of Object.keys(pkg[field] ?? {}))
      if (local.has(name) && local.get(name) !== repo) deps[name] = installedIdentity(repoDir, name)
  const key = computeActionKey({
    repo,
    profile,
    packageJson: normalizePackageJson(fs.readFileSync(path.join(repoDir, "package.json"), "utf8")),
    files,
    deps,
    toolchain: toolchain(),
    steps: steps.map((s) => s.command),
  })
  return { repoDir, pkg, steps, skipped, files, deps, key, hasBuild: Boolean(pkg.scripts?.build) }
}

const DECL_RE = /\.d\.(ts|mts|cts)$/

const collectDeclarations = (dir, rel = "", out = []) => {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) collectDeclarations(path.join(dir, entry.name), childRel, out)
    else if (DECL_RE.test(entry.name)) out.push(childRel)
  }
  return out
}

/**
 * Keep the last known-good .d.ts around a declaration-free build.
 *
 * Editors resolve types through the yalc snapshot, not through source, so a
 * fast build that cleans dist would break every consumer's editor — and the
 * consumer would blame their own checkout. Preserved declarations are recorded
 * as `preserved-stale` in provenance so `doctor` can say so out loud.
 */
const preserveDeclarations = (distDir) => {
  const files = collectDeclarations(distDir)
  if (files.length === 0) return null
  const stash = fs.mkdtempSync(path.join(path.dirname(distDir), ".tsc-dev-dts."))
  for (const rel of files) {
    const dest = path.join(stash, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(distDir, rel), dest)
  }
  return { stash, files }
}

const restoreDeclarations = (distDir, saved) => {
  if (!saved) return { restored: 0 }
  let restored = 0
  for (const rel of saved.files) {
    const dest = path.join(distDir, rel)
    if (fs.existsSync(dest)) continue
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(saved.stash, rel), dest)
    restored++
  }
  fs.rmSync(saved.stash, { recursive: true, force: true })
  return { restored }
}

const runSteps = ({ repoDir, steps, log }) => {
  const wrappers = []
  const timings = []
  // A package script normally runs with the repo's node_modules/.bin on PATH —
  // that is how `tsup-node` resolves at all. Running the command ourselves
  // means providing it, or every build dies with "command not found".
  const env = {
    ...process.env,
    PATH: `${path.join(repoDir, "node_modules", ".bin")}:${process.env.PATH}`,
  }
  try {
    for (const step of steps) {
      if (step.wrapsConfig) {
        const wrapper = path.join(repoDir, step.wrapperPath)
        fs.writeFileSync(wrapper, wrapperSource(step.wrapsConfig))
        wrappers.push(wrapper)
      }
      log(`  ↳ ${step.command}`)
      const started = Date.now()
      const res = spawnSync("bash", ["-c", step.command], {
        cwd: repoDir,
        stdio: "inherit",
        env: { ...env, npm_lifecycle_event: step.script },
      })
      const ms = Date.now() - started
      timings.push({ script: step.script, command: step.command, ms })
      if (res.status !== 0) {
        const err = new Error(`build step failed (exit ${res.status}): ${step.command}`)
        err.timings = timings
        throw err
      }
    }
  } finally {
    for (const w of wrappers) fs.rmSync(w, { force: true })
  }
  return timings
}

export const buildRepo = (root, repo, opts = {}) => {
  const profile = opts.profile ?? "full"
  const log = opts.log ?? ((m) => console.log(m))
  const target = describeTarget(root, repo, profile)
  const { repoDir, pkg, steps, skipped, key } = target
  const version = stampFor(pkg.version ?? "0.0.0", profile, key)
  const distDir = path.join(repoDir, "dist")
  const started = Date.now()

  if (!target.hasBuild) {
    log(`ℹ ${repo} has no build script (source-only package)`)
    return { result: "source-only", key, version }
  }

  // Leftovers from a build that was killed rather than failed: a generated
  // no-dts config, a declaration stash, a half-finished cache restore. They are
  // all excluded from the input set so they cannot change a key, but they show
  // up in `git status` and get committed by accident.
  for (const entry of fs.readdirSync(repoDir))
    if (/^(tsup\.tsc-dev-nodts\..*\.config\.|\.tsc-dev-(restore|dts)\.)/.test(entry))
      fs.rmSync(path.join(repoDir, entry), { recursive: true, force: true })

  const useCache = cacheEnabled() && !opts.noCache
  const croot = cacheRoot()
  const decision = decideBuild({
    sidecar: readProvenance(distDir),
    key,
    profile,
    distExists: fs.existsSync(distDir),
    hasCacheEntry: useCache && hasEntry(croot, pkg.name, profile, key),
    force: Boolean(opts.force),
  })

  const finish = (result, extra = {}) => {
    const durationMs = Date.now() - started
    // Written on EVERY path, no-ops included: stale-bundles.mjs reads dist
    // mtimes, so "nothing to do" must still register as "checked just now" or a
    // chain sync would rebuild an unchanged consumer on every pass, forever.
    writeProvenance(distDir, {
      repo,
      pkg: pkg.name,
      profile,
      key,
      version,
      result,
      builtAt: extra.builtAt ?? readProvenance(distDir)?.builtAt ?? new Date().toISOString(),
      checkedAt: new Date().toISOString(),
      artifactDigest: extra.artifactDigest ?? readProvenance(distDir)?.artifactDigest ?? null,
      declarations: extra.declarations ?? readProvenance(distDir)?.declarations ?? "unknown",
      skippedSteps: skipped,
      steps: extra.steps ?? readProvenance(distDir)?.steps ?? [],
      deps: target.deps,
      inputCount: target.files.length,
      toolchain: toolchain(),
    })
    recordTiming(root, { repo, pkg: pkg.name, profile, key, result, durationMs, steps: extra.steps ?? [] })
    return { result, key, version, durationMs, ...extra }
  }

  if (decision.action === "noop") {
    log(`✓ ${repo}: up to date (${decision.reason}, ${profile} ${key.slice(0, 12)})`)
    return finish("no-op")
  }

  return withLock(path.join(root, ".run", "locks", `${repo}.${profile}.lock`), () => {
    // Another writer may have finished this exact key while we waited.
    const after = readProvenance(distDir)
    if (!opts.force && after?.key === key && after?.profile === profile && fs.existsSync(distDir)) {
      log(`✓ ${repo}: up to date (built by a concurrent run)`)
      return finish("no-op")
    }
    if (decision.action === "restore" && !opts.force) {
      const manifest = restoreEntry({ root: croot, pkg: pkg.name, profile, key, repoDir })
      log(`✓ ${repo}: restored from cache (${profile} ${key.slice(0, 12)})`)
      return finish("cache-hit", {
        builtAt: manifest?.builtAt,
        artifactDigest: manifest?.artifactDigest,
        declarations: manifest?.declarations,
        steps: manifest?.steps,
      })
    }

    log(`▶ build ${repo} (${profile}${skipped.length ? `, skipping ${skipped.join(", ")}` : ""}) — ${decision.reason}`)
    const saved = profile === "dev" ? preserveDeclarations(distDir) : null
    let stepTimings
    try {
      stepTimings = runSteps({ repoDir, steps, log })
    } catch (e) {
      if (saved) fs.rmSync(saved.stash, { recursive: true, force: true })
      // A failed build is a fact worth keeping: "it fails, slowly, every time"
      // is invisible otherwise, and the sidecar is deliberately NOT written, so
      // nothing downstream can mistake a half-built dist for a current one.
      recordTiming(root, {
        repo,
        pkg: pkg.name,
        profile,
        key,
        result: "failed",
        durationMs: Date.now() - started,
        steps: e.timings ?? [],
      })
      throw e
    }
    const present = collectDeclarations(distDir).length
    const { restored } = restoreDeclarations(distDir, saved)
    // A dev build emits no declarations at all, so anything present afterwards
    // is left over from an earlier full build — either survived (the step did
    // not clean) or copied back by preserveDeclarations. Calling that "current"
    // would be the same lie the mtime rules used to tell.
    const declarations =
      profile === "full"
        ? present > 0
          ? "current"
          : "absent"
        : present + restored > 0
          ? "preserved-stale"
          : "absent"
    if (restored > 0) log(`  ↳ preserved ${restored} declaration file(s) from the previous full build`)

    const stamped = stampArtifacts(distDir, { repo, pkg: pkg.name, profile, key, version })
    const artifactDigest = digestDir(distDir)
    log(`  ↳ ${stamped} artifact(s) stamped ${key.slice(0, 12)}; digest ${artifactDigest.slice(0, 12)}`)

    // Record provenance BEFORE the artifact is tarred into the cache, or the
    // cached copy carries the PREVIOUS build's sidecar and a restore starts by
    // lying about what it just restored. Found by restoring an entry by hand
    // while debugging: the tar said it was a build that had been replaced.
    const outcome = finish("built", {
      builtAt: new Date().toISOString(),
      artifactDigest,
      declarations,
      steps: stepTimings,
    })

    if (useCache) {
      try {
        const { bytes } = storeEntry({
          root: croot,
          pkg: pkg.name,
          profile,
          key,
          repoDir,
          manifest: {
            repo,
            pkg: pkg.name,
            profile,
            key,
            version,
            artifactDigest,
            declarations,
            steps: stepTimings,
            skippedSteps: skipped,
            builtAt: new Date().toISOString(),
            toolchain: toolchain(),
            deps: target.deps,
          },
        })
        log(`  ↳ cached ${(bytes / 1e6).toFixed(1)}MB`)
      } catch (e) {
        log(`  ⚠ could not populate the build cache: ${e.message}`)
      }
    }
    return outcome
  })
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2)
  const sub = argv[0]
  const VALUE_FLAGS = new Set(["--profile"])
  const flag = (name, fallback = null) => {
    const i = argv.indexOf(name)
    return i === -1 ? fallback : argv[i + 1]
  }
  const positional = []
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      if (VALUE_FLAGS.has(argv[i])) i++
      continue
    }
    positional.push(argv[i])
  }
  const root = path.resolve(positional[0] ?? process.cwd())
  const repo = positional[1]
  const profile = flag("--profile", process.env.TSC_DEV_PROFILE ?? "full")

  if (sub === "key") {
    if (!repo) {
      console.error("usage: build.mjs key <root> <repo> [--profile dev|full]")
      process.exit(2)
    }
    const { key } = describeTarget(root, repo, profile)
    console.log(key)
  } else if (sub === "build") {
    if (!repo) {
      console.error("usage: build.mjs build <root> <repo> [--profile dev|full]")
      process.exit(2)
    }
    try {
      buildRepo(root, repo, {
        profile,
        force: argv.includes("--force"),
        noCache: argv.includes("--no-cache"),
      })
    } catch (e) {
      console.error(`✗ ${repo}: ${e.message}`)
      process.exit(1)
    }
  } else if (sub === "verify") {
    // A wrong cache hit looks exactly like a right one, so the only defence is
    // to rebuild and compare. Embedded clocks, absolute paths and unstable
    // chunk ids are build bugs, not reasons to weaken the key.
    if (!repo) {
      console.error("usage: build.mjs verify <root> <repo> [--profile dev|full]")
      process.exit(2)
    }
    const { key } = describeTarget(root, repo, profile)
    const pkgName = readJson(path.join(root, repo, "package.json")).name
    const before = readManifest(cacheRoot(), pkgName, profile, key)
    if (!before) {
      console.error(`no cache entry for ${repo} ${profile} ${key.slice(0, 12)} — build it first`)
      process.exit(1)
    }
    const out = buildRepo(root, repo, { profile, force: true })
    if (out.artifactDigest === before.artifactDigest) {
      console.log(`✓ ${repo}: rebuild is byte-identical to the cached artifact (${out.artifactDigest.slice(0, 12)})`)
    } else {
      console.log(`✗ ${repo}: rebuild differs from the cached artifact`)
      console.log(`    cached ${before.artifactDigest}`)
      console.log(`    rebuilt ${out.artifactDigest}`)
      process.exit(1)
    }
  } else if (sub === "expect") {
    // What the workspace believes each repo's current build is, for
    // `doctor --verify-running` to compare against what is being served.
    const repos = positional.slice(1)
    const out = {}
    for (const r of repos) {
      const prov = readProvenance(path.join(root, r, "dist"))
      if (prov) out[r] = { key: prov.key, profile: prov.profile, version: prov.version }
    }
    console.log(JSON.stringify(out))
  } else {
    console.error("usage: build.mjs <key|build|verify|expect> <root> <repo> [--profile dev|full]")
    process.exit(2)
  }
}
