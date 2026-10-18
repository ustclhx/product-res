/** Only the durable delivery identity crosses the queue; never payloads or payment credentials. */
export interface BillingQueueMessage {
  v: 1
  deliveryId: string
  /** Request that enqueued the message (log correlation). Optional: older in-flight messages lack it. */
  requestId?: string
}
export function parseBillingQueueMessage(value: unknown): BillingQueueMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const message = value as Record<string, unknown>
  if (
    message.v !== 1 ||
    typeof message.deliveryId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(message.deliveryId)
  )
    return null
  // A malformed request ID only loses correlation; it never rejects the delivery.
  const requestId =
    typeof message.requestId === 'string' && /^[\w-]{1,64}$/.test(message.requestId)
      ? message.requestId
      : undefined
  return requestId === undefined
    ? { v: 1, deliveryId: message.deliveryId }
    : { v: 1, deliveryId: message.deliveryId, requestId }
}
