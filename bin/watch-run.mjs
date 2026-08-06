#!/usr/bin/env node
//
// watch-run.mjs — re-run a command when a repo's source changes.
//
//   watch-run.mjs <dir> <label> -- <command> [args...]
//
// Deliberately generic and workspace-only: it drives each repo's OWN existing
// build through `tsc-dev push`, so nothing has to be added to any repo's
// package.json. Nothing here needs upstreaming to stay working.
//
// Behaviour that matters:
//   * debounced — editors write several files (and temp files) per save;
//   * serialized — one run at a time, with at most one queued, so a burst of
//     saves during a 10s build collapses into a single follow-up run rather
//     than a backlog;
//   * resilient — a failing build logs and keeps watching, because the usual
//     reason a build fails mid-session is a half-typed edit.
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { isMain } from "./is-main.mjs"

// Build output and vendored code: watching these would make every build
// retrigger itself forever.
export const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".yalc",
  "cosmos-export",
  "benchmarking-dist",
  "coverage",
  ".next",
  "build",
])

// Files the build itself writes into the watched tree. Without these the
// watcher retriggers its own build forever — observed immediately in practice:
// tsup drops a bundled config beside tsup.config.ts, `push` stamps and restores
// package.json, and `yalc push` rewrites yalc.lock. All three fired within
// seconds of starting the first watcher.
//
// The cost is that a genuine dependency edit (package.json) will not retrigger;
// restart the watcher after one. That is the right trade: a missed rebuild is
// visible and cheap, an infinite rebuild loop burns a core continuously.
export const SELF_WRITTEN = [
  /^tsup\.config\.bundled_.*\.(m?js|cjs)$/,
  /^package\.json$/,
  /^yalc\.lock$/,
  /^bun\.lockb?$/,
  /\.tsbuildinfo$/,
]

export const shouldIgnore = (relPath) => {
  if (!relPath) return true
  const parts = relPath.split(path.sep)
  if (parts.some((p) => IGNORED_DIRS.has(p))) return true
  const base = parts[parts.length - 1]
  if (base.startsWith(".")) return true // .DS_Store, editor swap files
  if (base.endsWith("~") || base.endsWith(".log")) return true
  // Editors write to a temp name then rename; the temp write is noise.
  if (/^\d+$/.test(base) || base.endsWith(".tmp")) return true
  if (SELF_WRITTEN.some((re) => re.test(base))) return true
  return false
}

const DEBOUNCE_MS = Number(process.env.TSC_DEV_WATCH_DEBOUNCE ?? 400)

const ts = () => new Date().toISOString().slice(11, 19)
const log = (msg) => console.log(`[${ts()}] ${msg}`)

const main = () => {
  const argv = process.argv.slice(2)
  const sep = argv.indexOf("--")
  if (sep === -1 || sep < 2) {
    console.error("usage: watch-run.mjs <dir> <label> -- <command> [args...]")
    process.exit(2)
  }
  const [dir, label] = argv.slice(0, sep)
  const command = argv.slice(sep + 1)
  if (!fs.existsSync(dir)) {
    console.error(`no such directory: ${dir}`)
    process.exit(2)
  }

  let running = false
  let queued = false
  let timer = null

  const run = () => {
    if (running) {
      queued = true
      return
    }
    running = true
    const started = Date.now()
    log(`▶ ${label}: ${command.join(" ")}`)
    const child = spawn(command[0], command.slice(1), { stdio: ["ignore", "inherit", "inherit"] })
    child.on("exit", (code) => {
      const secs = ((Date.now() - started) / 1000).toFixed(1)
      log(code === 0 ? `✓ ${label} ok (${secs}s)` : `✗ ${label} failed with ${code} (${secs}s) — still watching`)
      running = false
      if (queued) {
        queued = false
        run()
      }
    })
    child.on("error", (e) => {
      log(`✗ ${label} could not start: ${e.message}`)
      running = false
    })
  }

  const schedule = (why) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      log(`· change: ${why}`)
      run()
    }, DEBOUNCE_MS)
  }

  fs.watch(dir, { recursive: true }, (_event, filename) => {
    if (!filename || shouldIgnore(filename)) return
    schedule(filename)
  })

  log(`watching ${dir} (${label}) — debounce ${DEBOUNCE_MS}ms`)
  log(`initial run:`)
  run()
}

if (isMain(import.meta.url)) main()
