import { expect, test } from "bun:test"
import { bannerFor, compareRunning, extractBuildKeys } from "../bin/provenance.mjs"
import { injectEvalWorker } from "../bin/inject-eval-worker.mjs"
import { formatVerification, isClean } from "../bin/verify-running.mjs"

// Three separate hours in one session went to running code that was not the
// code on disk. Not one of them failed; each was finally settled by decoding
// the artifact and grepping it. A build cache makes that class of failure MORE
// likely, because a wrong cache hit is indistinguishable from a right one at
// the point of use — so the artifact has to be able to say what it is.

test("a build stamp survives being embedded in a bundle", () => {
  const worker = `console.log("eval")${bannerFor({ repo: "eval", pkg: "@tscircuit/eval", profile: "dev", key: "abc123", version: "1.0.0-local.dev.abc123" })}`
  // This is what runframe does to the worker: base64 it into a string literal
  // inside a much larger bundle. The stamp goes along for the ride.
  const standalone = `var worker=${JSON.stringify(worker)};${bannerFor({ repo: "runframe", pkg: "@tscircuit/runframe", profile: "dev", key: "def456", version: "2.0.0-local.dev.def456" })}`

  const found = extractBuildKeys(standalone)
  expect(found.map((f) => f.repo).sort()).toEqual(["eval", "runframe"])
  expect(found.find((f) => f.repo === "eval")!.key).toBe("abc123")
})

// The real pipeline does not embed the worker as a readable string: it base64s
// it into an `atob(...)` call. That encoding is exactly where "is the browser
// running my eval?" went unanswered for six hours, so the stamp has to be
// findable through it.
test("a build stamp survives base64 embedding, both ways", () => {
  const worker = `self.onmessage=()=>{}${bannerFor({ repo: "eval", pkg: "@tscircuit/eval", profile: "dev", key: "abc123", version: "1.0.0-local.dev.abc123" })}`
  const standalone = `var s=${JSON.stringify("placeholder")};${bannerFor({ repo: "runframe", pkg: "@tscircuit/runframe", profile: "dev", key: "def456", version: "2.0.0" })}`
  const served = injectEvalWorker({
    standalone: standalone.replace('"placeholder"', '"<--INJECT_TSCIRCUIT_EVAL_WEB_WORKER_BLOB_URL-->"'),
    worker,
  })

  // decodable...
  expect(extractBuildKeys(served).map((f) => f.repo).sort()).toEqual(["eval", "eval", "runframe"])
  // ...and greppable without decoding anything, which is how it is used at 2am
  expect(served).toContain(`/*!__TSC_DEV_BUILD__ {"repo":"eval"`)
})

test("an artifact with no stamps yields nothing rather than throwing", () => {
  expect(extractBuildKeys("just some javascript")).toEqual([])
  expect(extractBuildKeys("__TSC_DEV_BUILD__ {not json}")).toEqual([])
})

// The banner is part of the artifact's bytes, so a clock in it would make two
// identical builds differ and defeat `cache verify` outright.
test("the banner contains no timestamp", () => {
  const banner = bannerFor({ repo: "core", pkg: "@tscircuit/core", profile: "dev", key: "k", version: "v" })
  expect(banner).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  expect(bannerFor({ repo: "core", pkg: "@tscircuit/core", profile: "dev", key: "k", version: "v" })).toBe(banner)
})

// The real timeline: eval built at 12:46, the fix built at 19:00, runframe
// rebuilt at 19:49 — and the browser still ran the 12:46 worker.
test("a bundle carrying an older build of a repo is reported stale, not ok", () => {
  const results = compareRunning(
    [{ repo: "eval", key: "old", profile: "dev" }],
    { eval: { key: "new" }, runframe: { key: "rf" } },
  )
  expect(results.find((r) => r.repo === "eval")).toMatchObject({ status: "stale", actual: "old", expected: "new" })
  expect(results.find((r) => r.repo === "runframe")).toMatchObject({ status: "missing" })
  expect(isClean(results)).toBe(false)
})

test("matching keys are clean", () => {
  const results = compareRunning([{ repo: "eval", key: "k", profile: "dev" }], { eval: { key: "k" } })
  expect(results).toEqual([{ repo: "eval", status: "ok", key: "k", profile: "dev" }])
  expect(isClean(results)).toBe(true)
})

// A bundle legitimately contains builds of repos we did not build here (the
// published copy of something not in the workspace). That is information, not
// an error.
test("a stamp for something this workspace did not build is reported, not failed", () => {
  const results = compareRunning([{ repo: "pcb-viewer", key: "x", profile: "full" }], {})
  expect(results).toEqual([{ repo: "pcb-viewer", status: "unknown", actual: "x" }])
  expect(isClean(results)).toBe(true)
})

test("the report names the fix, not just the fact", () => {
  const lines = formatVerification(
    compareRunning([{ repo: "eval", key: "0123456789abcdef", profile: "dev" }], { eval: { key: "fedcba9876543210" } }),
  )
  expect(lines[0]).toContain("serving 0123456789ab")
  expect(lines[0]).toContain("workspace has fedcba987654")
})

// Learned the hard way: a `//` banner is an ordinary comment, and esbuild
// strips those when it bundles — so core's stamp disappeared the moment eval
// inlined it, and `verify-running` reported core "missing" from a bundle that
// definitely contained it. A legal comment is preserved by every minifier we
// pass through.
test("the banner is a legal comment, so bundlers preserve it", () => {
  expect(bannerFor({ repo: "core", pkg: "@tscircuit/core", profile: "dev", key: "k", version: "v" })).toContain("/*!")
})
