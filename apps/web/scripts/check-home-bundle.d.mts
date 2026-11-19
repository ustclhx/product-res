export const FORBIDDEN_MARKERS: readonly string[]
export const RENDERER_MARKERS: readonly string[]
export function htmlScripts(html: string): string[]
export function staticClosure(clientDir: string, entries: readonly string[]): string[]
export function checkHomeBundle(clientDir: string): {
  files: string[]
  gzipBytes: number
  violations: { asset: string; marker: string }[]
  hydration: string[]
  hydrationGzipBytes: number
  zodSources: string[]
}
export function entryScripts(html: string): string[]
export function entryDynamicImports(clientDir: string, entries: readonly string[]): string[]
export function decodeMappings(mappings: string): [number, number][]
export function zodBindings(sourceCode: string): Set<string>
export function zodSources(
  clientDir: string,
  files: readonly string[],
  offending: readonly string[],
): string[]
export function checkServerHomeBundle(serverDir: string): {
  files: string[]
  routeEntries: string[]
  gzipBytes: number
  violations: { asset: string; marker: string }[]
}
export const ZOD_MARKERS: readonly string[]
export function budgetViolation(gzipBytes: number, budget: number | null | undefined): string | null
export function readPerformanceOptions(
  distDir: string,
): { prerender?: boolean; homeScriptGzipBudget?: number | null } | null
