import { test, expect } from "bun:test"
import { merge } from "../bin/workspace-config.mjs"

// The layering rule: objects merge key by key so a local layer can add one
// group without restating the rest; arrays and scalars replace wholesale,
// because a partial array merge has no defensible meaning.

test("local keys are added to the shared object", () => {
  const out = merge({ groups: { runtime: { repos: ["core"] } } }, { groups: { mine: { repos: ["props"] } } })
  expect(Object.keys(out.groups).sort()).toEqual(["mine", "runtime"])
  expect(out.groups.runtime.repos).toEqual(["core"])
})

test("local wins on a conflicting scalar", () => {
  expect(merge({ defaultForkEffort: "a" }, { defaultForkEffort: "b" }).defaultForkEffort).toBe("b")
})

test("arrays replace rather than concatenate", () => {
  // A rebuild chain must be exactly what the layer says. Appending would make
  // an override strictly additive, so an edge could never be REMOVED locally.
  const out = merge({ bundling: { inlines: { eval: ["core", "props"] } } }, { bundling: { inlines: { eval: ["core"] } } })
  expect(out.bundling.inlines.eval).toEqual(["core"])
})

test("sibling keys survive a nested override", () => {
  const shared = { bundling: { inlines: { eval: ["core"], cli: ["runframe"] } } }
  const local = { bundling: { inlines: { eval: ["core", "circuit-json"] } } }
  const out = merge(shared, local)
  expect(out.bundling.inlines.eval).toEqual(["core", "circuit-json"])
  expect(out.bundling.inlines.cli).toEqual(["runframe"])
})

test("merging does not mutate either input", () => {
  const shared = { groups: { runtime: { repos: ["core"] } } }
  const local = { groups: { runtime: { repos: ["eval"] } } }
  merge(shared, local)
  expect(shared.groups.runtime.repos).toEqual(["core"])
  expect(local.groups.runtime.repos).toEqual(["eval"])
})
