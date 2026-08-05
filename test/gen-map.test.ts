import { test, expect } from "bun:test"
import { renderGroups, applyToMarkdown, BEGIN, END } from "../bin/gen-map.mjs"

const config = {
  groups: {
    runtime: { title: "Runtime / rendering chain", description: "The system.", repos: ["core", "eval"] },
    solvers: { title: "Layout solvers", description: "2D algorithms.", repos: ["miniflex"] },
  },
  repoNotes: { core: "the React reconciler", eval: "TSX to Circuit JSON" },
}

test("each group renders a heading, its description and its repos", () => {
  const out = renderGroups(config)
  expect(out).toContain("## Runtime / rendering chain  (`clone-group runtime`)")
  expect(out).toContain("The system.")
  expect(out).toContain("- **core** — the React reconciler")
  expect(out).toContain("- **eval** — TSX to Circuit JSON")
})

test("a repo with no note still renders", () => {
  // Notes are documentation, not a schema: forgetting one must not drop the
  // repo from the map.
  expect(renderGroups(config)).toContain("- **miniflex**")
})

test("only the marked block is replaced", () => {
  const md = `# Title\n\nIntro prose.\n\n${BEGIN}\nOLD CONTENT\n${END}\n\n## Hand-written tail\n- kept\n`
  const out = applyToMarkdown(md, "NEW CONTENT")
  expect(out).toContain("Intro prose.")
  expect(out).toContain("## Hand-written tail")
  expect(out).toContain("NEW CONTENT")
  expect(out).not.toContain("OLD CONTENT")
})

test("regeneration is idempotent", () => {
  const md = `# T\n\n${BEGIN}\n${END}\n\ntail\n`
  const once = applyToMarkdown(md, renderGroups(config))
  const twice = applyToMarkdown(once, renderGroups(config))
  expect(twice).toBe(once)
})

test("missing markers are an error, not a silent no-op", () => {
  expect(() => applyToMarkdown("# No markers here\n", "X")).toThrow(/markers/)
})
