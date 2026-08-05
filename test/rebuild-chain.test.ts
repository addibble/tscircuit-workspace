import { test, expect } from "bun:test"
import { resolveChain } from "../bin/rebuild-chain.mjs"

// A wrong chain is the expensive failure mode in this workspace: rebuild one
// level too few and the change stays frozen inside a prebuilt bundle, with no
// error anywhere — you just debug the old code.

const graph = {
  eval: ["core", "props", "circuit-json"],
  runframe: ["eval", "3d-viewer"],
  cli: ["runframe", "eval"],
  tscircuit: ["cli", "runframe"],
  "3d-viewer": ["circuit-json"],
}

// Everything cloned, every declared edge real.
const all = (over = {}) => ({
  inlines: graph,
  isCloned: () => true,
  declares: () => true,
  pkgName: (r: string) => `@tscircuit/${r}`,
  ...over,
})

test("the chain includes the changed repo and everything downstream", () => {
  const order = resolveChain({ ...all(), from: "core" })
  expect(order).toContain("core")
  expect(new Set(order)).toEqual(new Set(["core", "eval", "runframe", "cli", "tscircuit"]))
})

test("dependencies are always built before their consumers", () => {
  const order = resolveChain({ ...all(), from: "circuit-json" })
  const at = (r: string) => order.indexOf(r)
  expect(at("circuit-json")).toBeLessThan(at("eval"))
  expect(at("eval")).toBeLessThan(at("runframe"))
  expect(at("runframe")).toBeLessThan(at("cli"))
  expect(at("cli")).toBeLessThan(at("tscircuit"))
  // 3d-viewer also consumes circuit-json, and must precede runframe
  expect(at("circuit-json")).toBeLessThan(at("3d-viewer"))
  expect(at("3d-viewer")).toBeLessThan(at("runframe"))
})

test("a leaf change rebuilds only itself", () => {
  expect(resolveChain({ ...all(), from: "tscircuit" })).toEqual(["tscircuit"])
})

test("--to truncates to paths that reach the target", () => {
  const order = resolveChain({ ...all(), from: "circuit-json", to: "cli" })
  expect(order).toContain("cli")
  expect(order).not.toContain("tscircuit")
})

test("--to rejects a target that is not downstream", () => {
  expect(() => resolveChain({ ...all(), from: "cli", to: "core" })).toThrow(/not downstream/)
})

test("an edge the consumer does not actually declare is dropped", () => {
  // This is not hypothetical: the manifest claimed 3d-viewer inlines
  // circuit-json-to-gltf, which it does not depend on at all. Verification
  // dropped it and the real consumers were found instead.
  const declares = (consumer: string, name: string) => !(consumer === "runframe" && name === "@tscircuit/3d-viewer")
  const order = resolveChain({ ...all({ declares }), from: "3d-viewer" })
  expect(order).toEqual(["3d-viewer"])
})

test("repos that are not cloned are skipped", () => {
  const isCloned = (r: string) => r !== "runframe"
  const order = resolveChain({ ...all({ isCloned }), from: "eval" })
  expect(order).toContain("eval")
  expect(order).toContain("cli") // cli inlines eval directly, so it survives
  expect(order).not.toContain("runframe")
})

test("an unknown package name trusts the manifest rather than dropping the edge", () => {
  // Better to rebuild one level too many than to silently skip one.
  const order = resolveChain({ ...all({ pkgName: () => null, declares: () => false }), from: "core" })
  expect(order).toContain("eval")
})

test("a cycle is reported, not hung on", () => {
  const cyclic = { a: ["b"], b: ["a"] }
  expect(() => resolveChain({ ...all({ inlines: cyclic }), from: "a" })).toThrow(/cycle/)
})

test("a repo absent from the graph yields just itself", () => {
  expect(resolveChain({ ...all(), from: "footprinter" })).toEqual(["footprinter"])
})
