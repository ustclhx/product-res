import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

/**
 * 模板配置里的链接：站内页面路径走路由器 Link（客户端导航，并由 localeRewrite 按当前语言加前缀）；
 * 页内锚点、带查询参数的地址、外部地址、`/api/` 接口与带扩展名的静态文件（如 `/files/guide.pdf`）用普通 <a>。
 */
export function ConfigLink({
  href,
  ...props
}: {
  href: string
  className?: string
  'aria-label'?: string
  children: ReactNode
}) {
  if (href.startsWith('/') && !href.startsWith('//')) {
    const url = new URL(href, 'http://local')
    const isFile = /\.[a-z0-9]+$/i.test(url.pathname)
    if (!url.search && !isFile && !url.pathname.startsWith('/api/')) {
      // 配置中的路径是字符串，无法在类型层面对应到具体路由；运行时由路由器按路径匹配
      const to = url.pathname as '/'
      return url.hash ? (
        <Link to={to} hash={url.hash.slice(1)} {...props} />
      ) : (
        <Link to={to} {...props} />
      )
    }
  }
  return <a href={href} {...props} />
}
