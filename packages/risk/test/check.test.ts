import { describe, expect, it } from 'vitest'
import type { RiskInput } from '../src'
import { checkRisks } from '../src'

const base: RiskInput = {
  product: { platform: 'amazon', brand: 'Unbranded', title: 'Silicone kitchen spatula' },
  mode: 'same-source',
  brands: [],
  rules: [],
}
const types = (i: RiskInput) => checkRisks(i).findings.map((f) => f.type)

describe('checkRisks', () => {
  it('Unbranded 无品牌风险，仅有版权提示', () => {
    expect(types(base)).toEqual(['image-copyright'])
    expect(checkRisks(base).complianceScore).toBe(100)
  })

  it('新增品牌后标题命中品牌风险（同货源高、微改良中）', () => {
    const input = { ...base, product: { ...base.product, title: 'Acme spatula set' } }
    expect(types(input)).not.toContain('brand')
    const withBrand = { ...input, brands: [{ brand: 'Acme', kind: 'brand' as const }] }
    expect(checkRisks(withBrand).findings.find((x) => x.type === 'brand')?.level).toBe('high')
    const improved = checkRisks({ ...withBrand, mode: 'improved' })
    expect(improved.findings.find((x) => x.type === 'brand')?.level).toBe('medium')
  })

  it('品牌属性非通用即品牌风险', () => {
    expect(types({ ...base, product: { ...base.product, brand: 'Foo' } })).toContain('brand')
  })

  it('VeRO 命中高且否决，合规分 0', () => {
    const r = checkRisks({
      ...base,
      product: { ...base.product, title: 'Nike style shoe' },
      brands: [{ brand: 'Nike', kind: 'vero' }],
    })
    expect(r.findings.find((x) => x.type === 'vero')).toMatchObject({ level: 'high', veto: true })
    expect(r.complianceScore).toBe(0)
  })

  it('品牌备案 ASIN 直接跟卖否决并提示独立建 listing', () => {
    const r = checkRisks({ ...base, product: { ...base.product, brandRegistered: true } })
    const f = r.findings.find((x) => x.type === 'brand-registry')
    expect(f).toMatchObject({ level: 'high', veto: true })
    expect(f?.basis).toContain('同款独立建 listing 更安全')
    expect(r.complianceScore).toBe(0)
  })

  it('微改良新建 listing 不触发品牌备案否决', () => {
    const r = checkRisks({
      ...base,
      mode: 'improved',
      product: { ...base.product, brandRegistered: true },
    })
    expect(r.findings.map((f) => f.type)).not.toContain('brand-registry')
  })

  it('单一主卖家且有品牌店 → 外观专利提示带链接，不否决', () => {
    const r = checkRisks({
      ...base,
      product: { ...base.product, title: 'a b', mainSellerCount: 1, sellerHasBrandStore: true },
    })
    expect(r.findings.find((x) => x.type === 'design-patent')).toMatchObject({
      level: 'medium',
      veto: false,
      link: 'https://patents.google.com/?q=a%20b',
    })
    expect(r.complianceScore).toBe(80)
  })

  it('受限类目、认证、危险品规则按属性/类目/平台命中', () => {
    const input: RiskInput = {
      ...base,
      product: { ...base.product, categoryId: '123', attributes: ['battery', 'children'] },
      rules: [
        {
          type: 'restricted-category',
          match: { categoryIds: ['123'] },
          level: 'medium',
          note: '受限类目',
        },
        {
          type: 'certification',
          match: { attributes: ['children'] },
          level: 'medium',
          note: 'CPC/CPSIA',
        },
        {
          type: 'hazmat',
          match: { attributes: ['battery'], platform: 'amazon' },
          level: 'high',
          note: '危险品审核',
        },
        {
          type: 'hazmat',
          match: { attributes: ['battery'], platform: 'ebay' },
          level: 'high',
          note: '不应命中',
        },
      ],
    }
    expect(types(input)).toEqual([
      'restricted-category',
      'certification',
      'hazmat',
      'image-copyright',
    ])
  })

  it('物流禁运属性冲突', () => {
    const r = checkRisks({
      ...base,
      product: { ...base.product, attributes: ['liquid'] },
      shippingBans: ['liquid'],
    })
    expect(r.findings.find((x) => x.type === 'shipping-ban')?.level).toBe('high')
    expect(r.complianceScore).toBe(60)
  })
})
