import { expect, test } from "bun:test"
import { formatSummary, lastSteps, summarize } from "../bin/timings.mjs"

// Every performance number in this workspace's docs has been wrong at least
// once — AGENTS.md said 380s for a chain that measures 65.6s, and
// stale-bundles.mjs said 480s for a build that takes 23s — and each wrong
// number changed a design decision. Both were written from logs of a build that
// had an orchestration defect in it, and both outlived the defect. A single run
// is an anecdote; this turns the log into a distribution.

const records = [
  { repo: "core", profile: "dev", result: "built", durationMs: 1000 },
  { repo: "core", profile: "dev", result: "built", durationMs: 3000 },
  { repo: "core", profile: "dev", result: "no-op", durationMs: 50 },
  { repo: "core", profile: "full", result: "built", durationMs: 17000 },
  { repo: "eval", profile: "dev", result: "cache-hit", durationMs: 400 },
]

test("results are grouped by repo, profile and outcome — they are different questions", () => {
  const rows = summarize(records)
  expect(rows.find((r) => r.repo === "core" && r.profile === "dev" && r.result === "built")).toMatchObject({
    count: 2,
    totalMs: 4000,
  })
  // A dev build and a full build of the same repo must never be averaged
  // together: that is exactly how "a chain is 380s" happened.
  expect(rows.find((r) => r.repo === "core" && r.profile === "full")).toMatchObject({ count: 1, medianMs: 17000 })
})

test("cache hits and no-ops are counted separately from real builds", () => {
  const rows = summarize(records)
  expect(rows.map((r) => r.result)).toContain("cache-hit")
  expect(rows.map((r) => r.result)).toContain("no-op")
})

test("rows are ordered by total time, so the expensive thing is on top", () => {
  expect(summarize(records)[0]).toMatchObject({ repo: "core", profile: "full" })
})

test("a repo filter narrows the report", () => {
  expect(summarize(records, { repo: "eval" }).every((r) => r.repo === "eval")).toBe(true)
})

test("step timings come from the most recent run, which is what you just changed", () => {
  const withSteps = [
    { repo: "core", profile: "dev", result: "built", durationMs: 1, steps: [{ command: "old", ms: 1 }] },
    { repo: "core", profile: "dev", result: "built", durationMs: 2, steps: [{ command: "new", ms: 2 }] },
  ]
  expect(lastSteps(withSteps, "core")).toEqual([{ command: "new", ms: 2 }])
  expect(lastSteps(withSteps, "eval")).toEqual([])
})

test("an empty log summarizes to nothing rather than crashing", () => {
  expect(summarize([])).toEqual([])
  expect(formatSummary([]).split("\n").length).toBe(1) // header only
})
