import type { CheckoutMetadata } from '../provider.ts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Versioned array fits three UUIDs into 120 ASCII characters (PayPal limit: 127). */
export function encodePayPalMetadata(metadata: CheckoutMetadata): string {
  const ids = [metadata.workspaceId, metadata.planPriceId, metadata.userId]
  if (!ids.every((id) => uuid.test(id))) throw new Error('Checkout metadata must contain UUIDs')
  return JSON.stringify([1, ...ids])
}

/** Decode only verified remote objects; valid syntax alone does not establish trust. */
export function decodePayPalMetadata(value: unknown): CheckoutMetadata | null {
  if (typeof value !== 'string' || value.length > 127) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    parsed[0] !== 1 ||
    !parsed.slice(1).every((id) => typeof id === 'string' && uuid.test(id))
  )
    return null
  return { workspaceId: parsed[1], planPriceId: parsed[2], userId: parsed[3] }
}
