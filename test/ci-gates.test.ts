import { test, expect } from "bun:test"
import { parseWorkflow, isPullRequestTriggered, isGate, ciGates } from "../bin/ci-gates.mjs"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const workflow = (name: string, body: string) => ({ name, body })

const repoWith = (files: { name: string; body: string }[], extra?: (dir: string) => void) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-gates-"))
  const wf = path.join(dir, ".github", "workflows")
  fs.mkdirSync(wf, { recursive: true })
  for (const f of files) fs.writeFileSync(path.join(wf, f.name), f.body)
  extra?.(dir)
  return dir
}

test("a file with no trailing newline does not fuse into the next file", () => {
  // The regression that produced "bun run format:checkbun i": the bash pipeline
  // concatenated files, so a missing final newline joined two commands.
  const dir = repoWith([
    workflow("a.yml", "on:\n  pull_request:\njobs:\n  x:\n    steps:\n      - run: bun run format:check"), // no \n
    workflow("b.yml", "on:\n  pull_request:\njobs:\n  y:\n    steps:\n      - run: bunx tsc --noEmit\n"),
  ])
  expect(ciGates(dir)).toEqual(["bun run format:check", "bunx tsc --noEmit"])
})

test("workflow order is preserved, so build precedes smoke-test:dist", () => {
  // Alphabetical sorting kept these in the right order by luck; a rename would
  // have silently reversed them and smoke-tested a stale dist.
  const dir = repoWith([
    workflow(
      "smoke.yml",
      "on:\n  pull_request:\njobs:\n  s:\n    steps:\n      - run: bun run build\n      - run: bun run smoke-test:dist\n",
    ),
  ])
  expect(ciGates(dir)).toEqual(["bun run build", "bun run smoke-test:dist"])
})

test("only pull_request-triggered workflows count", () => {
  const dir = repoWith([
    workflow("release.yml", "on:\n  push:\n    branches: [main]\njobs:\n  r:\n    steps:\n      - run: bun run build\n"),
    workflow("test.yml", "on:\n  pull_request:\njobs:\n  t:\n    steps:\n      - run: bunx tsc --noEmit\n"),
  ])
  expect(ciGates(dir)).toEqual(["bunx tsc --noEmit"])
})

test("installs, release machinery and mutating steps are not gates", () => {
  expect(isGate("bun install")).toBe(false)
  expect(isGate("bun i")).toBe(false)
  expect(isGate("npm install -g pver")).toBe(false)
  expect(isGate("pver release")).toBe(false)
  expect(isGate("npx @biomejs/biome format . --write")).toBe(false)
  expect(isGate("bun run scripts/generate-test-plan.ts")).toBe(false)
  expect(isGate("bun test ${{ inputs.test_pattern }}")).toBe(false)
  // ...but the non-mutating checks are
  expect(isGate("npx @biomejs/biome format .")).toBe(true)
  expect(isGate("bun run lint:zod")).toBe(true)
  expect(isGate("bunx @tscircuit/dependency-check")).toBe(true)
})

test("a bare `run: |` block header is never mistaken for a command", () => {
  expect(parseWorkflow("      - run: |\n          bun test\n")).toEqual([])
})

test("pull_request detection ignores the word appearing elsewhere", () => {
  expect(isPullRequestTriggered("on:\n  pull_request:\n")).toBe(true)
  expect(isPullRequestTriggered("on:\n  push:\njobs:\n  x:\n    if: github.event.pull_request\n")).toBe(false)
})

test("bun test is appended when the repo has tests, and never duplicated", () => {
  const withTests = repoWith(
    [workflow("t.yml", "on:\n  pull_request:\njobs:\n  t:\n    steps:\n      - run: bunx tsc --noEmit\n")],
    (dir) => {
      fs.mkdirSync(path.join(dir, "tests"))
      fs.writeFileSync(path.join(dir, "tests", "thing.test.ts"), "")
    },
  )
  expect(ciGates(withTests)).toEqual(["bunx tsc --noEmit", "bun test"])

  const alreadyDeclared = repoWith(
    [workflow("t.yml", "on:\n  pull_request:\njobs:\n  t:\n    steps:\n      - run: bun test\n")],
    (dir) => {
      fs.mkdirSync(path.join(dir, "tests"))
      fs.writeFileSync(path.join(dir, "tests", "thing.test.ts"), "")
    },
  )
  expect(alreadyDeclared).toBeTruthy()
  expect(ciGates(alreadyDeclared)).toEqual(["bun test"])
})

test("a repo with no workflows yields no gates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-gates-empty-"))
  expect(ciGates(dir)).toEqual([])
})
