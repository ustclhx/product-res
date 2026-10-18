import type { RiskFinding, RiskInput, RiskLevel, RiskResult } from './types'

/** 各等级扣分（合规分 = 100 − 扣分之和，下限 0）；info 只提示不扣分 */
export const LEVEL_PENALTY: Record<RiskLevel, number> = {
  high: 40,
  medium: 20,
  low: 5,
  info: 0,
}

const GENERIC_BRANDS = new Set(['unbranded', 'generic', 'no brand', 'n/a', ''])

const norm = (s: string) => s.trim().toLowerCase()

const hasWord = (text: string, word: string) => {
  const w = norm(word)
  if (!w) return false
  // 以非字母数字为边界，避免 “Acme” 误中 “Acmeish”
  const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(text)
}

export function patentSearchLink(keywords: string) {
  return `https://patents.google.com/?q=${encodeURIComponent(keywords)}`
}

export function checkRisks(input: RiskInput): RiskResult {
  const { product, mode, brands, rules } = input
  const findings: RiskFinding[] = []
  const title = norm(product.title)
  const brandAttr = norm(product.brand ?? '')
  const isGeneric = GENERIC_BRANDS.has(brandAttr)
  const sameSource = mode === 'same-source'

  const hits = brands.filter(
    (b) => (!isGeneric && norm(b.brand) === brandAttr) || hasWord(title, b.brand),
  )
  const veroHits = hits.filter((b) => b.kind === 'vero')
  const registeredHits = hits.filter((b) => b.kind === 'registered')

  // 品牌/商标：品牌属性非通用，或标题命中品牌库
  if (!isGeneric || hits.length > 0) {
    findings.push({
      type: 'brand',
      level: sameSource ? 'high' : 'medium',
      basis: isGeneric
        ? `标题命中品牌库：${hits.map((b) => b.brand).join('、')}`
        : `品牌属性为 ${product.brand}，非 Unbranded/Generic`,
      veto: false,
    })
  }

  if (veroHits.length > 0) {
    findings.push({
      type: 'vero',
      level: 'high',
      basis: `命中 VeRO 权利人：${veroHits.map((b) => b.brand).join('、')}`,
      veto: true,
    })
  }

  // 品牌备案只对“在他人现有 ASIN 下直接跟卖”否决；微改良新建 listing 不适用
  const onExisting = product.listingOnExistingAsin ?? sameSource
  if (
    product.platform === 'amazon' &&
    onExisting &&
    (product.brandRegistered || registeredHits.length > 0)
  ) {
    findings.push({
      type: 'brand-registry',
      level: 'high',
      basis: '品牌备案 ASIN 直接跟卖，同款独立建 listing 更安全',
      veto: true,
    })
  }

  if ((product.mainSellerCount ?? 0) === 1 && product.sellerHasBrandStore) {
    findings.push({
      type: 'design-patent',
      level: 'medium',
      basis: '同簇只有一个主卖家且为品牌店，可能有外观/设计专利，请人工检索',
      veto: false,
      link: patentSearchLink(product.title),
    })
  }

  const attrs = new Set((product.attributes ?? []).map(norm))
  for (const rule of rules) {
    if (rule.match.platform && rule.match.platform !== product.platform) continue
    const catHit =
      !!product.categoryId && (rule.match.categoryIds ?? []).includes(product.categoryId)
    const attrHit = (rule.match.attributes ?? []).some((a) => attrs.has(norm(a)))
    if (!catHit && !attrHit) continue
    findings.push({
      type: rule.type,
      level: rule.level,
      basis: rule.note,
      veto: rule.veto ?? false,
    })
  }

  for (const ban of input.shippingBans ?? []) {
    if (attrs.has(norm(ban))) {
      findings.push({
        type: 'shipping-ban',
        level: 'high',
        basis: `物流方案禁运属性：${ban}，该方案不可用`,
        veto: false,
      })
    }
  }

  findings.push({
    type: 'image-copyright',
    level: 'info',
    basis: '请使用自拍或供应商授权的图片与文案',
    veto: false,
  })

  const veto = findings.some((f) => f.veto)
  const penalty = findings.reduce((n, f) => n + LEVEL_PENALTY[f.level], 0)
  return { findings, complianceScore: veto ? 0 : Math.max(0, 100 - penalty) }
}
