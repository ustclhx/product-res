import assert from 'node:assert/strict'

const accept = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

// GHCR 对不存在、私有或无权限的仓库统一返回 DENIED；调用方只能当作“无法确认”。
export class RegistryDenied extends Error {}

export class Registry {
  constructor(repository, { username, password, scope = 'pull,push', request = fetch } = {}) {
    this.repository = repository
    this.username = username
    this.password = password
    this.scope = scope
    this.request = request
  }

  async get(path, missingAllowed = false) {
    const url = `https://ghcr.io/v2/${this.repository}/${path}`
    const headers = { Accept: accept }
    let response = await this.request(url, { headers, signal: AbortSignal.timeout(30_000) })
    if (response.status === 401) {
      const challenge = response.headers.get('www-authenticate') ?? ''
      const realm = /realm="([^"]+)"/.exec(challenge)?.[1]
      const service = /service="([^"]+)"/.exec(challenge)?.[1]
      // 凭据只发送给固定 GHCR token endpoint；错误不打印 header/body。
      assert.equal(realm, 'https://ghcr.io/token', 'unexpected registry token endpoint')
      assert.equal(service, 'ghcr.io')
      const tokenUrl = new URL(realm)
      tokenUrl.searchParams.set('service', service)
      tokenUrl.searchParams.set('scope', `repository:${this.repository}:${this.scope}`)
      // 无凭据时走匿名 pull token，只读 trust 阶段不持有任何写权限。
      const tokenHeaders = this.password
        ? {
            Authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`,
          }
        : {}
      const tokenResponse = await this.request(tokenUrl, {
        headers: tokenHeaders,
        signal: AbortSignal.timeout(30_000),
      })
      if (tokenResponse.status === 403) throw new RegistryDenied('registry token denied')
      assert.equal(
        tokenResponse.status,
        200,
        `registry authentication failed (${tokenResponse.status})`,
      )
      const { token } = await tokenResponse.json()
      assert.equal(typeof token, 'string')
      headers.Authorization = `Bearer ${token}`
      response = await this.request(url, { headers, signal: AbortSignal.timeout(30_000) })
    }
    // 仅明确 MANIFEST_UNKNOWN 才是不存在；权限/限流/网络失败绝不许可覆写。
    if (missingAllowed && response.status === 404) {
      const body = await response.json()
      assert(
        body.errors?.some((error) => error.code === 'MANIFEST_UNKNOWN'),
        'unconfirmed missing manifest',
      )
      return null
    }
    if (response.status === 401 || response.status === 403)
      throw new RegistryDenied(`registry read denied (${response.status})`)
    assert.equal(response.status, 200, `registry read failed (${response.status})`)
    return response
  }

  async manifest(reference, missingAllowed = false) {
    const response = await this.get(`manifests/${reference}`, missingAllowed)
    if (!response) return null
    const digest = response.headers.get('docker-content-digest')
    assert.match(digest, /^sha256:[a-f0-9]{64}$/)
    return { digest, body: await response.json() }
  }

  async config(digest) {
    return (await this.get(`blobs/${digest}`)).json()
  }
}

// 构建前只读检查正式 tag：先匿名，被拒再用只读凭据；仍被拒只能返回 unconfirmed。
// 明确 MANIFEST_UNKNOWN 才是 absent；限流、5xx、网络和不明确 404 直接抛出（失败关闭）。
export async function formalTagState(repository, sha, { username, password, request } = {}) {
  const attempts = [{}, ...(password ? [{ username, password }] : [])]
  for (const credentials of attempts) {
    try {
      const registry = new Registry(repository, { ...credentials, scope: 'pull', request })
      return (await registry.manifest(sha, true)) === null ? 'absent' : 'present'
    } catch (error) {
      if (!(error instanceof RegistryDenied)) throw error
    }
  }
  return 'unconfirmed'
}
