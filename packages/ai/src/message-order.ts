import { aiMessage } from '@product-res/db'
import { asc, desc, sql } from 'drizzle-orm'

/** 同一事务的问答时间相同，旧数据的回复 ID 还可能早于提问，不能只按 ID 排序。 */
export function aiMessageOrder(direction: 'asc' | 'desc' = 'asc') {
  const order = direction === 'asc' ? asc : desc
  return [
    order(aiMessage.createdAt),
    order(sql`case when ${aiMessage.role} = 'user' then 0 else 1 end`),
    order(aiMessage.id),
  ]
}
