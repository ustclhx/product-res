import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertCompleteCatalog,
  assertEvidence,
  assertFormalTagsAbsent,
  assertPlatforms,
  formalRepository,
  hasTrustedCi,
  parseNewServices,
  requiredServices,
  validateIdentity,
} from './policy.mjs'
import { formalTagState, Registry } from './registry.mjs'

const sha = 'a'.repeat(40)
const catalog = { schemaVersion: 1, services: requiredServices.map((name) => ({ name })) }

test('完整镜像集要求备份及每个服务的两架构成功证据', () => {
  assert.throws(() => assertCompleteCatalog({ ...catalog, pendingServices: ['backup'] }))
  assert.throws(() =>
    assertCompleteCatalog({ ...catalog, services: catalog.services.slice(0, -1) }),
  )
  assertCompleteCatalog(catalog)
  const build = { sha, arch: 'arm64', services: catalog.services }
  const smoke = {
    sha,
    arch: 'arm64',
    passed: true,
    nativeSmoke: true,
    services: catalog.services.map((s) => ({ ...s, passed: true })),
  }
  assertEvidence(catalog, sha, 'arm64', build, smoke)
  assert.throws(() => assertEvidence(catalog, sha, 'amd64', build, smoke))
  assert.throws(() =>
    assertEvidence(catalog, sha, 'arm64', build, {
      ...smoke,
      services: smoke.services.slice(0, -1),
    }),
  )
  assert.throws(() =>
    assertEvidence(catalog, sha, 'arm64', build, { ...smoke, sha: 'b'.repeat(40) }),
  )
  assert.throws(() =>
    assertPlatforms({ manifests: [{ platform: { os: 'linux', architecture: 'amd64' } }] }),
  )
})

test('正式发布仅接受精确源码 SHA 的同仓 main push 成功 CI', () => {
  validateIdentity(sha, 'ghcr.io/owner/project')
  assert.throws(() => validateIdentity('main', 'ghcr.io/owner/project'))
  assert.throws(() => validateIdentity(sha, 'ghcr.io/owner/project;echo'))
  const run = {
    head_sha: sha,
    head_branch: 'main',
    head_repository: { full_name: 'owner/project' },
    event: 'push',
    status: 'completed',
    conclusion: 'success',
  }
  assert(hasTrustedCi([run], sha, 'owner/project'))
  for (const override of [
    { event: 'pull_request' },
    { conclusion: 'failure' },
    { head_branch: 'feature' },
    { head_repository: { full_name: 'fork/project' } },
    { head_sha: 'b'.repeat(40) },
  ]) {
    assert.equal(hasTrustedCi([{ ...run, ...override }], sha, 'owner/project'), false)
  }
})

test('registry仅接受明确缺失，不把权限或网络失败当成可覆写 SHA', async () => {
  const response = (status, body) => new Response(JSON.stringify(body), { status })
  const registry = (reply) => new Registry('owner/project/web', { request: async () => reply })
  assert.equal(
    await registry(response(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] })).manifest(sha, true),
    null,
  )
  for (const reply of [
    response(403, {}),
    response(500, {}),
    response(404, { errors: [{ code: 'DENIED' }] }),
  ]) {
    await assert.rejects(registry(reply).manifest(sha, true))
  }
  const existing = new Response(JSON.stringify({ manifests: [] }), {
    headers: { 'docker-content-digest': `sha256:${'b'.repeat(64)}` },
  })
  assert.notEqual(await registry(existing).manifest(sha, true), null)
  await assert.rejects(
    new Registry('owner/project/web', {
      request: async () => {
        throw new Error('network failed')
      },
    }).manifest(sha, true),
  )
})

test('registry拒绝将token交给非GHCR挑战地址', async () => {
  let calls = 0
  const registry = new Registry('owner/project/web', {
    username: 'fixture',
    password: 'fixture',
    request: async () => {
      calls++
      return new Response('', {
        status: 401,
        headers: {
          'www-authenticate': 'Bearer realm="https://attacker.example/token",service="ghcr.io"',
        },
      })
    },
  })
  await assert.rejects(registry.manifest(sha, true))
  assert.equal(calls, 1)
})

test('构建前正式tag门：已存在即拒绝，无法确认仅放行显式声明的新服务', () => {
  const absent = new Map(catalog.services.map(({ name }) => [name, 'absent']))
  assertFormalTagsAbsent(absent)
  assert.throws(
    () => assertFormalTagsAbsent(new Map([...absent, ['web', 'present']]), ['web']),
    /immutable SHA already exists: web/,
  )
  const unconfirmed = new Map([...absent, ['backup', 'unconfirmed']])
  assert.throws(() => assertFormalTagsAbsent(unconfirmed), /unconfirmed.*backup/)
  assertFormalTagsAbsent(unconfirmed, ['backup'])
  assert.throws(() => assertFormalTagsAbsent(new Map([['web', 'unknown']])))
  assert.deepEqual(parseNewServices(' backup, web ,', catalog), ['backup', 'web'])
  assert.deepEqual(parseNewServices('', catalog), [])
  assert.throws(() => parseNewServices('missing', catalog))
  assert.throws(() => parseNewServices('web,web', catalog))
  assert.equal(formalRepository('ghcr.io/owner/project', 'web'), 'owner/project/web')
  assert.throws(() => formalRepository('ghcr.io/owner/project', '../web'))
})

test('构建前检查只用匿名或只读pull token，403/网络/不明确404失败关闭', async () => {
  const challenge = () =>
    new Response('', {
      status: 401,
      headers: { 'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' },
    })
  const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers })
  // 按顺序回放 registry 响应，并记录 token 请求的 scope 与是否携带凭据。
  const fixture = (...replies) => {
    const tokens = []
    const request = async (url, init) => {
      if (String(url).startsWith('https://ghcr.io/token')) {
        tokens.push({
          scope: new URL(url).searchParams.get('scope'),
          authenticated: Boolean(init.headers.Authorization),
        })
      }
      const reply = replies.shift()
      if (reply instanceof Error) throw reply
      return reply()
    }
    return { request, tokens }
  }
  const token = () => json(200, { token: 'fixture' })
  const denied = () => json(403, { errors: [{ code: 'DENIED' }] })
  const manifestUnknown = () => json(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] })
  const existing = () =>
    json(200, { manifests: [] }, { 'docker-content-digest': `sha256:${'b'.repeat(64)}` })
  const credentials = { username: 'actor', password: 'read-only' }

  let registry = fixture(challenge, token, existing)
  assert.equal(await formalTagState('owner/project/web', sha, registry), 'present')
  assert.deepEqual(registry.tokens, [
    { scope: 'repository:owner/project/web:pull', authenticated: false },
  ])

  registry = fixture(challenge, token, manifestUnknown)
  assert.equal(await formalTagState('owner/project/web', sha, registry), 'absent')

  // 私有包：匿名被拒后改用只读凭据，仍只请求 pull。
  registry = fixture(challenge, denied, challenge, token, existing)
  assert.equal(
    await formalTagState('owner/project/web', sha, { ...credentials, ...registry }),
    'present',
  )
  assert.deepEqual(
    registry.tokens.map((item) => item.authenticated),
    [false, true],
  )
  assert(registry.tokens.every((item) => item.scope.endsWith(':pull')))

  registry = fixture(challenge, denied, challenge, denied)
  assert.equal(
    await formalTagState('owner/project/web', sha, { ...credentials, ...registry }),
    'unconfirmed',
  )
  registry = fixture(challenge, token, denied)
  assert.equal(await formalTagState('owner/project/web', sha, registry), 'unconfirmed')

  for (const replies of [
    [challenge, token, () => json(404, { errors: [{ code: 'NAME_UNKNOWN' }] })],
    [challenge, token, () => json(429, {})],
    [challenge, token, () => json(500, {})],
    [challenge, () => json(500, {})],
    [new Error('network failed')],
  ]) {
    await assert.rejects(formalTagState('owner/project/web', sha, fixture(...replies)))
  }
})
