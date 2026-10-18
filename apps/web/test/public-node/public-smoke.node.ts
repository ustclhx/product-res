import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { examplePricingCatalog } from '../../scripts/pricing-snapshot.ts'

it('真实 Node 子进程加载公开模块，无数据库时渲染公开内容与价格快照', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'product-res-public-node-'))
  const outfile = join(directory, 'smoke.cjs')
  try {
    await build({
      entryPoints: ['test/public-node/public-smoke.node.tsx'],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      jsx: 'automatic',
      // 这些虚拟入口仅供 Start 生产 handler 使用，本批不调用其服务器。
      external: ['#tanstack-router-entry', '#tanstack-start-entry', 'tanstack-start-manifest:v'],
      define: { __PRICING_SNAPSHOT__: JSON.stringify(examplePricingCatalog()) },
      logLevel: 'silent',
    })
    const output = await readFile(outfile, 'utf8')
    expect(output).not.toMatch(/cloudflare:|@sentry\/cloudflare/)
    const { stdout } = await promisify(execFile)(process.execPath, [outfile], { timeout: 30_000 })
    expect(stdout).toContain('Node public import and no-database rendering passed')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 40_000)
