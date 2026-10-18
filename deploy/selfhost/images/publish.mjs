// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: 此脚本由 Actions 直接执行，不进入 Turbo 缓存。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  architectures,
  assertCompleteCatalog,
  assertEvidence,
  assertPlatforms,
  validateIdentity,
} from './policy.mjs'
import { Registry } from './registry.mjs'

const [sha, namespace, artifactDirectory, outputDirectory] = process.argv.slice(2)
validateIdentity(sha, namespace)
assert.match(process.env.GITHUB_RUN_ID ?? '', /^\d+$/)
assert.match(process.env.GITHUB_RUN_ATTEMPT ?? '', /^\d+$/)
assert(process.env.GITHUB_TOKEN && process.env.GITHUB_ACTOR, 'built-in registry identity required')
const catalog = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'))
assertCompleteCatalog(catalog)
const loadJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const artifacts = resolve(artifactDirectory)
const reports = new Map()
// 两架构与完整集合先验收，再允许任何写入。消费相同 run 的只读构建 artifact。
for (const arch of architectures) {
  const directory = join(artifacts, `selfhost-images-${sha}-${arch}`)
  const build = loadJson(join(directory, 'build.json'))
  assertEvidence(catalog, sha, arch, build, loadJson(join(directory, 'smoke.json')))
  reports.set(arch, { directory, build })
}
const registries = new Map(
  catalog.services.map(({ name }) => [
    name,
    new Registry(`${namespace.slice('ghcr.io/'.length)}/${name}`, {
      username: process.env.GITHUB_ACTOR,
      password: process.env.GITHUB_TOKEN,
    }),
  ]),
)
// 发布 workflow 按 namespace 串行；已有任意正式 SHA 均拒绝，部分失败也不能重跑覆写。
for (const { name } of catalog.services) {
  assert.equal(
    await registries.get(name).manifest(sha, true),
    null,
    `immutable SHA already exists: ${name}`,
  )
}
const docker = (...args) =>
  execFileSync('docker', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 300_000,
  })
const sources = new Map()
for (const { name } of catalog.services) {
  const manifests = []
  for (const arch of architectures) {
    const { directory, build } = reports.get(arch)
    docker('load', '--input', join(directory, `${name}.tar`))
    const local = `local/selfhost/${name}:${sha}`
    const [image] = JSON.parse(docker('image', 'inspect', local))
    assert.equal(image.Architecture, arch)
    assert.equal(image.Os, 'linux')
    assert.equal(image.Config.Labels?.['org.opencontainers.image.revision'], sha)
    assert.equal(
      image.Id,
      build.services.find((service) => service.name === name).id,
      'tar differs from tested image',
    )
    assert(image.Config.User && !['root', '0'].includes(image.Config.User.split(':')[0]))
    const candidate = `${namespace}/${name}:candidate-${sha}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-${arch}`
    docker('tag', local, candidate)
    docker('push', candidate)
    const { digest } = await registries.get(name).manifest(candidate.split(':').at(-1))
    manifests.push(`${namespace}/${name}@${digest}`)
  }
  sources.set(name, manifests)
}
const images = []
for (const { name } of catalog.services) {
  const registry = registries.get(name)
  // 再检查写入前状态；此保护要求所有正式发布者使用同一 workflow 串行锁。
  assert.equal(await registry.manifest(sha, true), null, `immutable SHA appeared: ${name}`)
  docker(
    'buildx',
    'imagetools',
    'create',
    '--tag',
    `${namespace}/${name}:${sha}`,
    ...sources.get(name),
  )
  const { digest, body } = await registry.manifest(sha)
  assertPlatforms(body)
  for (const manifest of body.manifests) {
    const child = await registry.manifest(manifest.digest)
    const config = await registry.config(child.body.config.digest)
    assert.equal(config.config.Labels?.['org.opencontainers.image.revision'], sha)
    assert.equal(config.architecture, manifest.platform.architecture)
  }
  images.push({
    name,
    reference: `${namespace}/${name}@${digest}`,
    tag: `${namespace}/${name}:${sha}`,
    digest,
  })
}
// 最后才输出成功集合；失败 run 没有成功 marker，D 1.4 才消费它制作可部署 bundle。
mkdirSync(outputDirectory, { recursive: true })
writeFileSync(
  join(outputDirectory, 'image-set.json'),
  `${JSON.stringify({ schemaVersion: 1, sha, namespace, platforms: architectures.map((arch) => `linux/${arch}`), images }, null, 2)}\n`,
)
console.info(
  JSON.stringify({
    event: 'selfhost.image-set.published',
    sha,
    services: images.map((image) => image.name),
  }),
)
