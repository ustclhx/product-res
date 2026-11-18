import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { m } from '../../paraglide/messages.js'
import { baseLocale, overwriteGetLocale } from '../../paraglide/runtime.js'
import { AppShellBarContext } from '../app-shell/bar.tsx'
import {
  type BalanceSubscription,
  type BillingCreditSummary,
  BillingPageTitle,
  billingSections,
  CreditBalance,
  dailyNoticeState,
  defaultProvider,
  entitlementPlanName,
  formatBillingDate,
  subscriptionCreditsNote,
} from './billing-sections.tsx'

beforeEach(() => overwriteGetLocale(() => baseLocale))
afterEach(() => overwriteGetLocale(() => baseLocale))

const plans = [
  { id: 'sub', type: 'subscription' as const },
  { id: 'pack', type: 'credit_pack' as const },
]
const price = (planId: string, provider = 'stripe', active = true) => ({ planId, provider, active })
const summary: BillingCreditSummary = {
  subscription: { total: 800, currentPeriod: 800 },
  purchase: 400,
  free: { signup: 50, daily: 10, total: 60 },
  other: 0,
  available: 1260,
}
const noFree = { ...summary, free: { signup: 0, daily: 0, total: 0 } }
const monthly: BalanceSubscription = {
  planCredits: 1000,
  interval: 'month',
  ending: false,
  periodEnd: '2026-12-10T00:00:00Z',
}

function balance(props: {
  summary?: BillingCreditSummary
  subscription?: BalanceSubscription | null
  freeRows?: { signup: boolean; daily: boolean }
  sections?: { subscription: boolean; packs: boolean; free: boolean }
  daily?: Parameters<typeof CreditBalance>[0]['daily']
}) {
  return renderToStaticMarkup(
    <CreditBalance
      summary={props.summary ?? summary}
      sections={props.sections ?? { subscription: true, packs: true, free: true }}
      subscription={props.subscription === undefined ? monthly : props.subscription}
      packExpiry={null}
      daily={props.daily ?? null}
      freeRows={props.freeRows ?? { signup: true, daily: true }}
    />,
  )
}

describe('账单页分区（add-ui-design-system 8.7）', () => {
  it('分区按生效价格与持有记录渲染', () => {
    expect(
      billingSections({
        plans,
        prices: [price('sub'), price('pack')],
        subscriptionCount: 0,
        summary,
        freeConfigured: true,
      }),
    ).toEqual({ subscription: true, packs: true, free: true })
    expect(
      billingSections({
        plans,
        prices: [price('pack')],
        subscriptionCount: 0,
        summary: noFree,
        freeConfigured: false,
      }),
    ).toEqual({ subscription: false, packs: true, free: false })
    // 失效价格不算数据来源
    expect(
      billingSections({
        plans,
        prices: [price('sub', 'stripe', false), price('pack', 'stripe', false)],
        subscriptionCount: 0,
        summary: { ...noFree, purchase: 0 },
        freeConfigured: false,
      }),
    ).toEqual({ subscription: false, packs: false, free: false })
    // 已有订阅或已持有积分包 / 免费积分时，即使目录下架也保留对应分区
    expect(
      billingSections({
        plans: [],
        prices: [],
        subscriptionCount: 1,
        summary,
        freeConfigured: false,
      }),
    ).toEqual({ subscription: true, packs: true, free: true })
  })

  it('默认支付方式取可用且有生效价格的渠道', () => {
    const providers = [
      { id: 'stripe', available: true },
      { id: 'paypal', available: true },
    ]
    expect(defaultProvider(providers, [price('sub', 'paypal')])).toBe('paypal')
    expect(
      defaultProvider(providers, [price('sub', 'stripe', false), price('sub', 'paypal')]),
    ).toBe('paypal')
    // 有价格的渠道都不可用时仍选有价格的渠道，让购买区显示并给出不可用说明
    expect(
      defaultProvider(
        [
          { id: 'stripe', available: true },
          { id: 'paypal', available: false },
        ],
        [price('sub', 'paypal')],
      ),
    ).toBe('paypal')
    expect(defaultProvider(providers, [])).toBe('stripe')
  })

  it('订阅积分卡：月付显示重置日，取消中显示结束日，年付按月发放不显示续费日', () => {
    // 期望文案取自 m.*：衍生项目默认语言可能为 zh，不能写死英文
    const date = formatBillingDate(monthly.periodEnd)
    expect(subscriptionCreditsNote(monthly)).toBe(m.billing_page_sub_resets({ date }))
    expect(subscriptionCreditsNote({ ...monthly, ending: true })).toBe(
      m.billing_page_sub_ends({ date }),
    )
    expect(subscriptionCreditsNote({ ...monthly, interval: 'year' })).toBe(
      m.billing_page_sub_monthly_grant(),
    )
    expect(subscriptionCreditsNote(null)).toBeNull()
  })

  it('余额只渲染有来源的分区卡片，未订阅时不显示进度与不结转说明', () => {
    const all = balance({})
    expect(all).toContain(m.billing_page_sub_credits())
    expect(all).toContain('aria-valuenow="80"')
    expect(all).toContain(m.billing_page_pack_credits())
    expect(all).toContain(m.billing_page_free_credits())
    const free = balance({ subscription: null })
    expect(free).not.toContain('role="progressbar"')
    expect(free).not.toContain(m.billing_page_sub_no_rollover())
    expect(free).toContain(m.billing_page_sub_hint())
    const packsOnly = balance({
      summary: noFree,
      sections: { subscription: false, packs: true, free: false },
    })
    expect(packsOnly).toContain(m.billing_page_pack_credits())
    expect(packsOnly).not.toContain(m.billing_page_sub_credits())
    expect(packsOnly).not.toContain(m.billing_page_free_credits())
  })

  it('多个付费周期重叠、本期剩余超过套餐额度时不显示分母与进度', () => {
    const html = balance({
      summary: { ...summary, subscription: { total: 1500, currentPeriod: 1500 } },
    })
    expect(html).not.toContain('role="progressbar"')
    expect(html).not.toContain('/ 1,000')
  })

  it('免费积分明细按配置或余额显示，今日已领从 daily 余额推导', () => {
    const signupOnly = balance({
      summary: { ...summary, free: { signup: 50, daily: 0, total: 50 } },
      freeRows: { signup: true, daily: false },
      daily: { status: 'cached' },
    })
    expect(signupOnly).toContain(m.billing_page_signup())
    expect(signupOnly).not.toContain(m.billing_page_daily())
    expect(signupOnly).not.toContain(m.billing_page_daily_claimed())
    const cached = balance({ daily: { status: 'cached' } })
    expect(cached).toContain(m.billing_page_daily_claimed())
  })

  it('每日领取提示只展示状态：已领取、本月上限、待验证，其他情况不显示', () => {
    expect(dailyNoticeState({ status: 'cached' }, 10)?.status).toBe('claimed')
    expect(dailyNoticeState({ status: 'already_claimed' }, 0)?.status).toBe('claimed')
    expect(dailyNoticeState({ status: 'monthly_limit' }, 0)).toMatchObject({
      status: 'available',
      title: m.billing_page_daily_limit(),
    })
    expect(dailyNoticeState({ status: 'unverified' }, 0)?.title).toBe(m.billing_page_daily_verify())
    expect(dailyNoticeState({ status: 'cached' }, 0)).toBeNull()
    expect(dailyNoticeState(null, 0)).toBeNull()
    const html = balance({ daily: { status: 'cached' } })
    expect(html).toContain('data-status="claimed"')
    // 没有领取 server function，不渲染领取按钮
    expect(html).not.toContain('Claim today&#x27;s credits')
  })

  it('页面主标题：工作台顶部条可用时不重复，顶部布局下渲染 h1', () => {
    expect(renderToStaticMarkup(<BillingPageTitle />)).toContain(
      `<h1 class="font-semibold text-display">${m.billing_page_title()}</h1>`,
    )
    const inShell = renderToStaticMarkup(
      <AppShellBarContext.Provider value={{ title: null, actions: null, progress: null }}>
        <BillingPageTitle />
      </AppShellBarContext.Provider>,
    )
    expect(inShell).not.toContain('<h1')
  })

  it('当前套餐显示套餐名而不是权益 key：含已下架套餐与未落库的免费兜底', () => {
    const catalog = [{ key: 'plus', name: 'Plus 会员' }]
    expect(entitlementPlanName({ key: 'plus', name: 'Plus 会员' }, [])).toBe('Plus 会员')
    expect(entitlementPlanName({ key: 'plus' }, catalog)).toBe('Plus 会员')
    expect(entitlementPlanName({ key: 'free' }, catalog)).toBe(m.billing_page_free_plan())
    expect(entitlementPlanName({ key: 'legacy' }, catalog)).toBe('legacy')
  })
})
