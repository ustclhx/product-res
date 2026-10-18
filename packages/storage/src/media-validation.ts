import { AppError } from '@product-res/shared'

export function allowedUrl(raw: string, hosts: readonly string[]): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new AppError('MEDIA_URL_NOT_ALLOWED', 'Media URL is not allowed')
  }
  const allowed = hosts.some((entry) => {
    const host = entry.toLowerCase()
    return host.startsWith('*.')
      ? url.hostname.endsWith(`.${host.slice(2)}`) && url.hostname !== host.slice(2)
      : url.hostname === host
  })
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed)
    throw new AppError('MEDIA_URL_NOT_ALLOWED', 'Media URL is not allowed')
  return url
}

export function checkSize(size: number, max: number) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > max)
    throw new AppError('FILE_TOO_LARGE', 'Media exceeds the file size limit')
}
