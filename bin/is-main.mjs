#!/usr/bin/env node
//
// is-main.mjs — "was this file run directly, or imported?"
//
// Every CLI in bin/ is also a module that tests import. ESM has no equivalent
// of CommonJS's `require.main === module`, so each file needs this guard, and
// getting it wrong fails in two ways that look nothing alike:
//
//   * NO guard        — the CLI body runs on import. A test that imports the
//                       module inherits the test runner's argv, prints usage,
//                       and calls process.exit(), killing the whole run.
//   * NAIVE guard     — comparing `import.meta.url` to
//                       `pathToFileURL(process.argv[1])` fails whenever any
//                       path component is a symlink, because node resolves
//                       symlinks when loading a module but the shell does not.
//                       The CLI then silently does nothing and exits 0 — which
//                       is worse, because it looks like success.
//
// /tmp is a symlink to /private/tmp on macOS, and plenty of home directories
// are symlinked too, so the naive form is not a theoretical problem: it was
// hit for real by `workspace-config.mjs --explain` inside an adopted workspace.
//
// Usage, at the bottom of any bin/*.mjs:
//
//   import { isMain } from "./is-main.mjs"
//   if (isMain(import.meta.url)) { ...cli... }
import fs from "node:fs"
import { fileURLToPath } from "node:url"

const realpath = (p) => {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

export const isMain = (importMetaUrl) => {
  if (!process.argv[1] || !importMetaUrl) return false
  try {
    return realpath(process.argv[1]) === realpath(fileURLToPath(importMetaUrl))
  } catch {
    return false
  }
}
