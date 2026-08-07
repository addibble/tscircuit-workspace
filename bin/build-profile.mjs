#!/usr/bin/env node
//
// build-profile.mjs — what "build this repo" means for a given profile.
//
// Measured on this workspace (2026-08-06), a full core → eval → runframe chain
// is 65.6s, of which **27.4s is declaration emit** and ~0.5s is JavaScript emit.
// core emits its JS in 50ms and its 9.2MB index.d.ts in 10.2s — a factor of 200
// — and neither the browser nor `tsci build` reads a single byte of it. So the
// biggest available win in the inner loop is not caching that work, it is not
// doing it.
//
// There is no generic flag to lean on: `tsup-node --dts false` still starts a
// DTS build (measured), and the repos split three ways — flags in the script
// (`tsup-node x.ts --format esm --dts`), a config file (`tsup-node` reading
// tsup.config.ts), and non-tsup steps (vite, bun scripts). So the plan is
// DERIVED from each repo's own package.json scripts rather than transcribed
// into a table here, which is what stops it drifting when a repo changes its
// build:
//
//   * a `--dts` flag in the command is dropped;
//   * a tsup config file is wrapped by a generated config that spreads it and
//     overrides `dts: false` (so entries, externals, esbuild options and
//     `clean` all keep coming from the repo);
//   * anything else runs unchanged.
//
// Repos may additionally declare steps the dev loop does not consume at all
// (workspace.json `build.profiles.dev.skipSteps`) — runframe's second Vite
// bundle, `standalone-preview`, is 8.4s that the local dev server never serves.
// A skipped step is recorded in the build's provenance, because a profile that
// silently produces fewer outputs than the release build is exactly the kind of
// difference that costs an afternoon.
import { isMain } from "./is-main.mjs"

export const PROFILES = ["full", "dev"]

/**
 * Flatten a package.json script into the leaf shell commands it runs, following
 * `bun run <other-script>` (and `npm run`/`yarn`) references.
 *
 * Returns [{ script, command }] so a caller can talk about "the build:lib step"
 * rather than about a string.
 */
export const expandBuild = (scripts, name = "build", seen = new Set()) => {
  const body = scripts?.[name]
  if (!body || seen.has(name)) return []
  seen.add(name)
  const out = []
  for (const raw of body.split("&&")) {
    const command = raw.trim()
    if (!command) continue
    const m = command.match(/^(?:bun|npm|yarn|pnpm)\s+run\s+([\w:.-]+)$/)
    if (m && scripts[m[1]] !== undefined) {
      out.push(...expandBuild(scripts, m[1], seen))
      continue
    }
    out.push({ script: name, command })
  }
  return out
}

const TSUP_RE = /(^|\s|\/)tsup(-node)?(\s|$)/

const splitArgs = (command) => command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []

/**
 * The no-declarations form of one build step.
 *
 * @returns { command, wrapsConfig?: string, changed: boolean }
 *   `wrapsConfig` is the config file whose `dts` must be overridden by a
 *   generated wrapper; the returned command already points at the wrapper's
 *   placeholder path, which the caller substitutes.
 */
export const noDtsStep = (command, { wrapperPath = "TSC_DEV_CONFIG" } = {}) => {
  if (!TSUP_RE.test(command)) return { command, changed: false }
  const args = splitArgs(command)
  const dtsIdx = args.findIndex((a) => a === "--dts" || a.startsWith("--dts=") || a === "--experimental-dts")
  if (dtsIdx !== -1) {
    const next = args[dtsIdx + 1]
    // `--dts` is a boolean flag here; `--dts src/x.ts` (an entry override) is
    // legal tsup and its value must go with it.
    const drop = next && !next.startsWith("-") && args[dtsIdx] === "--dts" && /\.(ts|tsx|mts|cts)$/.test(next) ? 2 : 1
    args.splice(dtsIdx, drop)
    return { command: args.join(" "), changed: true }
  }
  const cfgIdx = args.findIndex((a) => a === "--config" || a.startsWith("--config="))
  let config = "tsup.config.ts"
  if (cfgIdx !== -1) {
    config = args[cfgIdx].includes("=") ? args[cfgIdx].split("=").slice(1).join("=") : args[cfgIdx + 1]
    if (args[cfgIdx].includes("=")) args[cfgIdx] = `--config=${wrapperPath}`
    else args[cfgIdx + 1] = wrapperPath
  } else {
    args.push("--config", wrapperPath)
  }
  return { command: args.join(" "), wrapsConfig: config, changed: true }
}

/**
 * The ordered steps to run for a repo and profile.
 *
 * @param scripts   the repo's package.json scripts
 * @param profile   "full" (exactly what the repo's own CI runs) or "dev"
 * @param skipSteps script names the dev profile does not need (from config)
 * @returns { steps: [{ script, command, wrapsConfig?, wrapperPath? }], skipped: string[] }
 */
export const planBuild = ({ scripts, profile = "full", skipSteps = [] }) => {
  const all = expandBuild(scripts, "build")
  if (profile === "full") return { steps: all, skipped: [] }
  const steps = []
  const skipped = []
  let n = 0
  for (const step of all) {
    if (skipSteps.includes(step.script)) {
      skipped.push(step.script)
      continue
    }
    const wrapperPath = `tsup.tsc-dev-nodts.${n}.config.ts`
    const { command, wrapsConfig, changed } = noDtsStep(step.command, { wrapperPath })
    if (wrapsConfig) n++
    steps.push({ ...step, command, wrapsConfig, wrapperPath: wrapsConfig ? wrapperPath : undefined, changed })
  }
  return { steps, skipped }
}

/** The generated tsup config that reuses the repo's own, minus declarations. */
export const wrapperSource = (configFile) => {
  const spec = configFile.startsWith(".") ? configFile : `./${configFile}`
  const importPath = spec.replace(/\.(ts|mts|cts|js|mjs|cjs)$/, "")
  return `// Generated by tsc-dev (profile: dev). Deleted when the build finishes.
// Reuses ${configFile} verbatim and only turns declaration emit off — the
// inner loop consumes none of it, and it is 61% of a full chain rebuild.
import { defineConfig } from "tsup"
import base from "${importPath}"

export default defineConfig(async (overrides) => {
  const resolved = typeof base === "function" ? await base(overrides) : base
  const list = Array.isArray(resolved) ? resolved : [resolved]
  return list.map((options) => ({ ...options, dts: false, experimentalDts: false }))
})
`
}

/** Skip lists declared in workspace.json for a repo/profile. */
export const skipStepsFor = (config, repo, profile) =>
  config?.build?.profiles?.[profile]?.skipSteps?.[repo] ?? []

if (isMain(import.meta.url)) {
  const [scriptsJson, profile] = process.argv.slice(2)
  if (!scriptsJson) {
    console.error('usage: build-profile.mjs \'{"build":"..."}\' [profile]')
    process.exit(2)
  }
  const { steps, skipped } = planBuild({ scripts: JSON.parse(scriptsJson), profile: profile ?? "full" })
  for (const s of steps) console.log(s.command)
  if (skipped.length) console.error(`skipped: ${skipped.join(", ")}`)
}
