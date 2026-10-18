import { newId } from '@product-res/shared'
import { cluster, createDb, direction, lead, organization, scoped } from '../src/index.ts'

/** 新空间 + 方向 + 簇 + 线索，供各领域表的隔离测试复用 */
export async function seedLead(hyperdrive: Hyperdrive, label: string) {
  const db = createDb(hyperdrive)
  const wsId = newId()
  await db
    .insert(organization)
    .values({ id: wsId, name: label, slug: `t-${wsId.slice(-12)}`, isPersonal: false })
  const s = scoped(db, wsId)
  const [dir] = await s.insert(direction, { name: `${label} 方向` }).returning()
  if (!dir) throw new Error('seed failed')
  const [cl] = await s
    .insert(cluster, { directionId: dir.id, marketplace: 'ebay-us', name: `${label} 簇` })
    .returning()
  if (!cl) throw new Error('seed failed')
  const [ld] = await s
    .insert(lead, {
      clusterId: cl.id,
      directionId: dir.id,
      leadOn: '2026-10-01',
      settingVersion: 1,
    })
    .returning()
  if (!ld) throw new Error('seed failed')
  return { wsId, directionId: dir.id, clusterId: cl.id, leadId: ld.id }
}
