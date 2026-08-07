#!/usr/bin/env node
//
// action-key.mjs — the identity of a build, derived from its inputs.
//
// Local builds used to be stamped `X.Y.Z-local.<UTC clock>`, which was right
// about the danger it was invented for (a local build must never wear a version
// npm can also mint) and wrong about everything else:
//
//   * two builds of identical source got different identities, so nothing could
//     ever be reused and the yalc store grew one directory per publish — 80
//     versions of core, 3.8GB;
//   * the identity said WHEN it was built, never WHAT from, so "is the browser
//     running my change?" could only be answered by decoding the artifact.
//
// The clock is replaced by a hash of the declared inputs. Same inputs, same
// version string; different inputs, different version string. The prerelease
// shape is kept exactly as it was, so the npm-collision property is unchanged.
//
// Two identities, not one, as the analysis insisted:
//   * the ACTION KEY (here) says whether a build may be reused;
//   * the ARTIFACT DIGEST (bin/build-cache.mjs) says what bytes a consumer
//     actually embedded.
// A consumer is keyed by its dependencies' artifact identity, not by their
// source, so a source change that produces identical output does not cascade.
//
// The key deliberately hashes:
//   - the declared build inputs (bin/build-inputs.mjs), by content;
//   - the package manifest, NORMALIZED so tsc-dev's own rewrites (the local
//     version stamp, `file:.yalc/...` specifiers) do not change the key;
//   - the resolved identity of every local dependency (its yalcSig, which is
//     yalc's own content signature, else its version);
//   - the toolchain and platform, and the profile — a JS-only artifact must
//     never satisfy a request for a full one;
//   - a schema version, so a change to what we hash invalidates everything.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { isMain } from "./is-main.mjs"

// Bump when the meaning of the key changes (new hashed field, different
// normalization). Old entries then miss instead of being misread.
export const SCHEMA = 2

export const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex")

export const hashFile = (file) => {
  try {
    return sha256(fs.readFileSync(file))
  } catch {
    return "missing"
  }
}

const stableStringify = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`
}

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]

/**
 * package.json with the fields tsc-dev itself rewrites neutralized.
 *
 * The local version stamp is derived from this hash, so it must not be part of
 * it (that would be a cycle), and a yalc link's `file:.yalc/<pkg>` specifier
 * says nothing the dependency's own artifact identity does not already say —
 * hashing it would make every link/unlink look like a source change.
 */
export const normalizePackageJson = (text) => {
  let pkg
  try {
    pkg = JSON.parse(text)
  } catch {
    return text
  }
  if (typeof pkg.version === "string") pkg.version = pkg.version.replace(/-local\..*$/, "")
  for (const field of DEP_FIELDS) {
    if (!pkg[field]) continue
    for (const [name, spec] of Object.entries(pkg[field])) {
      if (typeof spec === "string" && (spec.startsWith("file:.yalc/") || spec.startsWith("link:"))) {
        pkg[field][name] = "<local-link>"
      }
    }
  }
  delete pkg.yalcSig
  return stableStringify(pkg)
}

/**
 * The identity of one local dependency AS INSTALLED — yalc's own content
 * signature when present, else the plain version. This is the artifact edge:
 * it changes when the dependency's bytes change, and not when its source
 * changes without effect.
 */
export const installedIdentity = (repoDir, depName) => {
  const file = path.join(repoDir, "node_modules", depName, "package.json")
  try {
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"))
    return pkg.yalcSig ? `yalc:${pkg.yalcSig}` : `v:${pkg.version}`
  } catch {
    return "absent"
  }
}

/**
 * @param parts.repo        repo name (a rename is a different target)
 * @param parts.profile     "full" | "dev"
 * @param parts.packageJson normalized manifest text
 * @param parts.files       [[relPath, contentHash], ...] (order-independent)
 * @param parts.deps        { depName: identity }
 * @param parts.toolchain   { bun, node, platform, arch }
 * @param parts.steps       the exact commands that will run
 * @param parts.env         declared environment that changes output
 * @returns full hex digest; the first 12 chars are what the version stamp uses
 */
export const computeActionKey = (parts) =>
  sha256(
    stableStringify({
      schema: SCHEMA,
      repo: parts.repo,
      profile: parts.profile,
      packageJson: parts.packageJson,
      files: Object.fromEntries(parts.files ?? []),
      deps: parts.deps ?? {},
      toolchain: parts.toolchain ?? {},
      steps: parts.steps ?? [],
      env: parts.env ?? {},
    }),
  )

/**
 * The local version a build wears. Same shape as the timestamp scheme it
 * replaces (`X.Y.Z-local.…`, a prerelease that sorts below its release and
 * satisfies no ordinary range) with the profile and the input hash in place of
 * the clock — so `doctor`'s "unstamped" check, `rebuild`'s link-freshness
 * check and `prune-store` all keep working unchanged.
 */
export const stampFor = (version, profile, key) =>
  `${String(version).replace(/-local\..*$/, "")}-local.${profile}.${key.slice(0, 12)}`

/** The inverse, for tools that read a version off an installed package. */
export const parseStamp = (version) => {
  const m = /^(.*)-local\.(?:([a-z]+)\.)?([0-9a-zA-Z]+)$/.exec(String(version ?? ""))
  if (!m) return null
  return { base: m[1], profile: m[2] ?? null, key: m[3] }
}

if (isMain(import.meta.url)) {
  const [file] = process.argv.slice(2)
  if (!file) {
    console.error("usage: action-key.mjs <package.json>   # print the normalized manifest")
    process.exit(2)
  }
  console.log(normalizePackageJson(fs.readFileSync(file, "utf8")))
}
