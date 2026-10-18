import type { CheckoutMetadata } from '../provider.ts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Only UUID-shaped source associations can be used to repair a missing local record. */
export function parseStripeMetadata(
  metadata: Record<string, string> | null | undefined,
): CheckoutMetadata | null {
  if (!metadata) return null
  const { workspaceId, planPriceId, userId } = metadata
  if (
    !workspaceId ||
    !uuid.test(workspaceId) ||
    !planPriceId ||
    !uuid.test(planPriceId) ||
    !userId ||
    !uuid.test(userId)
  )
    return null
  return { workspaceId, planPriceId, userId }
}
