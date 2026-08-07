#!/usr/bin/env node
//
// verify-running.mjs — is the browser running the code on disk?
//
// The most expensive failures in this workspace have not been wrong code; they
// have been RIGHT code that was not running. An eval worker inlined six hours
// earlier, a dev server quietly redirecting to the CDN bundle after dist was
// wiped, a 3D viewer resolved from a published package while a local build sat
// unused. None of them failed. Each cost hours, and each was ultimately settled
// by decoding the artifact and grepping it.
//
// Now every local build stamps its action key into its JS (bin/provenance.mjs),
// and those stamps survive inlining, base64 embedding and serve-time injection.
// So the check is: fetch what the server is actually serving, list the build
// keys inside it, and compare them with the keys the workspace says are current.
//
//   usage: verify-running.mjs <root> [url] [--repos eval,runframe,core]
//
// Exit status is 1 if anything served is stale or missing, so it can gate.
import fs from "node:fs"
import path from "node:path"
import { isMain } from "./is-main.mjs"
import { compareRunning, extractBuildKeys, readProvenance } from "./provenance.mjs"

export const DEFAULT_URL = "http://localhost:3020/standalone.min.js"

/** What the workspace believes is current, from each repo's provenance sidecar. */
export const expectedFromWorkspace = (root, repos) => {
  const out = {}
  for (const repo of repos) {
    const prov = readProvenance(path.join(root, repo, "dist"))
    if (prov?.key) out[repo] = { key: prov.key, profile: prov.profile, version: prov.version }
  }
  return out
}

export const formatVerification = (results) =>
  results.map((r) => {
    if (r.status === "ok") return `  ✓ ${r.repo.padEnd(22)} ${r.key.slice(0, 12)} (${r.profile})`
    if (r.status === "stale")
      return `  ✗ ${r.repo.padEnd(22)} serving ${r.actual.slice(0, 12)}, workspace has ${r.expected.slice(0, 12)} — rebuild the chain that inlines it`
    if (r.status === "absent")
      return `  · ${r.repo.padEnd(22)} not embedded here (external, or not part of this bundle)`
    return `  · ${r.repo.padEnd(22)} embedded but not built here (${r.actual.slice(0, 12)})`
  })

/**
 * Only a STALE embed is a failure: it proves the artifact contains a build that
 * has been superseded. An absent one proves nothing — the bundling graph is a
 * superset, and `cli` is never in the browser bundle at all.
 *
 * The one exception is an artifact with none of the expected builds in it,
 * which is the "the dev server fell back to the CDN bundle" case.
 */
export const isClean = (results) => {
  if (results.some((r) => r.status === "stale")) return false
  const expectedCount = results.filter((r) => r.status !== "unknown").length
  const present = results.filter((r) => r.status === "ok").length
  return expectedCount === 0 || present > 0
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2)
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repos") {
      i++
      continue
    }
    if (argv[i].startsWith("--")) continue
    positional.push(argv[i])
  }
  const root = positional[0] ?? process.cwd()
  const reposIdx = argv.indexOf("--repos")
  const repos =
    reposIdx === -1 ? ["eval", "runframe"] : String(argv[reposIdx + 1]).split(",").filter(Boolean)
  // A URL, or a path to an artifact on disk — the same check is useful for
  // "what did the dev server just serve me?" and "what is in this file?".
  const target = positional[1] ?? DEFAULT_URL

  let text
  if (!/^https?:\/\//.test(target)) {
    if (!fs.existsSync(target)) {
      console.log(`✗ no such artifact: ${target}`)
      process.exit(1)
    }
    text = fs.readFileSync(target.replace(/^file:\/\//, ""), "utf8")
  } else {
    let res
    try {
      res = await fetch(target, { redirect: "manual" })
    } catch (e) {
      console.log(`✗ ${target}: ${e.cause?.code ?? e.message} — no dev server is listening there`)
      console.log("  start one with `./tsc-dev playground start`, or pass a file path instead")
      process.exit(1)
    }
    if (res.status >= 300 && res.status < 400) {
      console.log(`✗ ${target} redirects to ${res.headers.get("location")}`)
      console.log("  the server is NOT serving a local bundle — start it with `./tsc-dev dev <proj> --local`")
      process.exit(1)
    }
    if (!res.ok) {
      console.log(`✗ ${target}: HTTP ${res.status} (is the dev server running?)`)
      process.exit(1)
    }
    text = await res.text()
  }

  const found = extractBuildKeys(text)
  const expected = expectedFromWorkspace(root, repos)
  console.log(`• ${target} (${(text.length / 1e6).toFixed(1)}MB, ${found.length} build stamp(s))`)
  if (found.length === 0)
    console.log("  ⚠ no tsc-dev build stamps at all — this artifact was not built by this workspace")
  const results = compareRunning(found, expected)
  for (const line of formatVerification(results)) console.log(line)
  process.exit(isClean(results) ? 0 : 1)
}
