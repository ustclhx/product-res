import { AppError } from '@product-res/shared'
import type { JsonValue } from '../workflow.ts'

/** 在持久化边界拒绝 JSON 会静默丢弃/转换的值，避免重放结果与首次执行不同。 */
export function jsonValue(value: unknown): JsonValue {
  const parents = new Set<object>()
  function visit(item: unknown): boolean {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true
    if (typeof item === 'number') return Number.isFinite(item)
    if (typeof item !== 'object' || parents.has(item)) return false
    const prototype = Object.getPrototypeOf(item)
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) return false
    parents.add(item)
    const valid = Array.isArray(item)
      ? Array.from(item).every(visit)
      : Reflect.ownKeys(item).every(
          (key) => typeof key === 'string' && visit(Reflect.get(item, key)),
        )
    parents.delete(item)
    return valid
  }
  if (!visit(value)) throw new AppError('WORKFLOW_INVALID_JSON', 'Workflow data must be JSON')
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
