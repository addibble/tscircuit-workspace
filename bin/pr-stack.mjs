#!/usr/bin/env node
//
// pr-stack.mjs — pure planning for cross-repository merge stacks.
//
// A developer can keep working on ordinary local/fork branches, then map those
// branches to tscircuit-owned upstream branches for merge preparation. Same-repo
// layers may base on another layer; cross-repo `dependsOn` edges express release
// and merge ordering without pretending Git can have a cross-repository base.
import { loadConfig } from "./workspace-config.mjs"
import { isMain } from "./is-main.mjs"

const asObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {}

export const mergeStackName = (config, requested) =>
  requested || config.defaultMergeStack || Object.keys(asObject(config.mergeStacks))[0]

export const normalizeMergeStack = (config, requestedName) => {
  const name = mergeStackName(config, requestedName)
  if (!name) throw new Error("no merge stack configured")
  const raw = asObject(config.mergeStacks)[name]
  if (!raw) throw new Error(`unknown merge stack '${name}'`)
  const upstreamOwner = raw.upstreamOwner || "tscircuit"
  const rawLayers = asObject(raw.layers)
  const layers = {}
  const errors = []

  for (const [id, value] of Object.entries(rawLayers)) {
    const layer = asObject(value)
    if (!layer.repo) errors.push(`${id}: repo is required`)
    if (!layer.sourceBranch) errors.push(`${id}: sourceBranch is required`)
    const upstreamBranch =
      layer.upstreamBranch || `stack/${name}/${id}`
    layers[id] = {
      id,
      repo: layer.repo,
      sourceBranch: layer.sourceBranch,
      upstreamBranch,
      baseLayer: layer.baseLayer || null,
      base: layer.base || "main",
      dependsOn: [...new Set(layer.dependsOn || [])],
      title: layer.title || null,
      body: layer.body || null,
    }
  }

  for (const layer of Object.values(layers)) {
    if (layer.baseLayer) {
      const baseLayer = layers[layer.baseLayer]
      if (!baseLayer) errors.push(`${layer.id}: unknown baseLayer '${layer.baseLayer}'`)
      else if (baseLayer.repo !== layer.repo)
        errors.push(
          `${layer.id}: baseLayer '${layer.baseLayer}' is in ${baseLayer.repo}; Git bases must be in the same repo (use dependsOn for cross-repo ordering)`,
        )
    }
    for (const dependency of layer.dependsOn) {
      if (!layers[dependency])
        errors.push(`${layer.id}: unknown dependency '${dependency}'`)
    }
  }

  const branchOwners = new Map()
  for (const layer of Object.values(layers)) {
    const key = `${layer.repo}:${layer.upstreamBranch}`
    if (branchOwners.has(key))
      errors.push(
        `${layer.id}: upstream branch duplicates '${branchOwners.get(key)}' (${key})`,
      )
    branchOwners.set(key, layer.id)
  }

  if (errors.length) throw new Error(errors.join("\n"))

  const order = topologicalLayerOrder(layers)
  const plannedLayers = order.map((id, index) => {
    const layer = layers[id]
    const baseLayer = layer.baseLayer ? layers[layer.baseLayer] : null
    const dependencies = [...new Set([...(baseLayer ? [baseLayer.id] : []), ...layer.dependsOn])]
    return {
      ...layer,
      index: index + 1,
      baseBranch: baseLayer ? baseLayer.upstreamBranch : layer.base,
      sourceBaseBranch: baseLayer ? baseLayer.sourceBranch : null,
      dependencies,
    }
  })

  return {
    name,
    description: raw.description || "",
    upstreamOwner,
    layers: plannedLayers,
  }
}

export const topologicalLayerOrder = (layers) => {
  const ids = Object.keys(layers)
  const incoming = new Map(ids.map((id) => [id, 0]))
  const outgoing = new Map(ids.map((id) => [id, []]))
  for (const layer of Object.values(layers)) {
    const dependencies = [...new Set([...(layer.baseLayer ? [layer.baseLayer] : []), ...layer.dependsOn])]
    for (const dependency of dependencies) {
      incoming.set(layer.id, incoming.get(layer.id) + 1)
      outgoing.get(dependency).push(layer.id)
    }
  }
  const ready = ids.filter((id) => incoming.get(id) === 0)
  const order = []
  while (ready.length) {
    const id = ready.shift()
    order.push(id)
    for (const consumer of outgoing.get(id)) {
      incoming.set(consumer, incoming.get(consumer) - 1)
      if (incoming.get(consumer) === 0) ready.push(consumer)
    }
  }
  if (order.length !== ids.length) {
    const cycle = ids.filter((id) => !order.includes(id))
    throw new Error(`merge stack contains a dependency cycle: ${cycle.join(", ")}`)
  }
  return order
}

export const findSourceBranchBase = (config, repo, sourceBranch) => {
  const matches = []
  for (const name of Object.keys(asObject(config.mergeStacks))) {
    const stack = normalizeMergeStack(config, name)
    for (const layer of stack.layers) {
      if (layer.repo === repo && layer.sourceBranch === sourceBranch) {
        matches.push({ stack: name, layer: layer.id, base: layer.sourceBaseBranch })
      }
    }
  }
  if (matches.length > 1) {
    throw new Error(
      `${repo}:${sourceBranch} occurs in several merge stacks: ${matches.map((m) => `${m.stack}/${m.layer}`).join(", ")}`,
    )
  }
  return matches[0] || null
}

export const upsertManagedBlock = (body, block) => {
  const start = "<!-- tsc-dev-pr-stack:start -->"
  const end = "<!-- tsc-dev-pr-stack:end -->"
  const managed = `${start}\n${block.trim()}\n${end}`
  const existing = String(body || "").trim()
  const startAt = existing.indexOf(start)
  const endAt = existing.indexOf(end)
  if (startAt >= 0 && endAt >= startAt) {
    return `${existing.slice(0, startAt).trimEnd()}\n\n${managed}${existing.slice(endAt + end.length)}`.trim()
  }
  return existing ? `${existing}\n\n${managed}` : managed
}

export const renderStackBlock = ({ stackName, layer, dependencies = [] }) => {
  const lines = [
    "## Merge stack",
    "",
    `Stack: \`${stackName}\` · layer \`${layer.id}\``,
    `Upstream branch: \`${layer.repo}:${layer.upstreamBranch}\``,
    `Base: \`${layer.baseBranch}\``,
  ]
  if (dependencies.length) {
    lines.push("", "Prerequisites:")
    for (const dependency of dependencies) {
      const box = dependency.merged ? "[x]" : "[ ]"
      const target = dependency.url || dependency.branchUrl
      lines.push(
        `- ${box} ${target ? `[${dependency.id}](${target})` : `\`${dependency.id}\``}${dependency.state ? ` — ${dependency.state}` : ""}`,
      )
    }
  } else {
    lines.push("", "Prerequisites: none")
  }
  lines.push("", "Managed by `./tsc-dev pr-stack`; edit prose above this block freely.")
  return lines.join("\n")
}

const printPlan = (stack, tsv) => {
  if (!tsv) {
    process.stdout.write(`${JSON.stringify(stack, null, 2)}\n`)
    return
  }
  for (const layer of stack.layers) {
    process.stdout.write(
      [
        layer.id,
        layer.repo,
        layer.sourceBranch,
        layer.upstreamBranch,
        layer.baseBranch,
        layer.sourceBaseBranch || "-",
        layer.dependencies.join(",") || "-",
        layer.title || "-",
      ].join("\t") + "\n",
    )
  }
}

if (isMain(import.meta.url)) {
  const [command, root, name, ...args] = process.argv.slice(2)
  try {
    if (command === "plan" && root) {
      printPlan(normalizeMergeStack(loadConfig(root), name || undefined), args.includes("--tsv"))
    } else if (command === "source-base" && root) {
      const [repo, branch] = [name, args[0]]
      const match = findSourceBranchBase(loadConfig(root), repo, branch)
      if (match) process.stdout.write(JSON.stringify(match))
    } else if (command === "upsert-body") {
      const [body, block] = [root || "", name || ""]
      process.stdout.write(upsertManagedBlock(body, block))
    } else {
      console.error(
        "usage: pr-stack.mjs plan <root> [stack] [--tsv] | source-base <root> <repo> <branch> | upsert-body <body> <block>",
      )
      process.exit(2)
    }
  } catch (error) {
    console.error(String(error?.message || error))
    process.exit(1)
  }
}
