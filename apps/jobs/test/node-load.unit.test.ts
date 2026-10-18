import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('loads jobs business handlers and media runner in real Node without Workers or Sentry CF', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jobs-node-load-'))
  try {
    const result = await build({
      entryPoints: ['../src/handlers.ts', '../src/workflows/media-runner.ts'].map((path) =>
        fileURLToPath(new URL(path, import.meta.url)),
      ),
      bundle: true,
      platform: 'node',
      format: 'esm',
      outdir: dir,
      jsx: 'automatic',
      metafile: true,
      // 被 bundle 的第三方 CJS 仍需 Node require；不注入 Workers 全局或平台替身。
      banner: {
        js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
      },
      logLevel: 'silent',
    })
    expect(JSON.stringify(result.metafile)).not.toMatch(/cloudflare:|@sentry\/cloudflare/)
    const script = `
      const handlers = await import(${JSON.stringify(join(dir, 'handlers.js'))});
      const runner = await import(${JSON.stringify(join(dir, 'workflows/media-runner.js'))});
      if (typeof handlers.consumeJobsBatch !== 'function' || typeof handlers.runJobsSchedule !== 'function' || typeof runner.runMediaTask !== 'function') throw new Error('Missing handlers');
      console.log('loaded');
    `
    expect(
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('loaded')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
