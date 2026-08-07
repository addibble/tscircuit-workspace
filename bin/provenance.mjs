#!/usr/bin/env node
//
// provenance.mjs — make an artifact able to answer "are you the build I think
// you are?"
//
// Three separate hours in one session went to running code that was not the
// code on disk: an eval worker inlined six hours earlier, a published
// jscad-electronics where a local build was assumed, and a dev server silently
// falling back to the CDN bundle after dist was wiped. Every one of them was
// finally diagnosed the same way — decode the artifact and grep it for a symbol
// only the new code contains.
//
// A build cache makes that class of failure MORE likely, not less: a wrong
// cache hit is indistinguishable from a correct one at the point of use. So
// provenance is written in two places, deliberately:
//
//   1. a sidecar (`dist/.tsc-dev-build.json`) — the full record: action key,
//      profile, version, artifact digest, which steps ran, whether the
//      declarations are current, preserved from an older build, or absent;
//   2. a BANNER inside every emitted .js file — `//__TSC_DEV_BUILD__ {...}`.
//
// Only the second one can answer the question that actually gets asked, because
// the question is asked about a bundle: the banner survives being inlined by
// tsup, base64-embedded into runframe's standalone, and spliced in at serve
// time, so `curl localhost:3020/standalone.min.js | grep __TSC_DEV_BUILD__`
// lists every build that went into what the browser is running. That is an
// 8-minute bisect turned into a one-second check.
//
// The banner carries no timestamp on purpose: it is part of the artifact's
// bytes, so a clock in it would make two identical builds differ and defeat
// `cache verify`.
import fs from "node:fs"
import path from "node:path"
import { isMain } from "./is-main.mjs"

export const MARKER = "__TSC_DEV_BUILD__"
export const SIDECAR = ".tsc-dev-build.json"

/**
 * The one-line comment appended to every emitted JS file.
 *
 * A LEGAL comment (`/*!`), not a plain one, and that detail is the whole point:
 * esbuild, terser and Vite all strip ordinary comments when they bundle, so a
 * `//` banner vanished the moment eval inlined core — measured, the first time
 * this was tried. Legal comments are preserved by default, so the stamp
 * survives every level of inlining down to the standalone bundle.
 */
export const bannerFor = ({ repo, pkg, profile, key, version }) =>
  `\n/*!${MARKER} ${JSON.stringify({ repo, pkg, profile, key, version })} */\n`

/**
 * Every build record embedded anywhere in a text artifact, in order.
 *
 * Two encodings have to be seen through, because they are the ones this
 * workspace's own pipeline uses:
 *
 *   * JSON-escaped — the worker is embedded as a string literal, so its banner
 *     arrives as `{\"repo\":\"eval\"...}`;
 *   * base64 — `inject-eval-worker.mjs` splices the worker in as
 *     `atob("...")`, which is exactly the step that made the six-hour-stale
 *     worker undetectable by eye.
 *
 * A stamp that cannot be found through the encoding the pipeline actually uses
 * would be provenance in name only.
 */
export const extractBuildKeys = (text, depth = 2) => {
  const out = []
  const re = new RegExp(`${MARKER}\\s+(\\{.*?\\})`, "g")
  for (const m of String(text).matchAll(re)) {
    const raw = m[1]
    for (const candidate of [raw, raw.replace(/\\"/g, '"').replace(/\\\\/g, "\\")]) {
      try {
        out.push(JSON.parse(candidate))
        break
      } catch {}
    }
  }
  if (depth > 0) {
    // Scanned by hand rather than with a regex: the payload is a 14MB base64
    // literal, and a `{64,}` character-class match over it blows the regex
    // engine's stack on a real standalone bundle.
    const s = String(text)
    let i = 0
    while ((i = s.indexOf('atob("', i)) !== -1) {
      const start = i + 6
      const end = s.indexOf('"', start)
      if (end === -1) break
      i = end
      if (end - start < 64) continue
      if (!/^[A-Za-z0-9+/=]{64}/.test(s.slice(start, start + 64))) continue
      try {
        out.push(...extractBuildKeys(Buffer.from(s.slice(start, end), "base64").toString("utf8"), depth - 1))
      } catch {}
    }
  }
  return out
}

/**
 * Compare what an artifact says it contains with what the workspace says it
 * should contain.
 *
 * @param found     records extracted from the served artifact
 * @param expected  { repo: { key, profile, version } } from each repo's sidecar
 * @returns [{ repo, status: "ok"|"stale"|"missing"|"unknown", ... }]
 *          "stale"   — a build of that repo is embedded, but not the current one
 *          "missing" — the repo should be embedded and is not
 *          "unknown" — something is embedded that the workspace did not build
 */
export const compareRunning = (found, expected) => {
  const byRepo = new Map()
  for (const rec of found) byRepo.set(rec.repo, rec)
  const out = []
  for (const [repo, want] of Object.entries(expected)) {
    const got = byRepo.get(repo)
    if (!got) out.push({ repo, status: "missing", expected: want.key })
    else if (got.key !== want.key)
      out.push({ repo, status: "stale", expected: want.key, actual: got.key, profile: got.profile })
    else out.push({ repo, status: "ok", key: got.key, profile: got.profile })
  }
  for (const [repo, got] of byRepo)
    if (!(repo in expected)) out.push({ repo, status: "unknown", actual: got.key })
  return out
}

export const readProvenance = (distDir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(distDir, SIDECAR), "utf8"))
  } catch {
    return null
  }
}

export const writeProvenance = (distDir, record) => {
  fs.mkdirSync(distDir, { recursive: true })
  fs.writeFileSync(path.join(distDir, SIDECAR), `${JSON.stringify(record, null, 2)}\n`)
}

const JS_EXT = new Set([".js", ".mjs", ".cjs"])

/** Files a banner may be appended to (never maps, declarations or binaries). */
export const bannerTargets = (distDir) => {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (entry.name.endsWith(".d.ts") || entry.name.endsWith(".map")) continue
      if (JS_EXT.has(path.extname(entry.name))) out.push(full)
    }
  }
  walk(distDir)
  return out.sort()
}

/** Append the banner to every emitted JS file that does not already carry it. */
export const stampArtifacts = (distDir, record) => {
  const banner = bannerFor(record)
  let stamped = 0
  for (const file of bannerTargets(distDir)) {
    let text
    try {
      text = fs.readFileSync(file, "utf8")
    } catch {
      continue
    }
    // A bundle can legitimately contain OTHER repos' banners (that is the
    // point); only skip when this exact record is already present.
    if (text.includes(`"key":"${record.key}"`) && text.includes(`"repo":"${record.repo}"`)) continue
    fs.appendFileSync(file, banner)
    stamped++
  }
  return stamped
}

if (isMain(import.meta.url)) {
  const [file] = process.argv.slice(2)
  if (!file) {
    console.error("usage: provenance.mjs <artifact>   # list the builds embedded in it")
    process.exit(2)
  }
  const text = file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(file, "utf8")
  for (const rec of extractBuildKeys(text))
    console.log(`${rec.repo.padEnd(24)} ${rec.profile.padEnd(5)} ${rec.key}  ${rec.version ?? ""}`)
}
