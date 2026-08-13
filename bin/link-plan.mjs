#!/usr/bin/env node
//
// link-plan.mjs — which local dependencies a repo should be yalc-linked to.
//
// `rebuild` used to answer this in bash, with two `node -p` spawns per
// dependency. That is the shape of the defect that once cost this workspace
// three minutes per rebuild (~1,200 spawns), and it also had nowhere to put a
// rule that needed more than a string comparison. Both reasons to move it here.
//
// The rule that needed a home: **a local build must not silently downgrade a
// consumer.** Linking is keyed on "is this dependency also a repo I have
// cloned?", which says nothing about whether the checkout is new enough. A
// checkout that is behind what the consumer's package.json asks for produces a
// build failure with no visible cause -- measured here: an old `circuit-to-svg`
// checkout got linked into runframe, whose source imports a symbol added three
// releases later, and the build failed on a missing export while every version
// number in sight looked plausible. Worse, the consumer had been *working*
// until the link replaced a correct npm copy.
//
// So a dependency whose local version is below the consumer's declared minimum
// is reported and skipped, not linked.
import fs from "node:fs"
import path from "node:path"
import { isMain } from "./is-main.mjs"

/** Numeric compare of two dotted versions, ignoring any prerelease suffix. */
export const compareVersions = (a, b) => {
  const parts = (v) =>
    String(v ?? "")
      .replace(/[-+].*$/, "")
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0)
  const [pa, pb] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1
  }
  return 0
}

/**
 * The minimum version a dependency spec asks for, or null when the spec does
 * not express one (a tag, a URL, a yalc link, a wildcard). Deliberately not a
 * semver implementation: the only question here is "is my checkout older than
 * what this consumer needs?", and anything it cannot answer confidently it
 * declines to answer at all.
 */
export const minimumVersionOf = (spec) => {
  if (typeof spec !== "string") return null
  const trimmed = spec.trim()
  if (!trimmed || trimmed.includes("||")) return null
  const m = /^(?:\^|~|>=|=|v)?\s*(\d+\.\d+\.\d+)/.exec(trimmed)
  return m ? m[1] : null
}

/**
 * Merge manifest dependency sections without letting a peer wildcard erase a
 * concrete runtime/dev minimum. When several sections specify versions, retain
 * the strictest minimum: local linking must satisfy every declared role.
 */
export const mergeDependencySpecs = (...groups) => {
  const merged = {}
  for (const group of groups) {
    for (const [pkg, spec] of Object.entries(group ?? {})) {
      if (!(pkg in merged)) {
        merged[pkg] = spec
        continue
      }
      const currentMinimum = minimumVersionOf(merged[pkg])
      const nextMinimum = minimumVersionOf(spec)
      if (
        nextMinimum &&
        (!currentMinimum || compareVersions(nextMinimum, currentMinimum) > 0)
      ) {
        merged[pkg] = spec
      }
    }
  }
  return merged
}

/**
 * @param deps           { name: declaredSpec } from the consumer's package.json
 * @param localPackages  { name: { repo, version } } workspace packages
 * @param inStore        (name) => boolean — has this ever been published locally?
 * @param installed      (name) => installed version string | null
 * @param repo           the consumer's own repo name
 * @returns [{ pkg, action: "add"|"skip", reason }]
 */
export const planLinks = ({ deps, localPackages, inStore, installed, repo }) => {
  const plan = []
  for (const [pkg, spec] of Object.entries(deps ?? {})) {
    const local = localPackages[pkg]
    if (!local) continue // not a workspace package: nothing to link
    if (local.repo === repo) continue // never self-link
    if (!inStore(pkg)) {
      // `yalc add` against a package that was never published spends seconds to
      // print "Could not find package in store, skipping".
      plan.push({ pkg, action: "skip", reason: "never published locally" })
      continue
    }
    const have = installed(pkg)
    // Compare against the BASE version: a checkout whose package.json still
    // carries a stamp from an interrupted build (`0.0.1609-local.…`) would
    // otherwise never look current, and every rebuild would re-add the link.
    const localBase = String(local.version).replace(/-local\..*$/, "")
    // A stamped local build carries the repo's version as its prefix; anything
    // else (an npm copy, a missing link, an older stamp) needs the add.
    if (have && (have === localBase || have.startsWith(`${localBase}-local.`))) {
      plan.push({ pkg, action: "skip", reason: "link is current" })
      continue
    }
    const minimum = minimumVersionOf(spec)
    if (minimum && compareVersions(localBase, minimum) < 0) {
      plan.push({
        pkg,
        action: "skip",
        reason: `local checkout is ${localBase}, ${repo} needs ${spec} — linking it would downgrade ${repo}`,
        downgrade: true,
      })
      continue
    }
    plan.push({ pkg, action: "add", reason: have ? `have ${have}` : "not installed" })
  }
  return plan
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

if (isMain(import.meta.url)) {
  const [root, repo, storeDir] = process.argv.slice(2)
  if (!root || !repo) {
    console.error("usage: link-plan.mjs <workspace-root> <repo> [yalc-store]")
    process.exit(2)
  }
  const store = storeDir ?? path.join(process.env.HOME ?? "", ".yalc")
  const pkg = readJson(path.join(root, repo, "package.json")) ?? {}
  const localPackages = {}
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const p = readJson(path.join(root, entry.name, "package.json"))
    if (p?.name) localPackages[p.name] = { repo: entry.name, version: String(p.version ?? "") }
  }
  const deps = mergeDependencySpecs(
    pkg.peerDependencies,
    pkg.optionalDependencies,
    pkg.dependencies,
    pkg.devDependencies,
  )
  const plan = planLinks({
    deps,
    localPackages,
    repo,
    inStore: (name) => fs.existsSync(path.join(store, "packages", name)),
    installed: (name) => readJson(path.join(root, repo, "node_modules", name, "package.json"))?.version ?? null,
  })
  // One line per decision: `<action> <pkg> <reason>`, for the shell to read.
  for (const { pkg: name, action, reason, downgrade } of plan)
    console.log(`${downgrade ? "refuse" : action}\t${name}\t${reason}`)
}
