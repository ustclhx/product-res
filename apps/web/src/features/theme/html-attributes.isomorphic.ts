import { createIsomorphicFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { getLocale } from '../../paraglide/runtime.js'
import { isAllowedHtmlAttribute } from './html-attributes.allowed.ts'
import { resolveHtmlAttributes } from './html-attributes.server.ts'

/** 首屏由服务端计算并序列化；客户端导航只复用已渲染的属性，避免额外 RPC。 */
export const getHtmlAttributes = createIsomorphicFn()
  .server((pathname: string) =>
    resolveHtmlAttributes({
      host: new URL(getRequest().url).host,
      locale: getLocale(),
      pathname,
    }),
  )
  .client((_pathname: string) => {
    const attributes: Record<string, string> = {}
    for (const { name, value } of document.documentElement.attributes) {
      if (isAllowedHtmlAttribute(name, value)) attributes[name] = value
    }
    return attributes
  })
