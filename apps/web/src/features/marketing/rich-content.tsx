import { cn } from '@product-res/ui'

/**
 * 构建期由 MDX 渲染出的 HTML（content-collections.ts）。内容来自仓库文件，不含用户输入。
 * 排版样式只用主题变量对应的类名，深浅色自动适配。
 */
const prose = [
  'text-base leading-7',
  '[&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:font-semibold [&_h2]:text-xl',
  '[&_h3]:mt-8 [&_h3]:mb-2 [&_h3]:font-semibold [&_h3]:text-lg',
  '[&_p]:my-4 [&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-6',
  '[&_li]:my-1 [&_a]:underline [&_a]:underline-offset-4 [&_strong]:font-semibold',
  '[&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-sm',
  '[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-4',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
].join(' ')

export function RichContent({ html, className }: { html: string; className?: string }) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: 构建期由仓库中的 MDX 文件渲染
  return <div className={cn(prose, className)} dangerouslySetInnerHTML={{ __html: html }} />
}
