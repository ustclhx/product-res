export interface MarketingPerformance {
  readonly hydration: 'eager' | 'after-paint'
  readonly criticalCss: 'full' | 'used'
  readonly homeScriptGzipBudget: number | null
}
export const DEFAULT_PERFORMANCE: MarketingPerformance
export function headSignature(html: string): string
export function brandOverridesFontSans(brandCss: string): boolean
export function fontFaceRules(css: string): string[]
export function afterPaintLoader(options: { styles?: string[]; scripts?: string[] }): string
export function usedCss(
  html: string,
  css: string,
  options?: { allowRules?: (string | RegExp)[] },
): Promise<string>
export function optimizeHtml(
  html: string,
  performance: Partial<MarketingPerformance>,
  readCss: (href: string) => Promise<string>,
  options?: { allowRules?: (string | RegExp)[] },
): Promise<{ html: string; inlined: number; styles: string[]; scripts: string[] }>
export function assertSameHead(before: string, after: string): void
export function decodeClassAttributes(html: string): string
export const DEFAULT_ALLOW_RULES: readonly RegExp[]
export function selectorClasses(selector: string): string[]
export function documentClasses(html: string): Set<string>
export function rootAttributes(html: string): Map<string, string>
export class RootAttributeRule extends RegExp {
  constructor(attrs: Map<string, string>)
}
