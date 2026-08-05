#!/usr/bin/env node
//
// gen-map.mjs — render MAP.md's group sections from workspace.json.
//
// The group lists used to exist twice: as prose in MAP.md and as data in
// workspace.json. Two copies of the same fact drift, and the prose copy is the
// one developers read. So the data is now the source and the prose is generated
// between markers; everything outside them (the intro, the utility/app/dataset
// sections) stays hand-written.
//
//   gen-map.mjs write <root>    rewrite the generated block in MAP.md
//   gen-map.mjs check <root>    exit 1 if MAP.md is stale (for CI / pre-commit)
import fs from "node:fs"
import path from "node:path"
import { loadConfig } from "./workspace-config.mjs"

export const BEGIN = "<!-- BEGIN GENERATED: groups (./tsc-dev gen-map) -->"
export const END = "<!-- END GENERATED -->"

export const renderGroups = (config) => {
  const notes = config.repoNotes ?? {}
  const lines = []
  for (const [name, group] of Object.entries(config.groups ?? {})) {
    lines.push(`## ${group.title ?? name}  (\`clone-group ${name}\`)`)
    if (group.description) lines.push(group.description)
    for (const repo of group.repos ?? []) {
      const note = notes[repo]
      lines.push(note ? `- **${repo}** — ${note}` : `- **${repo}**`)
    }
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}

export const applyToMarkdown = (markdown, generated) => {
  const start = markdown.indexOf(BEGIN)
  const end = markdown.indexOf(END)
  if (start === -1 || end === -1) {
    throw new Error(`MAP.md is missing the generated-block markers:\n  ${BEGIN}\n  ${END}`)
  }
  const before = markdown.slice(0, start + BEGIN.length)
  const after = markdown.slice(end)
  return `${before}\n\n${generated}\n\n${after}`
}

const run = (mode, root) => {
  const mapPath = path.join(root, "MAP.md")
  const markdown = fs.readFileSync(mapPath, "utf8")
  const next = applyToMarkdown(markdown, renderGroups(loadConfig(root)))
  if (mode === "check") {
    if (next !== markdown) {
      console.error("✗ MAP.md is out of date with workspace.json — run: ./tsc-dev gen-map")
      process.exit(1)
    }
    console.log("✓ MAP.md matches workspace.json")
    return
  }
  if (next === markdown) {
    console.log("✓ MAP.md already up to date")
    return
  }
  fs.writeFileSync(mapPath, next)
  console.log("✓ regenerated MAP.md group sections from workspace.json")
}

const realpath = (p) => {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}
if (process.argv[1] && realpath(process.argv[1]) === realpath(new URL(import.meta.url).pathname)) {
  const [mode, root] = process.argv.slice(2)
  if ((mode === "write" || mode === "check") && root) run(mode, root)
  else {
    console.error("usage: gen-map.mjs <write|check> <root>")
    process.exit(2)
  }
}
