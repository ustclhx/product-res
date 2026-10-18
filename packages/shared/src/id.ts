import { v7, validate, version } from 'uuid'

/**
 * 生成主键：UUIDv7（时间有序）。同一 isolate 内连续生成的 ID 严格递增，
 * 因此按 id 排序即按创建时间排序，列表分页可直接用 id 做游标。
 */
export function newId(): string {
  return v7()
}

export function isUuidV7(value: string): boolean {
  return validate(value) && version(value) === 7
}
