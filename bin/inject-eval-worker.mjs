#!/usr/bin/env node
//
// inject-eval-worker.mjs — fill runframe's eval-worker placeholder with the local build.
//
// runframe ships `standalone.min.js` with a placeholder where the eval
// webworker blob URL goes; the `tscircuit` umbrella normally fills it at
// publish time. A workspace serving its own runframe has to fill it too, or the
// browser quietly loads the PUBLISHED eval instead -- which means the page runs
// somebody else's core, and every local change to core, props or the enclosure
// solver is invisible with no error to explain it.
//
//   usage: inject-eval-worker.mjs <standalone.min.js> <worker.js> <out.js>
//
// This is regenerated after every runframe build, not once when the dev server
// starts: a rebuild wipes `dist/`, taking the injected copy with it, and the
// dev server then falls back to the published bundle. That failure is one log
// line in a busy log, and it looks exactly like "my change did not work".
import fs from "node:fs"
import { isMain } from "./is-main.mjs"

const PLACEHOLDER = '"<--INJECT_TSCIRCUIT_EVAL_WEB_WORKER_BLOB_URL-->"'

/** True when this bundle still needs a worker injected into it. */
export const hasPlaceholder = (standalone) => standalone.includes(PLACEHOLDER)

/**
 * Replace the placeholder with an inline blob URL built from the worker source.
 *
 * Kept as a string-to-string function so the substitution is testable without
 * an 11MB bundle on disk: what matters is that every occurrence goes, that the
 * worker arrives base64-encoded (it contains quotes and newlines that would
 * otherwise terminate the literal), and that a bundle without the placeholder
 * is returned untouched rather than corrupted.
 */
export const injectEvalWorker = ({ standalone, worker }) => {
  const base64 = Buffer.from(worker).toString("base64")
  const blobUrl = `URL.createObjectURL(new Blob([atob("${base64}")],{type:"application/javascript"}))`
  return standalone.split(PLACEHOLDER).join(blobUrl)
}

if (isMain(import.meta.url)) {
  const [standalonePath, workerPath, outPath] = process.argv.slice(2)
  if (!standalonePath || !workerPath || !outPath) {
    console.error(
      "usage: inject-eval-worker.mjs <standalone.min.js> <worker.js> <out.js>",
    )
    process.exit(2)
  }
  if (!fs.existsSync(standalonePath) || !fs.existsSync(workerPath)) {
    // Not an error: a workspace that has not built runframe or eval yet simply
    // has nothing to inject, and the caller falls back with its own message.
    process.exit(1)
  }

  const standalone = fs.readFileSync(standalonePath, "utf8")
  if (!hasPlaceholder(standalone)) {
    // Already filled (or a build that does not use the placeholder): copying it
    // through keeps the output path valid for whoever serves it.
    fs.copyFileSync(standalonePath, outPath)
    process.exit(0)
  }

  fs.writeFileSync(
    outPath,
    injectEvalWorker({
      standalone,
      worker: fs.readFileSync(workerPath, "utf8"),
    }),
  )
}
