import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { architectures, assertPlatforms } from './policy.mjs'

const root = resolve(import.meta.dirname, '../../..')
const catalog = JSON.parse(readFileSync(resolve(import.meta.dirname, 'catalog.json'), 'utf8'))
const references = new Set()
for (const { dockerfile } of catalog.services) {
  const source = readFileSync(resolve(root, dockerfile), 'utf8')
  const stages = new Set()
  for (const [, reference, stage] of source.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gm)) {
    if (!stages.has(reference)) {
      assert.match(reference, /@sha256:[a-f0-9]{64}$/, 'external base must use a manifest digest')
      references.add(reference)
    }
    if (stage) stages.add(stage)
  }
}
for (const reference of references) {
  const raw = execFileSync('docker', ['buildx', 'imagetools', 'inspect', '--raw', reference], {
    encoding: 'utf8',
    timeout: 120_000,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const index = JSON.parse(raw)
  const linux = index.manifests.filter((item) => item.platform?.os === 'linux')
  // 官方基础镜像可额外支持其他架构或携带 attestation；发布只要求含 amd64。
  assertPlatforms({
    manifests: linux.filter((item) => architectures.includes(item.platform.architecture)),
  })
  // arm64 只影响 Apple Silicon 本机开发构建，缺失时提示而不阻断发布。
  const localArm64 = linux.some((item) => item.platform.architecture === 'arm64')
  console.info(
    JSON.stringify({
      event: 'selfhost.base.platforms',
      reference,
      platforms: architectures.map((arch) => `linux/${arch}`),
      localArm64,
    }),
  )
}
