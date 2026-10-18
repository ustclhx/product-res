import { linkOptions } from '@tanstack/react-router'
import { templateConfig } from '../../server/template-config.ts'
import { ADMIN_COPY } from './copy.ts'

/**
 * 后台侧栏导航（add-admin-console tasks.md 1.3）。新增后台页面时在对应分组里加一项；
 * 列表页的分页与筛选放在 search 参数中，入口链接从第一页开始。
 * 标签统一取自 ADMIN_COPY，按请求语言显示。
 */
const list = { includeSearch: false } as const
function groups() {
  const { nav } = ADMIN_COPY
  return [
    {
      id: 'overview',
      label: null,
      items: linkOptions([{ to: '/admin', label: nav.overview, activeOptions: { exact: true } }]),
    },
    {
      id: 'people',
      label: nav.groups.people,
      items: linkOptions([
        { to: '/admin/users', search: { offset: 0 }, label: nav.users, activeOptions: list },
        {
          to: '/admin/workspaces',
          search: { offset: 0 },
          label: nav.workspaces,
          activeOptions: list,
        },
        { to: '/admin/credits', search: { offset: 0 }, label: nav.credits, activeOptions: list },
        ...(templateConfig.features.waitlist
          ? [
              {
                to: '/admin/waitlist' as const,
                search: { offset: 0 },
                label: nav.waitlist,
                activeOptions: list,
              },
            ]
          : []),
      ]),
    },
    {
      id: 'billing',
      label: nav.groups.billing,
      items: linkOptions([
        {
          to: '/admin/billing',
          search: { offset: 0 },
          label: nav.payments,
          activeOptions: { exact: true, includeSearch: false },
        },
        {
          to: '/admin/billing/subscriptions',
          search: { offset: 0 },
          label: nav.subscriptions,
          activeOptions: list,
        },
        {
          to: '/admin/billing/purchases',
          search: { offset: 0 },
          label: nav.purchases,
          activeOptions: list,
        },
        {
          to: '/admin/billing/refunds',
          search: { offset: 0 },
          label: nav.refunds,
          activeOptions: list,
        },
        {
          to: '/admin/billing/plans',
          search: { offset: 0 },
          label: nav.plans,
          activeOptions: list,
        },
        {
          to: '/admin/billing/webhooks',
          search: { offset: 0 },
          label: nav.webhooks,
          activeOptions: list,
        },
      ]),
    },
    {
      id: 'ai',
      label: nav.groups.ai,
      items: linkOptions([
        { to: '/admin/models', search: { offset: 0 }, label: nav.models, activeOptions: list },
      ]),
    },
    {
      id: 'operations',
      label: nav.groups.operations,
      items: linkOptions([
        { to: '/admin/metrics', search: { offset: 0 }, label: nav.metrics, activeOptions: list },
        { to: '/admin/audit', search: { offset: 0 }, label: nav.audit, activeOptions: list },
        { to: '/admin/settings', label: nav.settings },
      ]),
    },
  ]
}

function enabled(to: string) {
  if (to.startsWith('/admin/billing')) return templateConfig.billing.enabled
  if (to === '/admin/models') return templateConfig.billing.enabled
  if (to === '/admin/credits') return templateConfig.credits.enabled
  return true
}

/** 按模板开关过滤后的分组导航；整组都被关闭时不显示组标题 */
export const getAdminNavGroups = () =>
  groups()
    .map((group) => ({ ...group, items: group.items.filter((item) => enabled(item.to)) }))
    .filter((group) => group.items.length > 0)

/** 扁平导航（概览页快捷入口等复用） */
export const getAdminNav = () => getAdminNavGroups().flatMap((group) => group.items)
