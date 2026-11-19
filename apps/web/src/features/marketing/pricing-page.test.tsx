import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { examplePricingCatalog } from '../../../scripts/pricing-snapshot.ts'
import { m } from '../../paraglide/messages.js'
import { baseLocale, overwriteGetLocale } from '../../paraglide/runtime.js'
import {
  groupPricingPlans,
  marketingPlans,
  type PricingPlan,
  packExpiryDays,
  planPrice,
  subscriptionDisplayPrice,
  yearlySavings,
} from './pricing-data.ts'
import { PricingGroups, PricingHero, pricingKind } from './pricing-page.tsx'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))

beforeEach(() => overwriteGetLocale(() => baseLocale))
afterEach(() => overwriteGetLocale(() => baseLocale))

const plans = marketingPlans(examplePricingCatalog())
const subscriptions = plans.filter((plan) => plan.type === 'subscription')
const packs = plans.filter((plan) => plan.type === 'credit_pack')
const render = (input: readonly PricingPlan[], interval: 'month' | 'year' = 'month') =>
  renderToStaticMarkup(
    <PricingGroups
      groups={groupPricingPlans(input)}
      paymentsAvailable
      initialInterval={interval}
    />,
  )

describe('定价页订阅与积分包并列（add-ui-design-system 8.7）', () => {
  it('两组并存时同时显示订阅、积分包与只作用于订阅的周期切换', () => {
    const html = render(plans)
    expect(html).toContain(m.pricing_page_subscriptions())
    expect(html).toContain(m.pricing_page_packs())
    expect(html).toContain(`<legend class="sr-only">${m.pricing_page_cycle()}</legend>`)
    expect(html).toContain(m.pricing_page_pack_order())
  })

  it('切换年付只改变订阅价格，积分包价格不变', () => {
    const pro = subscriptions.find((plan) => plan.key === 'pro')
    const pack = packs[0]
    if (!pro || !pack) throw new Error('示例目录缺少订阅或积分包')
    expect(planPrice(pro, 'month')?.amount).toBe(1900)
    expect(planPrice(pro, 'year')?.amount).toBe(19000)
    expect(planPrice(pack, 'month')).toEqual(planPrice(pack, 'year'))
    const monthly = render(plans, 'month')
    const yearly = render(plans, 'year')
    expect(monthly).toContain('$19<')
    expect(yearly).toContain('$190<')
    expect(yearly).not.toContain('$19<')
    expect(monthly).toContain('$10<')
    expect(yearly).toContain('$10<')
  })

  it('只有积分包时不显示周期切换与订阅组', () => {
    const html = render(packs)
    expect(html).toContain(m.pricing_page_packs())
    expect(html).not.toContain(m.pricing_page_subscriptions())
    expect(html).not.toContain(m.pricing_page_cycle())
    // 不按“月付”字样断言：zh 的积分包说明文案本身含“月付/年付”，改为断言切换控件未渲染
    expect(html).not.toContain('<fieldset')
    expect(html).not.toContain('aria-pressed')
    expect(html).not.toContain(m.pricing_page_pack_order())
  })

  it('只有订阅时保持订阅组与周期切换，不显示积分包组', () => {
    const html = render(subscriptions)
    expect(html).toContain(m.pricing_page_cycle())
    expect(html).not.toContain(m.pricing_page_packs())
  })

  it('首屏标题随套餐分组变化', () => {
    const hero = (input: readonly PricingPlan[]) =>
      renderToStaticMarkup(<PricingHero kind={pricingKind(groupPricingPlans(input))} />)
    expect(hero(plans)).toContain(m.pricing_page_title())
    expect(hero(subscriptions)).toContain(m.pricing_page_title_subscriptions())
    expect(hero(packs)).toContain(m.pricing_page_title_packs())
  })

  it('没有任何套餐时显示空状态；支付不可用时给出说明', () => {
    expect(render([])).toContain(m.pricing_page_empty_title())
    const html = renderToStaticMarkup(
      <PricingGroups groups={groupPricingPlans(plans)} paymentsAvailable={false} />,
    )
    expect(html).toContain(m.pricing_page_payments_unavailable())
  })

  it('推荐套餐有徽章与强调边框，CTA 文案简短、套餐名放在无障碍名称中', () => {
    const html = render(plans)
    expect(html).toContain(m.pricing_page_recommended())
    expect(html).toContain('ring-primary')
    expect(html).toContain(
      `aria-label="${m.pricing_page_subscribe_label({ name: 'Pro (template example)' })}"`,
    )
    expect(html).toContain(`>${m.pricing_page_subscribe()}</a>`)
  })

  it('年付模式下只有月价的订阅回退显示月价并说明', () => {
    const pro = subscriptions.find((plan) => plan.key === 'pro')
    if (!pro) throw new Error('示例目录缺少 Pro')
    const monthlyOnly: PricingPlan = {
      ...pro,
      key: 'monthly-only',
      name: 'Monthly only',
      highlighted: false,
      prices: [{ interval: 'month', amount: 900, currency: 'USD' }],
    }
    expect(subscriptionDisplayPrice(monthlyOnly, 'year')).toMatchObject({
      interval: 'month',
      monthlyOnly: true,
    })
    const html = render([...subscriptions, monthlyOnly], 'year')
    expect(html).toContain('$9<')
    expect(html).toContain(m.pricing_page_note_monthly_only())
  })

  it('年付节省比例各套餐不同时显示「最高省」，积分包有效期来自套餐数据', () => {
    expect(yearlySavings(subscriptions)).toEqual({ max: 17, uniform: true })
    const varied = [
      ...subscriptions,
      {
        prices: [
          { interval: 'month' as const, amount: 1000, currency: 'USD' },
          { interval: 'year' as const, amount: 9000, currency: 'USD' },
        ],
      },
    ]
    expect(yearlySavings(varied)).toEqual({ max: 25, uniform: false })
    expect(packExpiryDays(packs)).toBe(365)
    expect(packExpiryDays([{ creditExpiryDays: null }])).toBeNull()
  })
})
