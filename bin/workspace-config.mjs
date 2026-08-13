#!/usr/bin/env node
//
// workspace-config.mjs — load the layered workspace configuration.
//
// Two layers, with deliberately different homes and different git histories:
//
//   workspace.json               SHARED. Facts that are the same for every
//                                developer: the clone groups, the build-time
//                                bundling graph, the default clone set. Lives on
//                                the workspace repo's main branch.
//
//   .local/workspace.local.json  YOURS. Facts that describe your current work:
//                                which patch-set effort you are running, your
//                                own groups, any override of the above. Lives on
//                                an orphan branch in .local/, pushed only to
//                                your fork — versioned, but never on main.
//
// The test for which layer a key belongs in: would every developer's copy hold
// the same value? Shared if yes, local if no.
//
// Usage:
//   workspace-config.mjs --explain <root>          show effective config + provenance
//   workspace-config.mjs --seed <root> <outfile>   create a local layer (migrating
//                                                  any user-specific keys found in
//                                                  the shared file)
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isMain } from "./is-main.mjs"

export const GLOBAL_FILE = "workspace.json"
export const LOCAL_FILE = path.join(".local", "workspace.local.json")

// Keys that describe one developer's current work rather than the project.
export const USER_KEYS = [
  "defaultForkEffort",
  "forkEfforts",
  "defaultMergeStack",
  "mergeStacks",
]

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (e) {
    if (e.code === "ENOENT") return null
    throw new Error(`${file}: ${e.message}`)
  }
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v)

// Objects merge key by key so a local layer can add one group without restating
// the rest; arrays and scalars are REPLACED whole, because a partial array merge
// has no obvious meaning (is it append? by index? by name?) and guessing wrong
// would silently change a rebuild chain.
export const merge = (base, over) => {
  if (!isPlainObject(base) || !isPlainObject(over)) return over
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge(base[k], v) : v
  return out
}

export const configPaths = (root) => ({
  global: path.join(root, GLOBAL_FILE),
  local: path.join(root, LOCAL_FILE),
})

export const loadConfig = (root) => {
  const p = configPaths(root)
  const shared = readJson(p.global)
  if (!shared) throw new Error(`missing ${GLOBAL_FILE} in ${root}`)
  const local = readJson(p.local)
  return local ? merge(shared, local) : shared
}

const explain = (root) => {
  const p = configPaths(root)
  const shared = readJson(p.global) ?? {}
  const local = readJson(p.local)
  console.log(`shared  ${GLOBAL_FILE}`)
  console.log(`local   ${LOCAL_FILE}${local ? "" : "   (none — ./tsc-dev local init)"}`)
  console.log("")
  const keys = [...new Set([...Object.keys(shared), ...Object.keys(local ?? {})])].sort()
  for (const key of keys) {
    if (key.startsWith("$")) continue
    const inShared = key in shared
    const inLocal = local != null && key in local
    const source = inShared && inLocal ? "local (overrides shared)" : inLocal ? "local" : "shared"
    console.log(`  ${key.padEnd(20)} ${source}`)
    if (inShared && inLocal && isPlainObject(shared[key]) && isPlainObject(local[key])) {
      for (const sub of Object.keys(local[key])) {
        console.log(`    ${(sub + (sub in shared[key] ? " (overridden)" : " (added)")).padEnd(30)}`)
      }
    }
  }
  const stray = USER_KEYS.filter((k) => k in shared)
  if (stray.length) {
    console.log("")
    console.log(`⚠ user-specific key(s) still in the shared file: ${stray.join(", ")}`)
    console.log(`  move them to ${LOCAL_FILE} so they are not committed to main`)
  }
}

const seed = (root, outFile) => {
  const shared = readJson(configPaths(root).global) ?? {}
  const out = {
    $comment:
      "Your personal workspace layer. Deep-merged over workspace.json, and it wins. " +
      "Versioned on an orphan branch pushed only to your fork — never to the shared repo's main. " +
      "Put anything here whose value differs between developers.",
  }
  const migrated = []
  for (const key of USER_KEYS) {
    if (key in shared) {
      out[key] = shared[key]
      migrated.push(key)
    }
  }
  if (!("forkEfforts" in out)) {
    out.defaultForkEffort = "example"
    out.forkEfforts = {
      example: {
        description: "Repos carrying one patch set, and the branch each uses.",
        defaultBranch: "feat/my-feature",
        branchOverrides: {},
        repos: [],
      },
    }
  }
  if (!("mergeStacks" in out)) {
    out.defaultMergeStack = "example"
    out.mergeStacks = {
      example: {
        description:
          "Source branches stay on your fork; publish maps them to tscircuit-owned PR branches.",
        upstreamOwner: "tscircuit",
        layers: {
          props: {
            repo: "props",
            sourceBranch: "feat/my-feature-props",
            upstreamBranch: "feat/my-feature/01-props",
          },
          core: {
            repo: "core",
            sourceBranch: "feat/my-feature-core",
            upstreamBranch: "feat/my-feature/02-core",
            dependsOn: ["props"],
          },
        },
      },
    }
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n")
  console.log(
    migrated.length
      ? `seeded ${outFile} (migrated from ${GLOBAL_FILE}: ${migrated.join(", ")})`
      : `seeded ${outFile}`,
  )
  if (migrated.length) console.log(`now remove ${migrated.join(", ")} from ${GLOBAL_FILE}`)
}


if (isMain(import.meta.url)) {
  const [mode, root, out] = process.argv.slice(2)
  if (mode === "--explain" && root) explain(root)
  else if (mode === "--seed" && root && out) seed(root, out)
  else {
    console.error("usage: workspace-config.mjs --explain <root> | --seed <root> <outfile>")
    process.exit(2)
  }
}
