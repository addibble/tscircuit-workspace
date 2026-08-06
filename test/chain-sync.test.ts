import { expect, test } from "bun:test"
import { shouldSync } from "../bin/chain-sync.mjs"

// Rebuilding the inlining chain costs minutes, so *when* matters as much as
// whether: too eager and every keystroke starts a six-minute build that the
// next keystroke invalidates; too lazy and the browser keeps serving code that
// no longer exists.

const stale = [{ repo: "eval", builtAt: 1, staleAgainst: [{ repo: "core", builtAt: 2 }] }]

test("nothing stale means no rebuild, however long things have been idle", () => {
  expect(
    shouldSync({ stale: [], newestBuildAt: 0, at: 10_000_000, quietForMs: 45_000 }).sync,
  ).toBe(false)
})

test("a rebuild waits for the watchers to settle", () => {
  const { sync, reason } = shouldSync({
    stale,
    newestBuildAt: 100_000,
    at: 110_000, // 10s since the last build
    quietForMs: 45_000,
  })

  expect(sync).toBe(false)
  expect(reason).toContain("busy")
})

test("once they have settled, the whole burst costs one rebuild", () => {
  expect(
    shouldSync({
      stale,
      newestBuildAt: 100_000,
      at: 150_000, // 50s
      quietForMs: 45_000,
    }).sync,
  ).toBe(true)
})

/**
 * A workspace where nothing has been built yet still needs the first pass --
 * otherwise the daemon waits forever for a quiet period it cannot measure.
 */
test("no build timestamps at all does not block the first sync", () => {
  expect(
    shouldSync({ stale, newestBuildAt: null, at: 1_000, quietForMs: 45_000 }).sync,
  ).toBe(true)
})
