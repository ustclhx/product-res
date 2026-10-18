import type { ObservationPoint } from '../src/index.ts'

export const ASOF = '2026-10-19'

export function pt(
  value: number,
  observedOn: string,
  sourceId = 'ebay-browse',
  fetchedAt = `${observedOn}T06:00:00.000Z`,
): ObservationPoint {
  return { value, observedOn, sourceId, method: 'official', fetchedAt }
}
