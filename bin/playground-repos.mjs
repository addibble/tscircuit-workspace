#!/usr/bin/env node
//
// playground-repos.mjs — which repos a playground should watch.
//
//   playground-repos.mjs <root> <playground-name> [--explain]
//
// Precedence, most specific first:
//
//   1. an explicit `watch` list on the playground   — you said exactly what you meant
//   2. `effort: "<name>"`                           — every package in that patch set
//   3. the playground's own yalc.lock               — whatever it currently links
//
// (2) is the useful default for feature work: an effort already lists the repos
// a change spans, so binding a playground to the effort means adding a repo to
// the effort is enough — there is no second list to remember. Docs repos in an
// effort (rfc, skill: no package.json) are skipped, because there is nothing to
// build or push from them.
import fs from "node:fs"
import path from "node:path"
import { loadConfig } from "./workspace-config.mjs"
import { isMain } from "./is-main.mjs"

/**
 * Pure resolution, filesystem injected so the rule can be tested directly.
 *
 * @param playground        the playground's config entry
 * @param efforts           config.forkEfforts
 * @param isCloned          repo -> boolean
 * @param publishesPackage  repo -> boolean (has a package.json with a name)
 * @param linkedPackages    () -> package names the playground links
 * @param repoForPackage    package name -> repo name (or null)
 */
export const resolveWatchRepos = ({
  playground = {},
  efforts = {},
  isCloned = () => true,
  publishesPackage = () => true,
  linkedPackages = () => [],
  repoForPackage = (p) => p,
}) => {
  if (Array.isArray(playground.watch) && playground.watch.length) {
    return { source: "watch", repos: playground.watch.filter(isCloned) }
  }

  if (playground.effort) {
    const effort = efforts[playground.effort]
    if (!effort) {
      return { source: "effort", effort: playground.effort, repos: [], missing: true }
    }
    const repos = (effort.repos ?? []).filter((r) => isCloned(r) && publishesPackage(r))
    const skipped = (effort.repos ?? []).filter((r) => isCloned(r) && !publishesPackage(r))
    return { source: "effort", effort: playground.effort, repos, skipped }
  }

  const repos = []
  for (const pkg of linkedPackages()) {
    const repo = repoForPackage(pkg)
    if (repo && isCloned(repo) && !repos.includes(repo)) repos.push(repo)
  }
  return { source: "links", repos }
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

export const watchReposForPlayground = (root, name) => {
  const config = loadConfig(root)
  const playground = config.playgrounds?.[name]
  if (!playground) throw new Error(`unknown playground '${name}'`)

  const dir = path.isAbsolute(playground.path) ? playground.path : path.join(root, playground.path)

  // package name -> repo, built once from the cloned repos
  const byPackage = new Map()
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pkg = readJson(path.join(root, entry.name, "package.json"))
    if (pkg?.name) byPackage.set(pkg.name, entry.name)
  }

  return resolveWatchRepos({
    playground,
    efforts: config.forkEfforts ?? {},
    isCloned: (repo) => fs.existsSync(path.join(root, repo, ".git")),
    publishesPackage: (repo) => Boolean(readJson(path.join(root, repo, "package.json"))?.name),
    linkedPackages: () => Object.keys(readJson(path.join(dir, "yalc.lock"))?.packages ?? {}),
    repoForPackage: (pkg) => byPackage.get(pkg) ?? null,
  })
}

if (isMain(import.meta.url)) {
  const [root, name, flag] = process.argv.slice(2)
  if (!root || !name) {
    console.error("usage: playground-repos.mjs <root> <playground-name> [--explain]")
    process.exit(2)
  }
  try {
    const result = watchReposForPlayground(root, name)
    if (flag === "--explain") {
      const from =
        result.source === "effort"
          ? `effort '${result.effort}'${result.missing ? " (NOT FOUND in config)" : ""}`
          : result.source === "watch"
            ? "explicit watch list"
            : "the playground's yalc.lock"
      console.log(`source: ${from}`)
      if (result.skipped?.length) console.log(`skipped (no package.json): ${result.skipped.join(", ")}`)
      console.log(result.repos.join("\n"))
    } else if (result.repos.length) {
      console.log(result.repos.join("\n"))
    }
  } catch (e) {
    console.error(`error: ${e.message}`)
    process.exit(1)
  }
}
