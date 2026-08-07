import { expect, test } from "bun:test"
import {
  hasPlaceholder,
  injectEvalWorker,
} from "../bin/inject-eval-worker.mjs"

// If this substitution silently does nothing, the browser loads the PUBLISHED
// eval instead of the local one: the page runs somebody else's core, every
// local change is invisible, and nothing errors. That is the most expensive
// kind of wrong in this workspace, so the substitution is pinned rather than
// assumed.

const PLACEHOLDER = '"<--INJECT_TSCIRCUIT_EVAL_WEB_WORKER_BLOB_URL-->"'

test("the placeholder is replaced with an inline blob url", () => {
  const out = injectEvalWorker({
    standalone: `const w=${PLACEHOLDER};`,
    worker: "console.log('hi')",
  })

  expect(out).not.toContain(PLACEHOLDER)
  expect(out).toContain("URL.createObjectURL")
  expect(out).toContain(
    Buffer.from("console.log('hi')").toString("base64"),
  )
})

/**
 * The worker is base64-encoded rather than inlined as source because it
 * contains quotes, newlines and backslashes that would otherwise terminate the
 * string literal it is being placed inside -- producing a bundle that parses,
 * runs, and is wrong.
 */
test("worker source that would break a string literal survives", () => {
  const worker = `const s = "quote\\"inside";\nconst t = 'single';\n`

  const out = injectEvalWorker({ standalone: PLACEHOLDER, worker })

  const base64 = out.match(/atob\("([^"]+)"\)/)?.[1]
  expect(base64).toBeDefined()
  expect(Buffer.from(base64!, "base64").toString("utf8")).toBe(worker)
})

test("every occurrence is replaced, not just the first", () => {
  const out = injectEvalWorker({
    standalone: `a=${PLACEHOLDER};b=${PLACEHOLDER};`,
    worker: "x",
  })

  expect(out).not.toContain(PLACEHOLDER)
  expect(out.match(/URL.createObjectURL/g)).toHaveLength(2)
})

test("a bundle with no placeholder is recognised as needing nothing", () => {
  expect(hasPlaceholder("const alreadyFilled = 1")).toBe(false)
  expect(hasPlaceholder(`x=${PLACEHOLDER}`)).toBe(true)
})
