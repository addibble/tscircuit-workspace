import { expect, test } from "bun:test"
import { computeActionKey, normalizePackageJson, parseStamp, stampFor } from "../bin/action-key.mjs"

// The old identity was the wall clock: `0.0.4-local.20260805T094955`. It was
// right about the hazard it existed for (a local build must never wear a
// version npm can also mint) and wrong about everything else — two builds of
// identical source got different identities, so nothing could be reused and the
// yalc store grew one directory per publish (80 versions of core, 3.8GB).

test("the same inputs produce the same key", () => {
  const parts = {
    repo: "core",
    profile: "dev",
    packageJson: "{}",
    files: [["lib/a.ts", "aaa"]],
    deps: { "circuit-json": "yalc:sig1" },
    toolchain: { bun: "1.2.0" },
    steps: ["tsup-node"],
  }
  expect(computeActionKey(parts)).toBe(computeActionKey({ ...parts }))
})

test("file order does not matter, file content does", () => {
  const base = { repo: "core", profile: "dev", packageJson: "{}" }
  const a = computeActionKey({ ...base, files: [["a.ts", "1"], ["b.ts", "2"]] })
  const b = computeActionKey({ ...base, files: [["b.ts", "2"], ["a.ts", "1"]] })
  const c = computeActionKey({ ...base, files: [["a.ts", "1"], ["b.ts", "CHANGED"]] })
  expect(a).toBe(b)
  expect(a).not.toBe(c)
})

// A dev artifact has no declarations. If it could satisfy a request for a full
// one, an editor (or a release) would silently get a package with no types.
test("the profile is part of the identity", () => {
  const parts = { repo: "core", packageJson: "{}", files: [] }
  expect(computeActionKey({ ...parts, profile: "dev" })).not.toBe(computeActionKey({ ...parts, profile: "full" }))
})

test("the toolchain and the commands are part of the identity", () => {
  const parts = { repo: "core", profile: "full", packageJson: "{}", files: [] }
  expect(computeActionKey({ ...parts, toolchain: { bun: "1.2.0" } })).not.toBe(
    computeActionKey({ ...parts, toolchain: { bun: "1.2.1" } }),
  )
  expect(computeActionKey({ ...parts, steps: ["tsup"] })).not.toBe(computeActionKey({ ...parts, steps: ["vite"] }))
})

// The consumer edge is the dependency's ARTIFACT identity, not its source: a
// source change upstream that produces identical bytes must not cascade.
test("a dependency's artifact identity changes the key", () => {
  const parts = { repo: "eval", profile: "dev", packageJson: "{}", files: [] }
  expect(computeActionKey({ ...parts, deps: { "@tscircuit/core": "yalc:a" } })).not.toBe(
    computeActionKey({ ...parts, deps: { "@tscircuit/core": "yalc:b" } }),
  )
})

// tsc-dev writes the stamp INTO package.json before building, so hashing the
// raw file would be a cycle: the version would depend on itself.
test("the local version stamp is normalized out of the manifest", () => {
  const released = normalizePackageJson(JSON.stringify({ name: "@tscircuit/core", version: "0.0.4" }))
  const stamped = normalizePackageJson(
    JSON.stringify({ name: "@tscircuit/core", version: "0.0.4-local.dev.7f3a91c2b04e" }),
  )
  expect(stamped).toBe(released)
})

// A yalc link rewrites the dependency spec to `file:.yalc/<pkg>`. That says
// nothing the dependency's own artifact identity does not already say, and
// hashing it would make every link/unlink look like a source change.
test("yalc link specifiers are normalized, real dependency changes are not", () => {
  const linked = normalizePackageJson(
    JSON.stringify({ name: "x", version: "1.0.0", dependencies: { "@tscircuit/core": "file:.yalc/@tscircuit/core" } }),
  )
  const npm = normalizePackageJson(
    JSON.stringify({ name: "x", version: "1.0.0", dependencies: { "@tscircuit/core": "^0.0.4" } }),
  )
  const other = normalizePackageJson(
    JSON.stringify({ name: "x", version: "1.0.0", dependencies: { "@tscircuit/core": "link:../core" } }),
  )
  expect(linked).toBe(other)
  expect(linked).not.toBe(npm)
})

test("key order in the manifest does not change the key", () => {
  expect(normalizePackageJson(JSON.stringify({ a: 1, b: 2 }))).toBe(normalizePackageJson(JSON.stringify({ b: 2, a: 1 })))
})

test("yalc's own signature is not part of the manifest identity", () => {
  expect(normalizePackageJson(JSON.stringify({ name: "x", version: "1.0.0", yalcSig: "abc" }))).toBe(
    normalizePackageJson(JSON.stringify({ name: "x", version: "1.0.0" })),
  )
})

test("unparseable JSON degrades to hashing the text rather than throwing", () => {
  expect(normalizePackageJson("{not json")).toBe("{not json")
})

// The stamp keeps the exact shape the clock-based one had, because doctor's
// "unstamped" check, rebuild's link-freshness check and prune-store all match
// on `-local.`.
test("the stamp is still a prerelease npm can never mint", () => {
  const v = stampFor("0.0.4", "dev", "7f3a91c2b04e5566")
  expect(v).toBe("0.0.4-local.dev.7f3a91c2b04e")
  expect(v.includes("-local.")).toBe(true)
})

test("re-stamping an already stamped version does not nest stamps", () => {
  expect(stampFor("0.0.4-local.full.aaaaaaaaaaaa", "dev", "bbbbbbbbbbbbcccc")).toBe("0.0.4-local.dev.bbbbbbbbbbbb")
})

test("a stamp can be read back off an installed package", () => {
  expect(parseStamp("0.0.4-local.dev.7f3a91c2b04e")).toEqual({
    base: "0.0.4",
    profile: "dev",
    key: "7f3a91c2b04e",
  })
  // The old clock-based stamps are still out there in the yalc store.
  expect(parseStamp("0.0.4-local.20260805T094955")?.profile).toBe(null)
  expect(parseStamp("0.0.4")).toBe(null)
})
