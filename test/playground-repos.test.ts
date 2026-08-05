import { test, expect } from "bun:test"
import { resolveWatchRepos } from "../bin/playground-repos.mjs"

const efforts = {
  "parametric-enclosures": {
    repos: ["circuit-json", "props", "core", "rfc", "skill"],
  },
}
// rfc and skill are docs repos: cloned, but no package.json
const publishesPackage = (r: string) => !["rfc", "skill"].includes(r)

test("an effort supplies the watch set, minus repos with nothing to build", () => {
  const out = resolveWatchRepos({
    playground: { effort: "parametric-enclosures" },
    efforts,
    publishesPackage,
  })
  expect(out.source).toBe("effort")
  expect(out.repos).toEqual(["circuit-json", "props", "core"])
  expect(out.skipped).toEqual(["rfc", "skill"])
})

test("adding a repo to the effort adds it to the watch set — no second list", () => {
  // This is the whole point of binding a playground to an effort.
  const grown = {
    "parametric-enclosures": { repos: [...efforts["parametric-enclosures"].repos, "3d-viewer"] },
  }
  const out = resolveWatchRepos({ playground: { effort: "parametric-enclosures" }, efforts: grown, publishesPackage })
  expect(out.repos).toContain("3d-viewer")
})

test("removing a repo from the effort drops it too", () => {
  const shrunk = { "parametric-enclosures": { repos: ["circuit-json", "core"] } }
  const out = resolveWatchRepos({ playground: { effort: "parametric-enclosures" }, efforts: shrunk, publishesPackage })
  expect(out.repos).not.toContain("props")
})

test("an explicit watch list wins over the effort", () => {
  const out = resolveWatchRepos({
    playground: { effort: "parametric-enclosures", watch: ["core"] },
    efforts,
    publishesPackage,
  })
  expect(out.source).toBe("watch")
  expect(out.repos).toEqual(["core"])
})

test("uncloned repos are never watched, whichever source they come from", () => {
  const isCloned = (r: string) => r !== "props"
  expect(
    resolveWatchRepos({ playground: { effort: "parametric-enclosures" }, efforts, publishesPackage, isCloned }).repos,
  ).toEqual(["circuit-json", "core"])
  expect(resolveWatchRepos({ playground: { watch: ["core", "props"] }, isCloned }).repos).toEqual(["core"])
})

test("with no effort and no list, the playground's own links are used", () => {
  const out = resolveWatchRepos({
    playground: {},
    linkedPackages: () => ["@tscircuit/core", "circuit-json", "some-npm-package"],
    repoForPackage: (p: string) => ({ "@tscircuit/core": "core", "circuit-json": "circuit-json" })[p] ?? null,
  })
  expect(out.source).toBe("links")
  expect(out.repos).toEqual(["core", "circuit-json"]) // the npm-only package has no repo here
})

test("a playground naming an effort that no longer exists reports rather than silently watching nothing", () => {
  const out = resolveWatchRepos({ playground: { effort: "deleted-effort" }, efforts })
  expect(out.missing).toBe(true)
  expect(out.repos).toEqual([])
})
