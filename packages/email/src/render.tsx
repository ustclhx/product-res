import { render } from 'react-email'
import { EmailLayout } from './layout.tsx'
import { type EmailLocale, resolveEmailLocale } from './locale.ts'
import {
  type CopyContext,
  copies,
  type EmailCopy,
  type EmailTemplateName,
  type EmailTemplateProps,
} from './messages.ts'
import type { EmailHeaders } from './sender.ts'

export interface RenderContext {
  /** 收件人的 `user.locale`；邀请未注册用户时可传邀请人的语言或不传 */
  readonly locale: string | null | undefined
  /** `template.config.ts` 的 `app.name` */
  readonly appName: string
  readonly defaultLocale?: string
  readonly recipientName?: string | undefined
}

export interface RenderedEmail {
  readonly headers?: EmailHeaders
  readonly locale: EmailLocale
  readonly subject: string
  readonly html: string
  readonly text: string
}

/** 按模板名与收件人语言渲染出可直接交给 `EmailSender` 的主题、HTML 与纯文本。 */
export async function renderEmail<N extends EmailTemplateName>(
  template: N,
  props: EmailTemplateProps[N],
  context: RenderContext,
): Promise<RenderedEmail> {
  const locale = resolveEmailLocale(context.locale, context.defaultLocale)
  // 按模板名索引后 TS 无法把 N 与对应的 props 类型关联起来，这里收窄一次
  const build = copies[locale][template] as (
    props: EmailTemplateProps[N],
    ctx: CopyContext,
  ) => EmailCopy
  const copy = build(props, { appName: context.appName, recipientName: context.recipientName })
  if (copy.action !== undefined) assertHttpUrl(copy.action.url)

  const element = <EmailLayout copy={copy} locale={locale} appName={context.appName} />
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true, htmlToTextOptions: { selectors: plainTextHeadings } }),
  ])
  const headers: EmailHeaders | undefined =
    template === 'newsletter'
      ? {
          'List-Unsubscribe': `<${(props as EmailTemplateProps['newsletter']).unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        }
      : undefined
  return { locale, subject: copy.subject, html, text, ...(headers ? { headers } : {}) }
}

// html-to-text 默认把标题转成大写，会改写空间名等用户输入
const plainTextHeadings = (['h1', 'h2', 'h3'] as const).map((selector) => ({
  selector,
  options: { uppercase: false },
}))

/** 邮件中的链接只允许 http(s)，防止调用方误传 `javascript:` 等协议。 */
function assertHttpUrl(url: string): void {
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    throw new TypeError('Email link must be an absolute URL')
  }
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new TypeError('Email link must use http or https')
  }
}
