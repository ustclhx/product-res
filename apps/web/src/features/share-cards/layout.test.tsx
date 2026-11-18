import { shareCardThemes } from '@product-res/ui/share-card-theme'
import type { ReactElement, ReactNode } from 'react'
import { isValidElement } from 'react'
import { describe, expect, it } from 'vitest'
import { templateConfig } from '../../server/template-config.ts'
import { staticPage } from '../seo/metadata.ts'
import {
  defaultShareCardLayout,
  metaLimit,
  sampleShareCardLayout,
  shareCardLayout,
  titleWeight,
} from './layout.tsx'
import { collectText } from './renderer.ts'
import { defaultShareCardSite } from './site.ts'
import {
  countLines,
  keepsWords,
  needsFallbackFont,
  sanitizeText,
  textWidth,
  truncateText,
} from './text.ts'
import { resolveShareCardTheme } from './theme.ts'

type Style = Record<string, unknown>
type Node = ReactElement<{ style?: Style; children?: ReactNode }>

/** 深度优先列出元素树中的全部元素。 */
function elements(node: ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<{ style?: Style; children?: ReactNode }>(node)) return []
  return [node, ...elements(node.props.children)]
}

function withText(tree: ReactNode, text: string): Node {
  const found = elements(tree).find((node) => node.props.children === text)
  if (!found) throw new Error(`missing ${text}`)
  return found
}

const light = shareCardThemes.light
// 生成器会改名与改域名，断言从项目配置推导，不写死模板默认值。
const brandInitial = (Array.from(templateConfig.app.name)[0] ?? '').toUpperCase()
const brandHost = new URL(templateConfig.app.url).host
const zh = {
  title: '2026 年第三季度用户调研要点',
  description: '新用户留存提升 12%，主要来自引导流程简化；移动端满意度仍低于桌面端。',
  label: '报告摘要',
  meta: '5 条结论 · 3 个风险',
}

describe('分享卡片版式（4.2）', () => {
  it('示例类型用固定数据得到设计稿的版式树，颜色来自主题 token', () => {
    const tree = sampleShareCardLayout(zh, resolveShareCardTheme('light'))
    const root = tree as Node
    expect(root.props.style).toMatchObject({
      width: 1200,
      height: 630,
      display: 'flex',
      flexDirection: 'column',
      padding: '64px 72px',
      background: light.background,
      color: light.foreground,
    })
    expect(withText(tree, zh.title).props.style).toMatchObject({ fontSize: 60, fontWeight: 400 })
    expect(withText(tree, zh.description).props.style).toMatchObject({
      fontSize: 28,
      color: light.mutedForeground,
    })
    expect(withText(tree, zh.label).props.style).toMatchObject({
      height: 44,
      background: light.secondary,
      color: light.mutedForeground,
    })
    expect(withText(tree, brandInitial).props.style).toMatchObject({
      width: 52,
      borderRadius: light.radius + 4,
      background: light.primary,
      color: light.primaryForeground,
    })
    expect(withText(tree, brandHost).props.style).toMatchObject({ color: light.foreground })
    const footer = elements(tree).find((node) => node.props.style?.borderTop)
    expect(footer?.props.style?.borderTop).toBe(`1px solid ${light.border}`)
    expect(elements(tree).some((node) => node.props.style?.background === light.brandAccent)).toBe(
      true,
    )
    expect(collectText(tree)).toContain(templateConfig.app.name)
  })

  it('深色主题替换全部颜色，没有写死的颜色', () => {
    const dark = shareCardThemes.dark
    const tree = sampleShareCardLayout(zh, resolveShareCardTheme('dark'))
    const allowed = new Set(Object.values(dark).filter((value) => typeof value === 'string'))
    for (const node of elements(tree)) {
      for (const key of ['background', 'color'] as const) {
        const value = node.props.style?.[key]
        if (value !== undefined) expect(allowed.has(value as string), `${key}: ${value}`).toBe(true)
      }
    }
    expect((tree as Node).props.style?.background).toBe(dark.background)
  })

  it('默认版式（构建期分享图）用大标题、无标签与摘要', () => {
    const tree = defaultShareCardLayout('定价与套餐', resolveShareCardTheme('light'))
    expect(withText(tree, '定价与套餐').props.style).toMatchObject({ fontSize: 76, maxHeight: 184 })
    // 副标题取默认语言首页的 SEO 标题，不再写死英文
    const tagline = staticPage('/', templateConfig.i18n.defaultLocale).title
    expect(collectText(tree)).toContain(`${templateConfig.app.name} · ${tagline}`)
    expect(elements(tree).some((node) => node.props.style?.height === 44)).toBe(false)
  })

  it('默认分享图副标题跟随页面语言', () => {
    const tree = defaultShareCardLayout('定价与套餐', light, defaultShareCardSite('zh'))
    expect(collectText(tree)).toContain(
      `${templateConfig.app.name} · ${staticPage('/', 'zh').title}`,
    )
  })

  it('未提供品牌与域名时与模板配置一致；提供时替换品牌行、首字与域名', () => {
    const plain = collectText(shareCardLayout({ title: 'Report' }, light))
    expect(plain).toBe(`${brandInitial}${templateConfig.app.name}Report${brandHost}`)
    const branded = collectText(
      shareCardLayout(
        { title: 'Report', brand: { name: 'Arcanumber', initial: 'A' }, host: 'arcanumber.com' },
        light,
      ),
    )
    expect(branded).toBe('AArcanumberReportarcanumber.com')
  })

  it('超长标题与摘要按字宽加权截断并以省略号结尾', () => {
    const long =
      '面向中小团队的跨部门协作流程梳理：从需求收集、优先级评估到交付复盘的完整实践记录与改进建议'
    const tree = shareCardLayout({ title: long, summary: long.repeat(2) }, light)
    const texts = elements(tree).map((node) => node.props.children)
    const title = texts.find((text) => typeof text === 'string' && text.startsWith('面向中小'))
    expect(title).toBe(`${[...long].slice(0, 27).join('')}…`)
    expect(textWidth(title as string)).toBeLessThanOrEqual(28)
  })
})

function titleOf(tree: ReactNode, prefix: string): string {
  const found = elements(tree)
    .map((node) => node.props.children)
    .find((text): text is string => typeof text === 'string' && text.startsWith(prefix))
  if (!found) throw new Error(`missing ${prefix}`)
  return found
}

describe('标题截断保证两行内且省略号可见', () => {
  // 内容区 1056px；不留余量地按字号换算每行容量，独立于版式内部的 5% 余量
  const capacity = (fontSize: number) => 1056 / fontSize

  for (const [name, title, prefix] of [
    [
      '英文长标题',
      'How We Rebuilt Our Onboarding Workflow With Agents And Halved Churn In Months',
      'How We',
    ],
    ['全大写标题', 'WORKSPACE MANAGEMENT AND BILLING OVERVIEW FOR ENTERPRISE TEAMS', 'WORKSPACE'],
    ['28 字中文标题', '面向中小团队的跨部门协作流程梳理从需求收集到交付复盘的实践', '面向中小'],
  ] as const) {
    it(`大标题：${name}`, () => {
      const text = titleOf(defaultShareCardLayout(title, light), prefix)
      expect(text.endsWith('…')).toBe(true)
      expect(countLines(text, capacity(76))).toBeLessThanOrEqual(2)
      // 拉丁截断退回到词边界：省略号前是完整单词
      if (!/[\u4e00-\u9fff]/.test(text)) {
        const words = text.slice(0, -1).split(' ')
        expect(title.split(' ')).toEqual(expect.arrayContaining(words))
      }
    })
  }

  it('卡片标题按 28 上限与两行同时约束', () => {
    const title = 'Quarterly product research highlights covering onboarding retention and pricing'
    const text = titleOf(shareCardLayout({ title }, light), 'Quarterly')
    expect(text.endsWith('…')).toBe(true)
    expect(textWidth(text)).toBeLessThanOrEqual(28)
    expect(countLines(text, capacity(60))).toBeLessThanOrEqual(2)
  })

  it('标题与摘要以 satori lineClamp 兜底', () => {
    const tree = sampleShareCardLayout(zh, light)
    expect(withText(tree, zh.title).props.style).toMatchObject({ display: 'block', lineClamp: 2 })
    expect(withText(tree, zh.description).props.style).toMatchObject({ lineClamp: 2 })
  })

  it('底部元信息可收缩，域名不收缩', () => {
    const meta = 'A very long meta line that would otherwise overlap the domain on the right'
    const tree = shareCardLayout({ title: 't', meta }, light)
    const metaNode = elements(tree).find(
      (node) => typeof node.props.children === 'string' && node.props.children.startsWith('A very'),
    )
    expect(metaNode?.props.style).toMatchObject({
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    })
    expect(textWidth(metaNode?.props.children as string)).toBeLessThanOrEqual(28)
    // 先序遍历中最后一个包含域名的元素即域名所在的那一行
    const domain = elements(tree)
      .filter((node) =>
        elements(node.props.children).some((child) => child.props.children === brandHost),
      )
      .at(-1)
    expect(domain?.props.style).toMatchObject({ flexShrink: 0 })
  })
})

describe('韩文（0.5.0：xuanxue 反馈）', () => {
  const capacity = (fontSize: number) => 1056 / fontSize
  const metaOf = (tree: ReactNode, prefix: string) => {
    const node = elements(tree).find(
      (element) =>
        typeof element.props.children === 'string' && element.props.children.startsWith(prefix),
    )
    if (!node) throw new Error(`missing ${prefix}`)
    return node
  }

  it('只有谚文（不含汉字、假名）按词断行；中日文与拉丁保持原断行规则', () => {
    expect(keepsWords('자주 묻는 질문: 크레딧, 환불, 개인정보')).toBe(true)
    expect(keepsWords('AI 리포트 2026')).toBe(true)
    expect(keepsWords('万年历与八字')).toBe(false)
    expect(keepsWords('レポート')).toBe(false)
    expect(keepsWords('Quarterly report')).toBe(false)
    // 韩汉混排仍逐字可断，保持中文断行不变
    expect(keepsWords('大韓民國 헌법')).toBe(false)
  })

  it('韩文标题与摘要设置 keep-all，其余标题不带 wordBreak（版式与之前相同）', () => {
    const ko = '자주 묻는 질문: 크레딧, 환불, 개인정보'
    expect(withText(defaultShareCardLayout(ko, light), ko).props.style).toMatchObject({
      wordBreak: 'keep-all',
    })
    const summary = '크레딧 사용 내역과 환불 기준을 안내합니다.'
    const card = sampleShareCardLayout(
      { title: ko, description: summary, label: '', meta: '' },
      light,
    )
    expect(withText(card, summary).props.style).toMatchObject({ wordBreak: 'keep-all' })
    for (const title of ['万年历', 'Pricing', zh.title]) {
      const style = withText(defaultShareCardLayout(title, light), title).props.style ?? {}
      expect(style).not.toHaveProperty('wordBreak')
    }
  })

  it('keep-all 下换行模拟不在音节之间断开；没有断点的长词就地断开', () => {
    // 逐字可断时「나다」留在第一行；按词断行时整个词移到下一行，超长部分再断开
    expect(countLines('가 나다라마바사', 4, false)).toBe(2)
    expect(countLines('가 나다라마바사', 4, true)).toBe(3)
    expect(countLines('가 나다라마바사', 4)).toBe(3)
    // 中文与拉丁的结果不随参数默认值变化
    expect(countLines('面向中小团队的协作', 4)).toBe(countLines('面向中小团队的协作', 4, false))
  })

  it('截断后的韩文长标题在 keep-all 下仍不超过两行', () => {
    const title = '자주 묻는 질문: 크레딧 충전, 환불 정책, 개인정보 처리방침과 계정 삭제 절차 안내'
    const text = titleOf(defaultShareCardLayout(title, light), '자주')
    expect(text.endsWith('…')).toBe(true)
    expect(countLines(text, capacity(76), true)).toBeLessThanOrEqual(2)
    const card = titleOf(shareCardLayout({ title }, light), '자주')
    expect(countLines(card, capacity(60), true)).toBeLessThanOrEqual(2)
  })

  it('元信息完整显示或在字素边界以省略号截断，盒子占满域名左侧不按测量宽度裁切', () => {
    const host = 'ganjiday.com'
    // 反馈中的副标题：加权宽度远低于上限，应完整保留
    const reported = '간지데이 · 무료 만세력·사주·타로'
    const shown = metaOf(
      defaultShareCardLayout('만세력', light, {
        ...defaultShareCardSite(),
        brand: { name: '간지데이' },
        host,
        tagline: '무료 만세력·사주·타로',
      }),
      '간지데이 ·',
    )
    expect(shown.props.children).toBe(reported)
    expect(shown.props.style).toMatchObject({
      flexGrow: 1,
      overflow: 'hidden',
      whiteSpace: 'nowrap',
    })

    const long = `${reported} · 궁합 · 오늘의 운세 · 꿈해몽 · 작명 · 택일 · 토정비결`
    const cut = metaOf(shareCardLayout({ title: 't', meta: long, host }, light), '간지데이 ·').props
      .children as string
    expect(cut.endsWith('…')).toBe(true)
    expect(long.startsWith(cut.slice(0, -1))).toBe(true)
    expect(textWidth(cut)).toBeLessThanOrEqual(metaLimit(host))
  })

  it('域名很长时元信息上限随底部行剩余宽度收紧', () => {
    expect(metaLimit('ganjiday.com')).toBe(28)
    const longHost = `${'very-long-subdomain-name.'.repeat(2)}example.com`
    expect(metaLimit(longHost)).toBeLessThan(28)
    // 元信息 + 域名 + 圆点与间距不超过内容区宽度
    expect(metaLimit(longHost) * 24 + textWidth(longHost) * 24 + 48).toBeLessThanOrEqual(1056)
  })
})

describe('字宽加权截断', () => {
  it('CJK 记 1、拉丁小写 0.6、大写 0.72、空格 0.3', () => {
    expect(textWidth('中文')).toBe(2)
    expect(textWidth('ab')).toBeCloseTo(1.2)
    expect(textWidth('AB')).toBeCloseTo(1.44)
    expect(textWidth('a b')).toBeCloseTo(1.5)
  })

  it('拉丁文本退回到词边界，不留下悬空标点', () => {
    const en = 'Q3 2026 user research highlights and next steps for the onboarding team'
    const cut = truncateText(en, 28)
    expect(en.startsWith(cut.slice(0, -1))).toBe(true)
    expect(en[cut.length - 1]).toMatch(/[ ]/)
    expect(textWidth(cut)).toBeLessThanOrEqual(28)
    expect(truncateText('Hello, world and more words here', 6)).toBe('Hello…')
    expect(truncateText('短标题', 28)).toBe('短标题')
    expect(truncateText('  多余   空白 ', 28)).toBe('多余 空白')
  })
})

describe('emoji 与回退字体', () => {
  it('去掉 emoji、ZWJ、变体选择符、肤色与旗帜', () => {
    expect(sanitizeText('Launch 🚀 day 👩‍💻 team 🇯🇵 ok 👍🏽 ❤️ 1️⃣')).toBe('Launch day team ok 1')
    expect(sanitizeText('发布日 🎉 回顾 👨‍👩‍👧')).toBe('发布日 回顾')
  })

  it('截断不会留下悬空的 ZWJ 或半个 emoji', () => {
    const cut = truncateText(`Team ${'👨‍👩‍👧‍👦'.repeat(20)} recap with many more words`, 8)
    expect(cut).not.toMatch(/[\u200d\ufe0f]|\p{Extended_Pictographic}/u)
    expect(cut.endsWith('…')).toBe(true)
  })

  it('Inter Latin 子集之外的字符需要 Noto 回退；谚文与泰文不触发', () => {
    expect(needsFallbackFont('Report')).toBe(false)
    expect(needsFallbackFont('Café crème — “quoted” €5')).toBe(false)
    expect(needsFallbackFont('Report 报告')).toBe(true)
    expect(needsFallbackFont('レポート')).toBe(true)
    expect(needsFallbackFont('Привет')).toBe(true)
    expect(needsFallbackFont('Γειά')).toBe(true)
    expect(needsFallbackFont('보고서')).toBe(false)
    expect(needsFallbackFont('ภาษาไทย')).toBe(false)
    expect(needsFallbackFont('Launch 🚀')).toBe(false)
  })

  it('两种字体都缺字的带附加符号字母降级为基本字母', () => {
    expect(sanitizeText('Ąžuolas Γειά')).toBe('Azuolas Γεια')
    // 拼音声调字母 Noto 有字形，保持不变
    expect(sanitizeText('Zhōngwén ǎ')).toBe('Zhōngwén ǎ')
  })
})

describe('标题字重', () => {
  it('含 CJK 或需要 Noto 的字符时整行 400，纯拉丁 600', () => {
    expect(titleWeight('Q3 2026 user research highlights')).toBe(600)
    expect(titleWeight('Café crème')).toBe(600)
    expect(titleWeight('用 Agents 重建 Onboarding')).toBe(400)
    expect(titleWeight('Привет мир')).toBe(400)
    expect(titleWeight('Launch 🚀')).toBe(600)
  })

  it('卡片与大标题都应用同一规则', () => {
    const mixed = '用 Agents 重建工作流'
    expect(withText(defaultShareCardLayout(mixed, light), mixed).props.style).toMatchObject({
      fontSize: 76,
      fontWeight: 400,
    })
    expect(withText(defaultShareCardLayout('Pricing', light), 'Pricing').props.style).toMatchObject(
      {
        fontWeight: 600,
      },
    )
    expect(withText(shareCardLayout({ title: mixed }, light), mixed).props.style).toMatchObject({
      fontSize: 60,
      fontWeight: 400,
    })
  })
})
