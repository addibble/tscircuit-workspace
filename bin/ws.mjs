#!/usr/bin/env node
//
// ws.mjs — evaluate an expression against the layered workspace config.
//
//   ws.mjs <root> <expression> [args...]
//
// `w` is the merged config (workspace.json overlaid by .local/workspace.local.json)
// and `args` holds the extra arguments. Arrays print one element per line so bash
// can read them with `while read`; objects print as JSON.
import { loadConfig } from "./workspace-config.mjs"
import { isMain } from "./is-main.mjs"

if (isMain(import.meta.url)) {
  const [root, expression, ...args] = process.argv.slice(2)
  if (!root || !expression) {
    console.error("usage: ws.mjs <root> <expression> [args...]")
    process.exit(2)
  }

  let w
  try {
    w = loadConfig(root)
  } catch (e) {
    console.error(String(e.message ?? e))
    process.exit(3)
  }

  let out
  try {
    out = eval(expression)
  } catch (e) {
    console.error(String(e.message ?? e))
    process.exit(3)
  }

  if (out == null) process.exit(0)
  if (Array.isArray(out)) process.stdout.write(out.join("\n"))
  else if (typeof out === "object") process.stdout.write(JSON.stringify(out, null, 2))
  else process.stdout.write(String(out))
}
