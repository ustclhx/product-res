import { execFileSync } from 'node:child_process'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const version =
  process.env.APP_VERSION ??
  execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
if (!/^[a-f0-9]{40}$/.test(version)) throw new Error('APP_VERSION must be a full git SHA')
await rename(`${root}/.output/server/index.mjs`, `${root}/.output/server/application.mjs`)
await rename(`${root}/.output/server/index.mjs.map`, `${root}/.output/server/application.mjs.map`)
// Nitro 的入口重命名后不能把应用 stack 错配到 bootstrap 的 map。
const application = await readFile(`${root}/.output/server/application.mjs`, 'utf8')
await writeFile(
  `${root}/.output/server/application.mjs`,
  application.replace('sourceMappingURL=index.mjs.map', 'sourceMappingURL=application.mjs.map'),
)
const map = JSON.parse(await readFile(`${root}/.output/server/application.mjs.map`, 'utf8'))
map.file = 'application.mjs'
await writeFile(`${root}/.output/server/application.mjs.map`, JSON.stringify(map))
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/node/bootstrap.ts'],
  outfile: '.output/server/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.12',
  external: ['@sentry/node'],
  sourcemap: 'external',
  metafile: true,
  define: { __APP_VERSION__: JSON.stringify(version) },
})
if (JSON.stringify(result.metafile).includes('@sentry/cloudflare'))
  throw new Error('Cloudflare SDK in Node bootstrap')

await writeFile(
  `${root}/.output/node-build.json`,
  `${JSON.stringify({ release: version, dist: 'web-node', inputs: Object.keys(result.metafile.inputs) }, null, 2)}\n`,
)
