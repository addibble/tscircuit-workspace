import { expect, test } from "bun:test"
import {
  findSourceBranchBase,
  normalizeMergeStack,
  renderStackBlock,
  upsertManagedBlock,
} from "../bin/pr-stack.mjs"

const config = {
  defaultMergeStack: "enclosure",
  mergeStacks: {
    enclosure: {
      layers: {
        props: {
          repo: "props",
          sourceBranch: "feat/props",
          upstreamBranch: "feat/enclosure/props",
        },
        solver: {
          repo: "create-fdm-enclosure",
          sourceBranch: "feat/solver",
          dependsOn: ["props"],
        },
        core1: {
          repo: "core",
          sourceBranch: "feat/core-1",
          upstreamBranch: "feat/enclosure/core-1",
          dependsOn: ["props", "solver"],
        },
        viewer: {
          repo: "3d-viewer",
          sourceBranch: "feat/viewer",
          dependsOn: ["core1"],
        },
        core2: {
          repo: "core",
          sourceBranch: "feat/core-2",
          upstreamBranch: "feat/enclosure/core-2",
          baseLayer: "core1",
          dependsOn: ["viewer"],
        },
      },
    },
  },
}

test("plans same-repo bases and interleaved cross-repo dependencies", () => {
  const stack = normalizeMergeStack(config)
  expect(stack.layers.map((layer) => layer.id)).toEqual([
    "props",
    "solver",
    "core1",
    "viewer",
    "core2",
  ])
  const core2 = stack.layers.find((layer) => layer.id === "core2")!
  expect(core2.baseBranch).toBe("feat/enclosure/core-1")
  expect(core2.sourceBaseBranch).toBe("feat/core-1")
  expect(core2.dependencies).toEqual(["core1", "viewer"])
})

test("cross-repo layers cannot be used as Git bases", () => {
  const invalid = structuredClone(config)
  invalid.mergeStacks.enclosure.layers.viewer.baseLayer = "core1"
  expect(() => normalizeMergeStack(invalid)).toThrow(
    "Git bases must be in the same repo",
  )
})

test("cycles are rejected", () => {
  const invalid = structuredClone(config)
  invalid.mergeStacks.enclosure.layers.props.dependsOn = ["core2"]
  expect(() => normalizeMergeStack(invalid)).toThrow("dependency cycle")
})

test("finds the source branch base so sync-forks cannot flatten a stack", () => {
  expect(findSourceBranchBase(config, "core", "feat/core-2")).toEqual({
    stack: "enclosure",
    layer: "core2",
    base: "feat/core-1",
  })
  expect(findSourceBranchBase(config, "props", "feat/props")?.base).toBeNull()
})

test("managed PR metadata is replaceable without touching human prose", () => {
  const first = upsertManagedBlock("Human explanation", "old stack block")
  const next = upsertManagedBlock(first, "new stack block")
  expect(next).toContain("Human explanation")
  expect(next).toContain("new stack block")
  expect(next).not.toContain("old stack block")
  expect(next.match(/tsc-dev-pr-stack:start/g)).toHaveLength(1)
})

test("renders dependency status and links", () => {
  const stack = normalizeMergeStack(config)
  const layer = stack.layers.find((item) => item.id === "core2")!
  const block = renderStackBlock({
    stackName: stack.name,
    layer,
    dependencies: [
      { id: "core1", merged: true, state: "merged", url: "https://example/pr/1" },
      { id: "viewer", merged: false, state: "open", url: "https://example/pr/2" },
    ],
  })
  expect(block).toContain("- [x] [core1](https://example/pr/1) — merged")
  expect(block).toContain("- [ ] [viewer](https://example/pr/2) — open")
})
