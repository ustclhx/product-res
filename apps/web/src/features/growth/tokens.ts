import { z } from 'zod'

const payloadSchema = z.object({
  purpose: z.enum(['waitlist', 'confirm', 'unsubscribe']),
  id: z.uuid(),
  nonce: z.uuid(),
  expires: z.number().int().positive().nullable(),
})
type Payload = z.infer<typeof payloadSchema>
const encoder = new TextEncoder()
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
const decode = (value: string) =>
  Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))
const key = (secret: string) =>
  crypto.subtle.importKey(
    'raw',
    encoder.encode(`growth:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )

export async function signGrowthToken(secret: string, payload: Payload): Promise<string> {
  const body = encode(encoder.encode(JSON.stringify(payload)))
  const signature = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(body))
  return `${body}.${encode(new Uint8Array(signature))}`
}

export async function verifyGrowthToken(
  secret: string,
  token: string,
  purpose: Payload['purpose'],
): Promise<Payload | null> {
  if (token.length > 1024) return null
  const [body, signature, extra] = token.split('.')
  if (!body || !signature || extra !== undefined) return null
  let bytes: Uint8Array<ArrayBuffer>
  let payload: Payload
  try {
    bytes = decode(signature)
    payload = payloadSchema.parse(JSON.parse(new TextDecoder().decode(decode(body))))
  } catch {
    return null
  }
  if (payload.purpose !== purpose || (payload.expires !== null && payload.expires <= Date.now()))
    return null
  return (await crypto.subtle.verify('HMAC', await key(secret), bytes, encoder.encode(body)))
    ? payload
    : null
}
