import { test, expect } from "bun:test"
import { shouldIgnore, IGNORED_DIRS, SELF_WRITTEN } from "../bin/watch-run.mjs"

// A watcher that reacts to its own build's output does not merely waste time —
// it rebuilds forever. Every case below was observed within seconds of starting
// the first real watcher.

test("build output and vendored trees are ignored", () => {
  expect(shouldIgnore("dist/index.js")).toBe(true)
  expect(shouldIgnore("node_modules/foo/index.js")).toBe(true)
  expect(shouldIgnore(".git/index")).toBe(true)
  expect(shouldIgnore(".yalc/@tscircuit/core/package.json")).toBe(true)
})

test("the build's own scratch files are ignored", () => {
  // tsup writes this beside tsup.config.ts on every run
  expect(shouldIgnore("tsup.config.bundled_y3ylher67ar.mjs")).toBe(true)
  // `push` stamps package.json and restores it
  expect(shouldIgnore("package.json")).toBe(true)
  // `yalc push` rewrites the lock in the source repo
  expect(shouldIgnore("yalc.lock")).toBe(true)
  expect(shouldIgnore("bun.lock")).toBe(true)
  expect(shouldIgnore("lib/thing.tsbuildinfo")).toBe(true)
})

test("real source edits are NOT ignored", () => {
  expect(shouldIgnore("lib/components/primitive-components/EnclosureFdmBox.ts")).toBe(false)
  expect(shouldIgnore("index.ts")).toBe(false)
  expect(shouldIgnore("tests/foo.test.tsx")).toBe(false)
  expect(shouldIgnore("tsup.config.ts")).toBe(false) // the real config, not the bundled temp
})

test("editor noise is ignored", () => {
  expect(shouldIgnore(".DS_Store")).toBe(true)
  expect(shouldIgnore("lib/thing.ts~")).toBe(true)
  expect(shouldIgnore("4913")).toBe(true) // vim's probe file
  expect(shouldIgnore("lib/x.tmp")).toBe(true)
})

test("an empty or missing filename is ignored rather than throwing", () => {
  expect(shouldIgnore("")).toBe(true)
  expect(shouldIgnore(undefined)).toBe(true)
})

test("the ignore sets are non-empty, so a bad refactor cannot silently disable them", () => {
  expect(IGNORED_DIRS.size).toBeGreaterThan(3)
  expect(SELF_WRITTEN.length).toBeGreaterThan(3)
})
