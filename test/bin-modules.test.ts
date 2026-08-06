import { test, expect } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { pathToFileURL } from "node:url"
import { isMain } from "../bin/is-main.mjs"

// Every bin/*.mjs is both a module (imported by these tests) and a CLI. Getting
// the "am I main?" guard wrong has bitten twice, in two ways that look nothing
// alike, so this enforces it mechanically rather than by review:
//
//   * missing guard — the CLI body runs on import, reads the test runner's
//     argv, prints usage and calls process.exit(), killing the whole run;
//   * naive guard   — comparing import.meta.url to process.argv[1] fails behind
//     a symlink, so the CLI silently does nothing and exits 0.

const BIN = path.join(import.meta.dir, "..", "bin")
const modules = fs.readdirSync(BIN).filter((f) => f.endsWith(".mjs"))

test("there are modules to check", () => {
  expect(modules.length).toBeGreaterThan(5)
})

for (const file of modules) {
  test(`importing bin/${file} has no side effects`, () => {
    // A subprocess, because the failure mode is process.exit() — which would
    // take this test runner down with it if we imported in-process.
    const full = path.join(BIN, file)
    const out = execFileSync(process.execPath, ["-e", `import(${JSON.stringify(full)}).then(()=>{})`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    expect(out.trim()).toBe("")
  })
}

test("isMain is false for a module that is not the entry point", () => {
  // Note bun sets argv[1] to the test file, so isMain(import.meta.url) is
  // legitimately TRUE here — the property that matters is that some OTHER
  // module, merely imported, does not consider itself main.
  const other = pathToFileURL(path.join(BIN, "ci-gates.mjs")).href
  expect(isMain(other)).toBe(false)
})

test("isMain compares real paths, so a symlinked invocation still counts as main", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ismain-"))
  const real = path.join(dir, "real")
  fs.mkdirSync(real)
  const script = path.join(real, "cli.mjs")
  fs.writeFileSync(
    script,
    `import { isMain } from ${JSON.stringify(path.join(BIN, "is-main.mjs"))}\n` +
      `if (isMain(import.meta.url)) console.log("MAIN")\n`,
  )
  const link = path.join(dir, "link")
  fs.symlinkSync(real, link)

  const viaReal = execFileSync(process.execPath, [script], { encoding: "utf8" }).trim()
  const viaLink = execFileSync(process.execPath, [path.join(link, "cli.mjs")], { encoding: "utf8" }).trim()

  expect(viaReal).toBe("MAIN")
  expect(viaLink).toBe("MAIN") // the naive guard prints nothing here
  fs.rmSync(dir, { recursive: true, force: true })
})

test("isMain tolerates a missing or bogus argv/url rather than throwing", () => {
  expect(isMain(undefined)).toBe(false)
  expect(isMain("not-a-url")).toBe(false)
})
