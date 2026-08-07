import { expect, test } from "bun:test"
import { expandBuild, noDtsStep, planBuild, skipStepsFor, wrapperSource } from "../bin/build-profile.mjs"

// Measured on this workspace: a full core → eval → runframe chain is 65.6s, of
// which declaration emit is 27.4s (61%) and JavaScript emit is under 0.5s.
// core's JS takes 50ms and its 9.2MB index.d.ts takes 10.2s. Neither the
// browser nor `tsci build` reads any of it. So the dev profile's whole job is
// to not do that work — without inventing a second build definition per repo,
// which is what would drift.

test("a build script that chains other scripts is flattened in order", () => {
  const scripts = {
    build: "bun run build:lib && bun run build:webworker",
    "build:lib": "tsup-node --config tsup-lib.config.ts",
    "build:webworker": "tsup --config tsup-webworker.config.ts",
  }
  expect(expandBuild(scripts).map((s) => s.script)).toEqual(["build:lib", "build:webworker"])
})

test("a self-referential script chain terminates instead of recursing forever", () => {
  expect(expandBuild({ build: "bun run build" })).toEqual([])
})

test("a --dts flag in the command is simply dropped", () => {
  const { command, changed } = noDtsStep("tsup-node ./src/index.ts --format esm --dts --sourcemap")
  expect(command).toBe("tsup-node ./src/index.ts --format esm --sourcemap")
  expect(changed).toBe(true)
})

// `--dts src/types.ts` is an ENTRY override, not a boolean: dropping only the
// flag would leave a stray path as a positional entry and build the wrong thing.
test("--dts with an entry argument takes its argument with it", () => {
  expect(noDtsStep("tsup lib/index.ts --dts lib/types.ts --format esm").command).toBe(
    "tsup lib/index.ts --format esm",
  )
})

// `tsup-node --dts false` still starts (and fails) a DTS build — measured. So a
// config-driven build has to be wrapped, not flagged.
test("a config-driven tsup build is redirected to a generated wrapper config", () => {
  const step = noDtsStep("tsup --config tsup-webworker.config.ts", { wrapperPath: "W.ts" })
  expect(step.wrapsConfig).toBe("tsup-webworker.config.ts")
  expect(step.command).toBe("tsup --config W.ts")
})

test("a tsup build with no --config still gets one, pointing at the wrapper", () => {
  const step = noDtsStep("tsup-node", { wrapperPath: "W.ts" })
  expect(step.wrapsConfig).toBe("tsup.config.ts")
  expect(step.command).toBe("tsup-node --config W.ts")
})

test("non-tsup steps are left exactly alone", () => {
  for (const cmd of [
    "NODE_OPTIONS=--max-old-space-size=8192 STANDALONE=1 vite build",
    "bun run ./scripts/build-worker-blob-url.ts",
  ])
    expect(noDtsStep(cmd)).toEqual({ command: cmd, changed: false })
})

test("the generated wrapper reuses the repo's own config and only turns dts off", () => {
  const src = wrapperSource("tsup-webworker.config.ts")
  expect(src).toContain('import base from "./tsup-webworker.config"')
  expect(src).toContain("dts: false")
  // It must handle every shape defineConfig accepts, or a repo that exports a
  // function (or an array) silently builds nothing.
  expect(src).toContain("typeof base === \"function\"")
  expect(src).toContain("Array.isArray(resolved)")
})

test("the full profile is exactly the repo's own build, unmodified", () => {
  const scripts = { build: "bun run b1 && bun run b2", b1: "tsup-node --dts", b2: "vite build" }
  const { steps, skipped } = planBuild({ scripts, profile: "full" })
  expect(steps.map((s) => s.command)).toEqual(["tsup-node --dts", "vite build"])
  expect(skipped).toEqual([])
})

// runframe's second Vite bundle is 8.4s that the local dev server never serves.
// Skipping it is a config decision (workspace.json), and it is RECORDED, because
// a profile that quietly produces fewer outputs than the release build is
// exactly the kind of difference that costs an afternoon.
test("the dev profile can skip whole steps the inner loop does not consume", () => {
  const scripts = {
    build: "bun run build:standalone && bun run build:standalone-preview",
    "build:standalone": "STANDALONE=1 vite build",
    "build:standalone-preview": "STANDALONE=preview vite build",
  }
  const { steps, skipped } = planBuild({ scripts, profile: "dev", skipSteps: ["build:standalone-preview"] })
  expect(steps.map((s) => s.script)).toEqual(["build:standalone"])
  expect(skipped).toEqual(["build:standalone-preview"])
})

test("each wrapped config gets its own wrapper file, so a multi-step build cannot collide", () => {
  const scripts = {
    build: "bun run a && bun run b",
    a: "tsup --config tsup-webworker.config.ts",
    b: "tsup-node --config tsup-lib.config.ts",
  }
  const { steps } = planBuild({ scripts, profile: "dev" })
  expect(new Set(steps.map((s) => s.wrapperPath)).size).toBe(2)
})

test("skip lists come from config, keyed by repo and profile", () => {
  const config = { build: { profiles: { dev: { skipSteps: { runframe: ["build:standalone-preview"] } } } } }
  expect(skipStepsFor(config, "runframe", "dev")).toEqual(["build:standalone-preview"])
  expect(skipStepsFor(config, "runframe", "full")).toEqual([])
  expect(skipStepsFor(config, "core", "dev")).toEqual([])
})
