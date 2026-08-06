import { test, expect } from "bun:test"
import { parseExports } from "../bin/find-helpers.mjs"

// The point of this index is to answer "does this already exist?" before
// someone writes a second, subtly different copy. A parser that misses exports
// answers "no" wrongly, which is the failure that matters.

test("finds the export forms actually used in this codebase", () => {
  const source = `
export const getBoundsFromPoints = (points: Point[]) => null
export function calculateOutlineBounds(board: PcbBoard) {}
export class BaseSolver {}
export type Bounds = { minX: number }
export interface OutlineBounds { minX: number }
export async function loadThing() {}
export declare const ambient: number
`
  const names = parseExports(source).map((e) => e.name)
  expect(names).toEqual([
    "getBoundsFromPoints",
    "calculateOutlineBounds",
    "BaseSolver",
    "Bounds",
    "OutlineBounds",
    "loadThing",
    "ambient",
  ])
})

test("records the kind, so types can be excluded from duplicate reports", () => {
  const parsed = parseExports("export type Point = {}\nexport const rotatePoint = () => {}\n")
  expect(parsed.find((p) => p.name === "Point")?.kind).toBe("type")
  expect(parsed.find((p) => p.name === "rotatePoint")?.kind).toBe("const")
})

test("records line numbers so a hit is navigable", () => {
  const parsed = parseExports("\n\nexport const clamp = () => {}\n")
  expect(parsed[0].line).toBe(3)
})

test("ignores non-exported declarations", () => {
  // A private helper is not reusable, so listing it would be noise.
  const parsed = parseExports("const toMm = (v) => v\nfunction helper() {}\n")
  expect(parsed).toEqual([])
})

test("ignores re-exports and default exports, which name nothing reusable", () => {
  const parsed = parseExports('export * from "./other"\nexport default thing\nexport { a, b }\n')
  expect(parsed).toEqual([])
})
