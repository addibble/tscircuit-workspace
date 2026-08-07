import { expect, test } from "bun:test"
import { bannerFor, compareRunning, extractBuildKeys, runtimeStampFor } from "../bin/provenance.mjs"
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
  expect(results.find((r) => r.repo === "runframe")).toMatchObject({ status: "absent" })
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

// esbuild keeps legal comments; Vite does not. runframe's standalone is a Vite
// bundle, so 3d-viewer and circuit-to-svg -- which are compiled into it -- had
// no stamp at all, and the check called them "missing" from a bundle that
// certainly contained them. An assignment to a global is a side effect on an
// unknown object: no minifier may drop it and no tree-shaker may prove it dead.
test("the runtime stamp is executable, so a comment-stripping bundler keeps it", () => {
  const rec = { repo: "3d-viewer", pkg: "@tscircuit/3d-viewer", profile: "dev", key: "abc", version: "1.0.0" }
  const stamp = runtimeStampFor(rec)
  expect(stamp).toContain("globalThis.__TSC_DEV_BUILD__")
  expect(stamp).not.toContain("/*")
  // and it still reads back, including after a bundler escapes the literal
  expect(extractBuildKeys(stamp)[0]).toMatchObject({ repo: "3d-viewer", key: "abc" })
  expect(extractBuildKeys(JSON.stringify(stamp))[0]).toMatchObject({ repo: "3d-viewer", key: "abc" })
})

// A check that cries wolf stops being believed, and this one had two standing
// false alarms: `cli` is never in the browser bundle at all, and
// circuit-json-to-gltf is external rather than inlined. The bundling graph is
// deliberately a superset, so absence proves nothing. Only a build that IS
// embedded and IS superseded proves anything.
test("a repo that simply isn't embedded is reported, not failed", () => {
  const results = compareRunning([{ repo: "eval", key: "k", profile: "dev" }], {
    eval: { key: "k" },
    cli: { key: "whatever" },
  })
  expect(results.find((r) => r.repo === "cli")).toMatchObject({ status: "absent" })
  expect(isClean(results)).toBe(true)
})

// ...but a bundle containing none of what we built is the "the dev server fell
// back to the CDN copy" case, which is a failure.
test("an artifact with none of the expected builds in it fails", () => {
  expect(isClean(compareRunning([], { eval: { key: "k" }, runframe: { key: "j" } }))).toBe(false)
})
