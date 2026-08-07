import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { decideBuild, digestDir, entriesToPrune, entryPaths, withLock } from "../bin/build-cache.mjs"

// What a cache buys here is NOT a faster first build — that is what the dev
// profile is for. It is the cases where the work has already been done:
// switching a branch back, restarting a watcher, retrying after a downstream
// failure.

test("dist already carrying this action key is a no-op", () => {
  expect(
    decideBuild({ sidecar: { key: "k", profile: "dev" }, key: "k", profile: "dev", distExists: true }),
  ).toMatchObject({ action: "noop" })
})

test("changed inputs rebuild even when the cache has an older entry", () => {
  expect(
    decideBuild({ sidecar: { key: "old", profile: "dev" }, key: "new", profile: "dev", distExists: true }),
  ).toMatchObject({ action: "build", reason: "inputs changed" })
})

test("a cached entry for these exact inputs is restored rather than rebuilt", () => {
  expect(
    decideBuild({
      sidecar: { key: "old", profile: "dev" },
      key: "new",
      profile: "dev",
      distExists: true,
      hasCacheEntry: true,
    }),
  ).toMatchObject({ action: "restore" })
})

// A JS-only artifact must never satisfy a request for a full one: the full one
// carries declarations, and an editor resolving types through the yalc snapshot
// would silently get none.
test("a profile change is always a rebuild, never a reuse", () => {
  expect(
    decideBuild({ sidecar: { key: "k", profile: "dev" }, key: "k", profile: "full", distExists: true }),
  ).toMatchObject({ action: "build" })
})

test("dist with no provenance is rebuilt — we cannot say what it is", () => {
  expect(decideBuild({ sidecar: null, key: "k", profile: "dev", distExists: true })).toMatchObject({
    action: "build",
    reason: "no provenance for existing dist",
  })
})

test("--force always rebuilds, which is what makes `cache verify` meaningful", () => {
  expect(
    decideBuild({
      sidecar: { key: "k", profile: "dev" },
      key: "k",
      profile: "dev",
      distExists: true,
      hasCacheEntry: true,
      force: true,
    }),
  ).toMatchObject({ action: "build", reason: "forced" })
})

test("the digest is over content and path, and ignores the provenance sidecar", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "digest-"))
  fs.writeFileSync(path.join(dir, "a.js"), "hello")
  const before = digestDir(dir)
  // The sidecar records the digest, so including it would be a cycle.
  fs.writeFileSync(path.join(dir, ".tsc-dev-build.json"), '{"key":"whatever"}')
  expect(digestDir(dir)).toBe(before)
  fs.writeFileSync(path.join(dir, "a.js"), "hello!")
  expect(digestDir(dir)).not.toBe(before)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("entries are addressed by package, profile and key", () => {
  const { tar, manifest } = entryPaths("/cache", "@tscircuit/core", "dev", "abc")
  expect(tar).toBe("/cache/_tscircuit_core/dev/abc.tar")
  expect(manifest).toBe("/cache/_tscircuit_core/dev/abc.json")
})

test("pruning keeps the newest N per target, not N overall", () => {
  const entries = [
    { pkg: "core", profile: "dev", key: "a", mtimeMs: 1 },
    { pkg: "core", profile: "dev", key: "b", mtimeMs: 2 },
    { pkg: "core", profile: "dev", key: "c", mtimeMs: 3 },
    { pkg: "core", profile: "full", key: "d", mtimeMs: 1 },
  ]
  const doomed = entriesToPrune(entries, 2).map((e) => e.key)
  expect(doomed).toEqual(["a"])
})

// Two watchers can race on one repo (a save landing while a chain sync runs).
test("a lock is exclusive, and is released even when the body throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-"))
  const lock = path.join(dir, "x.lock")
  expect(() =>
    withLock(lock, () => {
      expect(fs.existsSync(lock)).toBe(true)
      throw new Error("build failed")
    }),
  ).toThrow("build failed")
  expect(fs.existsSync(lock)).toBe(false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("a lock left behind by a dead process is broken rather than obeyed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-"))
  const lock = path.join(dir, "x.lock")
  fs.mkdirSync(lock)
  fs.writeFileSync(path.join(lock, "pid"), "999999") // no such process
  expect(withLock(lock, () => "ran")).toBe("ran")
  fs.rmSync(dir, { recursive: true, force: true })
})
