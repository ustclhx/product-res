/** 32 字节随机数（256 位），不编码资源、用户或空间 ID。 */
export function createShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}
