import { test, expect } from "bun:test"
import { compareEnvironments } from "../bin/env-lock.mjs"

const repo = (over = {}) => ({
  branch: "main",
  sha: "a".repeat(40),
  remote: "origin",
  remoteUrl: "https://github.com/tscircuit/core.git",
  remotes: {},
  dirty: false,
  ...over,
})

test("an identical environment reports nothing", () => {
  const env = { repos: { core: repo() }, links: {} }
  const { problems, warnings } = compareEnvironments(env, env)
  expect(problems).toEqual([])
  expect(warnings).toEqual([])
})

test("a missing repo is a difference, and names the remote to get it from", () => {
  const lock = {
    repos: { core: repo({ remote: "fork", remoteUrl: "https://github.com/addibble/core.git" }) },
  }
  const { problems } = compareEnvironments(lock, { repos: {} })
  expect(problems).toHaveLength(1)
  expect(problems[0]).toContain("not cloned")
  expect(problems[0]).toContain("addibble/core")
})

test("a different commit is a difference and shows the fork URL when relevant", () => {
  const lock = {
    repos: {
      core: repo({ branch: "feat/x", sha: "b".repeat(40), remote: "fork", remoteUrl: "https://github.com/addibble/core.git" }),
    },
  }
  const here = { repos: { core: repo() } }
  const { problems } = compareEnvironments(lock, here)
  expect(problems[0]).toContain("lock wants feat/x")
  expect(problems[0]).toContain("https://github.com/addibble/core.git")
})

test("a dirty tree at the right commit is a warning, not a difference", () => {
  // Otherwise every diff in this workspace is red: yalc rewrites package.json,
  // so ~20 repos are always dirty.
  const lock = { repos: { core: repo() } }
  const here = { repos: { core: repo({ dirty: true }) } }
  const { problems, warnings } = compareEnvironments(lock, here)
  expect(problems).toEqual([])
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain("uncommitted")
})

test("an extra local repo is a warning", () => {
  const { problems, warnings } = compareEnvironments({ repos: {} }, { repos: { extra: repo() } })
  expect(problems).toEqual([])
  expect(warnings[0]).toContain("absent from the lock")
})

test("a missing yalc link is a difference; an extra one is a warning", () => {
  const lock = { repos: {}, links: { core: ["circuit-json", "@tscircuit/props"] } }
  const here = { repos: {}, links: { core: ["circuit-json", "footprinter"] } }
  const { problems, warnings } = compareEnvironments(lock, here)
  expect(problems).toHaveLength(1)
  expect(problems[0]).toContain("@tscircuit/props")
  expect(warnings.some((w) => w.includes("footprinter"))).toBe(true)
})

test("comparison tolerates a lock with no links or repos", () => {
  expect(() => compareEnvironments({}, {})).not.toThrow()
  expect(compareEnvironments({}, {}).problems).toEqual([])
})
