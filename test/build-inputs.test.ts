import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  DEFAULT_EXCLUDE,
  inputRulesFor,
  isBuildInput,
  listBuildInputs,
  matchesAny,
} from "../bin/build-inputs.mjs"

// This list is load-bearing in two directions at once, which is why it exists
// once rather than twice:
//
//   too broad  — the watcher rebuilds on files the build never reads (measured:
//                core rebuilding at ~13s a time from `tests/**` edits, every
//                one producing a byte-identical dist), and the action key
//                changes for builds that cannot differ;
//   too narrow — a real source file stops invalidating the build, and the
//                failure is SILENT: a stale bundle that looks fresh.
//
// So the bias is stated as a rule below: when in doubt, it is an input.

test("source files are inputs", () => {
  for (const f of ["lib/index.ts", "src/deep/nested/file.tsx", "index.ts", "webworker/entrypoint.ts"])
    expect(isBuildInput(f)).toBe(true)
})

test("build configuration is an input — a tsup/vite config change changes the output", () => {
  for (const f of ["tsup.config.ts", "vite.config.ts", "tailwind.config.js", "package.json"])
    expect(isBuildInput(f)).toBe(true)
})

test("tests, snapshots and docs are not inputs", () => {
  for (const f of [
    "tests/pcb/route.test.tsx",
    "tests/__snapshots__/route.snap",
    "lib/utils/thing.test.ts",
    "docs/architecture.md",
    "README.md",
    "examples/blinky.tsx",
    "browser-tests/browsertest.html",
  ])
    expect(isBuildInput(f)).toBe(false)
})

test("build output and dependencies are not inputs", () => {
  for (const f of ["dist/index.js", "node_modules/react/index.js", ".yalc/@tscircuit/core/package.json"])
    expect(isBuildInput(f)).toBe(false)
})

// Each of these is a file the build or tsc-dev itself writes into the source
// tree. Watching them makes a build retrigger itself forever — all three fired
// within seconds of starting the first watcher.
test("files the build writes back into the tree are not inputs", () => {
  for (const f of [
    "yalc.lock",
    "tsup.config.bundled_abc123.mjs",
    "tsup.tsc-dev-nodts.0.config.ts",
    "lib/hooks/styles.generated.ts",
    "tsconfig.tsbuildinfo",
  ])
    expect(isBuildInput(f)).toBe(false)
})

test("package.json stays an input even though tsc-dev rewrites it while stamping", () => {
  // The rewrite is normalized out of the action key instead (action-key.mjs),
  // so a genuine dependency edit still invalidates the build. The watcher
  // ignores it separately, via SELF_WRITTEN.
  expect(isBuildInput("package.json")).toBe(true)
})

test("a directory pattern also matches the directory itself, so a walk can prune", () => {
  expect(matchesAny("tests", DEFAULT_EXCLUDE)).toBe(true)
  expect(matchesAny("node_modules", DEFAULT_EXCLUDE)).toBe(true)
  expect(matchesAny("lib", DEFAULT_EXCLUDE)).toBe(false)
})

test("**/ spans any number of directories, including none", () => {
  expect(matchesAny("a.test.ts", ["**/*.test.*"])).toBe(true)
  expect(matchesAny("lib/deep/a.test.ts", ["**/*.test.*"])).toBe(true)
  expect(matchesAny("lib/a.ts", ["**/*.test.*"])).toBe(false)
})

test("a repo can add its own exclusions without losing the defaults", () => {
  const rules = inputRulesFor({ build: { inputs: { repos: { core: { exclude: ["scripts/**"] } } } } }, "core")
  expect(isBuildInput("scripts/dump.ts", rules)).toBe(false)
  expect(isBuildInput("tests/x.test.ts", rules)).toBe(false) // defaults still apply
  expect(isBuildInput("lib/x.ts", rules)).toBe(true)
})

test("listBuildInputs walks a tree and prunes what it cannot need", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inputs-"))
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true })
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true })
  fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true })
  fs.writeFileSync(path.join(dir, "lib", "a.ts"), "a")
  fs.writeFileSync(path.join(dir, "package.json"), "{}")
  fs.writeFileSync(path.join(dir, "tests", "a.test.ts"), "t")
  fs.writeFileSync(path.join(dir, "node_modules", "x", "index.js"), "x")

  expect(listBuildInputs(dir)).toEqual(["lib/a.ts", "package.json"])
  fs.rmSync(dir, { recursive: true, force: true })
})
