import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('builds portable Node ESM with declared externals and rejects invalid configuration before listen', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  await mkdir(join(root, '.output'), { recursive: true })
  const directory = await mkdtemp(join(root, '.output/test-'))
  try {
    // 生成副本没有 .git；构建夹具显式提供完整 SHA，发布仍使用 CI 检出的真实版本。
    execFileSync(process.execPath, ['scripts/build-node.mjs', directory], {
      cwd: root,
      env: { ...process.env, APP_VERSION: 'a'.repeat(40) },
    })
    const entry = join(directory, 'server/index.mjs')
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const graph = JSON.parse(await readFile(join(directory, 'node-build.json'), 'utf8')) as {
      externals: string[]
      inputs: string[]
    }
    expect(JSON.stringify(graph)).not.toMatch(/cloudflare:|workerd|@sentry\/cloudflare/)
    const resolve = createRequire(entry).resolve
    for (const external of graph.externals) {
      const name = external.startsWith('@')
        ? external.split('/').slice(0, 2).join('/')
        : external.split('/')[0]
      expect(manifest.dependencies[name as string]).toBeDefined()
      expect(resolve(external)).toContain('node_modules')
    }
    const child = spawnSync(process.execPath, [entry], {
      cwd: directory,
      env: {},
      encoding: 'utf8',
    })
    expect(child.status).toBe(1)
    expect(child.stdout + child.stderr).toContain('jobs.node.start_failed')
    expect(child.stdout + child.stderr).toContain('DATABASE_URL')
    expect(child.stdout + child.stderr).not.toContain('jobs.node.started')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
