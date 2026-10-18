const encoder = new TextEncoder()
const key = (secret: string) =>
  crypto.subtle.importKey(
    'raw',
    encoder.encode(`ai-media:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )

export async function mediaCallbackUrl(
  origin: string,
  secret: string,
  task: { id: string; provider: string },
): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(task.id))
  const url = new URL(`/api/webhooks/media/${encodeURIComponent(task.provider)}`, origin)
  url.searchParams.set('task', task.id)
  url.searchParams.set(
    'sig',
    Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join(''),
  )
  return url.toString()
}

export async function verifyMediaCallbackSignature(
  secret: string,
  taskId: string,
  signature: string,
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(signature)) return false
  const bytes = Uint8Array.from(signature.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))
  return crypto.subtle.verify('HMAC', await key(secret), bytes, encoder.encode(taskId))
}
