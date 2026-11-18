/** FNV-1a 32 位摘要（8 位十六进制）：只用于缓存地址的稳定指纹，不承担访问控制。 */
export function fnv1a(text: string): string {
  let hash = 2166136261
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return (hash >>> 0).toString(16).padStart(8, '0')
}
