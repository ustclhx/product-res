export interface HtmlAttributesContext {
  /** 当前请求的 URL host（含非默认端口），不是转发头。 */
  readonly host: string
  readonly locale: string
  /** 路由 pathname，不含查询参数或语言前缀。 */
  readonly pathname: string
}

export type ProjectHtmlAttributes = Partial<Record<`data-${string}`, string>> & {
  dir?: 'ltr' | 'rtl' | 'auto'
  title?: string
  translate?: 'yes' | 'no'
}
