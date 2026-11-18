/** 服务端扩展与客户端 DOM 读取共用白名单，模板属性始终由根布局维护。 */
export function isAllowedHtmlAttribute(name: string, value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ((name !== 'data-preset' && /^data-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) ||
      name === 'title' ||
      (name === 'dir' && ['ltr', 'rtl', 'auto'].includes(value)) ||
      (name === 'translate' && ['yes', 'no'].includes(value)))
  )
}
