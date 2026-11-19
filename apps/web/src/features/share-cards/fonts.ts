// 项目回退字体（share-cards.fonts.ts）的校验、文字匹配与指纹。只处理登记信息，不读取字体字节：
// 字节由渲染器按需从静态资源读取，本模块可被元数据与版式安全导入。
import { fnv1a } from './hash.ts'
import { projectShareCardFonts } from './share-cards.fonts.ts'
import type { ProjectShareCardFont } from './types.ts'

export interface ResolvedShareCardFont {
  readonly name: string
  readonly file: string
  readonly weight: 400 | 600
  readonly scripts: readonly string[]
  /** 单个字符是否属于本字体登记的文字。 */
  readonly pattern: RegExp
}

// 只允许 public/fonts/share-card/ 下的单个文件名：静态资源路径与本地读取都直接拼接它。
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:otf|ttf|woff)$/
const SCRIPT_NAME = /^[A-Za-z][A-Za-z_]*$/
// 标点、数字与组合符号属于 Common / Inherited：登记它们会让几乎所有卡片都读取项目字体。
const SHARED_SCRIPTS = new Set(['Common', 'Zyyy', 'Inherited', 'Zinh', 'Qaai'])
const TEMPLATE_FAMILIES = new Set(['Inter', 'Noto Sans SC'])

/** 校验并解析项目字体登记；不合法时抛错（构建与测试即失败，不在线上静默跳过）。 */
export function resolveProjectShareCardFonts(
  fonts: readonly ProjectShareCardFont[],
): ResolvedShareCardFont[] {
  const seen = new Set<string>()
  return fonts.map((font) => {
    const name = font.name.trim()
    if (name === '' || /["'\\,;]/.test(name) || TEMPLATE_FAMILIES.has(name)) {
      throw new TypeError(`Invalid share card font name: ${JSON.stringify(font.name)}`)
    }
    if (!FILE_NAME.test(font.file) || font.file.includes('..')) {
      throw new TypeError(
        `Invalid share card font file: ${JSON.stringify(font.file)} (a .otf/.ttf/.woff file name under public/fonts/share-card/, without path separators)`,
      )
    }
    const weight = font.weight ?? 400
    if (weight !== 400 && weight !== 600) {
      throw new TypeError(`Invalid share card font weight for ${name}: ${String(weight)}`)
    }
    const key = `${name}@${weight}`
    if (seen.has(key)) throw new TypeError(`Duplicate share card font: ${key}`)
    seen.add(key)
    if (font.scripts.length === 0) throw new TypeError(`Share card font ${name} has no scripts`)
    for (const script of font.scripts) {
      if (!SCRIPT_NAME.test(script) || SHARED_SCRIPTS.has(script)) {
        throw new TypeError(`Invalid script for share card font ${name}: ${JSON.stringify(script)}`)
      }
    }
    let pattern: RegExp
    try {
      pattern = new RegExp(
        `[${font.scripts.map((script) => `\\p{Script=${script}}`).join('')}]`,
        'u',
      )
    } catch {
      throw new TypeError(
        `Unknown Unicode script for share card font ${name}: ${font.scripts.join(', ')}`,
      )
    }
    return { name, file: font.file, weight, scripts: [...font.scripts], pattern }
  })
}

/** 项目登记的回退字体；模块加载时校验。 */
export const projectFonts: readonly ResolvedShareCardFont[] =
  resolveProjectShareCardFonts(projectShareCardFonts)

/**
 * 字体登记的稳定指纹（族名、文件、字重、文字，不含字体字节）：进入卡片地址，登记变化时已缓存的卡片换新地址。
 * 没有项目字体时为空串，卡片地址与未接入本扩展点时相同。
 */
export function shareCardFontFingerprint(
  fonts: readonly ResolvedShareCardFont[] = projectFonts,
): string {
  if (fonts.length === 0) return ''
  return fnv1a(
    JSON.stringify(fonts.map((font) => [font.name, font.file, font.weight, font.scripts])),
  )
}
