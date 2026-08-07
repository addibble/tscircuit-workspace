import { expect, test } from "bun:test"
import { compareVersions, minimumVersionOf, planLinks } from "../bin/link-plan.mjs"

const base = {
  repo: "runframe",
  localPackages: {
    "@tscircuit/core": { repo: "core", version: "0.0.1609" },
    "circuit-to-svg": { repo: "circuit-to-svg", version: "0.0.358" },
    "@tscircuit/runframe": { repo: "runframe", version: "0.0.2362" },
  },
  inStore: () => true,
  installed: () => null,
}

test("a workspace package that is published locally gets linked", () => {
  const plan = planLinks({ ...base, deps: { "@tscircuit/core": "^0.0.1609" } })
  expect(plan).toEqual([{ pkg: "@tscircuit/core", action: "add", reason: "not installed" }])
})

test("a dependency that is not a workspace package is not mentioned at all", () => {
  expect(planLinks({ ...base, deps: { react: "^18.0.0" } })).toEqual([])
})

test("a repo never links itself", () => {
  expect(planLinks({ ...base, deps: { "@tscircuit/runframe": "^0.0.2362" } })).toEqual([])
})

// `yalc add` against a package that was never published spends seconds to print
// "Could not find package in store, skipping" — 17 of eval's 18 local deps were
// in this state, which was most of a three-minute rebuild.
test("a package that was never published locally is skipped, not attempted", () => {
  const plan = planLinks({ ...base, inStore: () => false, deps: { "@tscircuit/core": "^0.0.1609" } })
  expect(plan[0]).toMatchObject({ action: "skip", reason: "never published locally" })
})

test("a link that is already current is left alone", () => {
  const plan = planLinks({
    ...base,
    installed: () => "0.0.1609-local.dev.7f3a91c2b04e",
    deps: { "@tscircuit/core": "^0.0.1609" },
  })
  expect(plan[0]).toMatchObject({ action: "skip", reason: "link is current" })
})

test("an npm copy, or an older stamp, is re-linked", () => {
  for (const have of ["0.0.1608", "0.0.1609-local.20260805T094955".replace("1609", "1608")]) {
    const plan = planLinks({ ...base, installed: () => have, deps: { "@tscircuit/core": "^0.0.1609" } })
    expect(plan[0].action).toBe("add")
  }
})

// The case that produced this file. runframe declares circuit-to-svg ^0.0.393
// and imports a symbol added in 0.0.395; the local checkout is 0.0.358. Linking
// it replaced a working npm copy with an older one, and the build failed on a
// missing export with nothing in sight to suggest why.
test("a local checkout older than what the consumer declares is refused, not linked", () => {
  const plan = planLinks({ ...base, deps: { "circuit-to-svg": "^0.0.393" } })
  expect(plan[0]).toMatchObject({ action: "skip", downgrade: true })
  expect(plan[0].reason).toContain("would downgrade runframe")
  expect(plan[0].reason).toContain("0.0.358")
})

test("a local checkout at or above the declared minimum is linked", () => {
  for (const spec of ["^0.0.358", "~0.0.300", ">=0.0.100", "0.0.358"]) {
    const plan = planLinks({ ...base, deps: { "circuit-to-svg": spec } })
    expect(plan[0].action).toBe("add")
  }
})

// Anything it cannot answer confidently, it declines to answer — a guard that
// guesses is worse than no guard, because it would block legitimate links.
test("specs with no expressible minimum do not block a link", () => {
  for (const spec of ["*", "latest", "workspace:*", "file:.yalc/circuit-to-svg", "^0.0.1 || ^1.0.0"]) {
    expect(minimumVersionOf(spec)).toBe(null)
    expect(planLinks({ ...base, deps: { "circuit-to-svg": spec } })[0].action).toBe("add")
  }
})

test("versions compare numerically, not lexically", () => {
  expect(compareVersions("0.0.358", "0.0.393")).toBe(-1)
  expect(compareVersions("0.0.1609", "0.0.999")).toBe(1) // lexically the other way round
  expect(compareVersions("0.0.396", "0.0.396")).toBe(0)
  expect(compareVersions("0.0.396-local.dev.abc", "0.0.396")).toBe(0)
})

// A build killed with -9 leaves the stamp in package.json (the restore runs on
// EXIT/INT/TERM, which -9 does not deliver). Two repos here had been carrying
// one for two days without anything noticing. The comparison must see through
// it, or every rebuild re-adds a link that is already current.
test("a leftover stamp in the producing repo does not make its link look stale", () => {
  const plan = planLinks({
    ...base,
    localPackages: { "@tscircuit/core": { repo: "core", version: "0.0.1609-local.20260806T225801" } },
    installed: () => "0.0.1609-local.dev.2d894fd993b0",
    deps: { "@tscircuit/core": "^0.0.1609" },
  })
  expect(plan[0]).toMatchObject({ action: "skip", reason: "link is current" })
})

test("a leftover stamp does not make a downgrade check misfire either", () => {
  const plan = planLinks({
    ...base,
    localPackages: { "circuit-to-svg": { repo: "circuit-to-svg", version: "0.0.396-local.dev.abc" } },
    deps: { "circuit-to-svg": "^0.0.393" },
  })
  expect(plan[0].action).toBe("add")
})
