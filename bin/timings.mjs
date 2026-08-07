#!/usr/bin/env node
//
// timings.mjs — record and summarize how long builds actually take.
//
// Every number in this workspace's docs has been wrong at least once, and each
// time it changed a design decision: AGENTS.md said a full chain was 380s and
// runframe 314s, stale-bundles.mjs said 480s, and the measured figures are 65.6s
// and ~23s. Both wrong numbers were written from logs of a build that had an
// orchestration defect in it, and both outlived the defect.
//
// The fix is not to write more careful prose. It is to keep a record: every
// build appends one JSON line to .run/timings.jsonl, and `./tsc-dev timings`
// turns them into a distribution rather than an anecdote. A single run on an
// idle machine is not a measurement.
import fs from "node:fs"
import path from "node:path"
import { isMain } from "./is-main.mjs"

export const timingsFile = (root) => path.join(root, ".run", "timings.jsonl")

export const record = (root, entry) => {
  const file = timingsFile(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
}

export const readRecords = (file) => {
  let text
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return []
  }
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

const quantile = (sorted, q) => {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
  return sorted[idx]
}

/**
 * Per (repo, profile, result): how many, and the median / p90 / total seconds.
 * Pure: the interesting part is the aggregation, not the file reading.
 */
export const summarize = (records, { repo = null } = {}) => {
  const groups = new Map()
  for (const r of records) {
    if (repo && r.repo !== repo) continue
    const key = `${r.repo}\u0000${r.profile}\u0000${r.result}`
    groups.set(key, [...(groups.get(key) ?? []), r.durationMs ?? 0])
  }
  return [...groups]
    .map(([key, durations]) => {
      const [repoName, profile, result] = key.split("\u0000")
      const sorted = [...durations].sort((a, b) => a - b)
      return {
        repo: repoName,
        profile,
        result,
        count: sorted.length,
        medianMs: quantile(sorted, 0.5),
        p90Ms: quantile(sorted, 0.9),
        totalMs: sorted.reduce((a, b) => a + b, 0),
      }
    })
    .sort((a, b) => b.totalMs - a.totalMs)
}

/** Where the time went inside one build, newest run per repo. */
export const lastSteps = (records, repo) => {
  const last = [...records].reverse().find((r) => r.repo === repo && r.steps?.length)
  return last?.steps ?? []
}

export const formatSummary = (rows) => {
  const s = (ms) => (ms == null ? "-" : `${(ms / 1000).toFixed(1)}s`)
  const lines = [
    `${"repo".padEnd(22)}${"profile".padEnd(8)}${"result".padEnd(11)}${"n".padStart(4)}  ${"median".padStart(8)}${"p90".padStart(9)}${"total".padStart(9)}`,
  ]
  for (const r of rows)
    lines.push(
      `${r.repo.padEnd(22)}${r.profile.padEnd(8)}${r.result.padEnd(11)}${String(r.count).padStart(4)}  ${s(r.medianMs).padStart(8)}${s(r.p90Ms).padStart(9)}${s(r.totalMs).padStart(9)}`,
    )
  return lines.join("\n")
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const root = args[0] ?? process.cwd()
  const repoIdx = args.indexOf("--repo")
  const repo = repoIdx === -1 ? null : args[repoIdx + 1]
  const records = readRecords(timingsFile(root))
  if (records.length === 0) {
    console.log("no build timings recorded yet (.run/timings.jsonl)")
    process.exit(0)
  }
  console.log(formatSummary(summarize(records, { repo })))
  if (repo) {
    const steps = lastSteps(records, repo)
    if (steps.length) {
      console.log(`\nlast full build of ${repo}, step by step:`)
      for (const st of steps) console.log(`  ${((st.ms ?? 0) / 1000).toFixed(1).padStart(6)}s  ${st.command}`)
    }
  }
}
