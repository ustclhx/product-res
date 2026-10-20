import type { Database } from '@product-res/db'
import {
  AUDIT_SAMPLE_SIZE,
  type AuditActual,
  type AuditAgreement,
  accuracyKpis,
  auditWeekOf,
  generateAudit,
  getAuditItems,
  listAudits,
  saveAuditItem,
  submitAudit,
} from '@product-res/marketdata'

/**
 * 人工抽检页面（add-accuracy-store-tracking design D7 / D8）。抽检属于空间，经 scoped 访问；
 * 一致率与主值资格按部署级来源统计。
 */

const iso = (d: Date | null) => (d ? d.toISOString() : null)

/** 抽检标签页：选中的抽检（默认本周，没有则最近一次）、清单、历史与部署级一致率 */
export async function accuracyPage(
  db: Database,
  workspaceId: string,
  auditId?: string,
  now = new Date(),
) {
  const history = await listAudits(db, workspaceId)
  const thisWeek = auditWeekOf(now)
  const selected = auditId
    ? history.find((a) => a.id === auditId)
    : (history.find((a) => a.weekOf === thisWeek) ?? history[0])
  const items = selected ? await getAuditItems(db, workspaceId, selected.id) : []
  const kpis = await accuracyKpis(db)
  return {
    thisWeek,
    sampleSize: AUDIT_SAMPLE_SIZE,
    hasThisWeek: history.some((a) => a.weekOf === thisWeek),
    audit: selected
      ? {
          id: selected.id,
          weekOf: selected.weekOf,
          seed: selected.seed,
          status: selected.status,
          sampleSize: selected.sampleSize,
          shortfall: selected.sampling?.shortfall ?? null,
          submittedAt: iso(selected.submittedAt),
        }
      : null,
    items: items.map((item) => ({
      id: item.id,
      productId: item.productId,
      marketplace: item.marketplace,
      platformId: item.platformId,
      title: item.title,
      link: item.link,
      collected: item.collected,
      actual: item.actual,
      agreement: item.agreement,
      checkedAt: iso(item.checkedAt),
    })),
    history: history.map((a) => ({
      id: a.id,
      weekOf: a.weekOf,
      status: a.status,
      sampleSize: a.sampleSize,
      checked: a.checked,
      samples: a.samples,
      rate: a.rate,
    })),
    kpis,
  }
}

export async function generateNow(db: Database, workspaceId: string) {
  const { audit, created } = await generateAudit(db, workspaceId, { now: new Date() })
  return { auditId: audit.id, created }
}

export async function saveItem(
  db: Database,
  workspaceId: string,
  input: { itemId: string; actual: Record<string, unknown>; userId: string },
) {
  const row = await saveAuditItem(db, workspaceId, { ...input, now: new Date() })
  return {
    id: row.id,
    actual: row.actual as AuditActual | null,
    agreement: row.agreement as AuditAgreement | null,
    checkedAt: iso(row.checkedAt),
  }
}

export async function submit(
  db: Database,
  workspaceId: string,
  input: { auditId: string; userId: string },
) {
  const decisions = await submitAudit(db, workspaceId, { ...input, now: new Date() })
  return { disqualified: decisions.filter((d) => d.disqualified).length }
}
