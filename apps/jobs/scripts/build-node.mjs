import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const output = resolve(root, process.argv[2] ?? '.output')
const version =
  process.env.APP_VERSION ??
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
if (!/^[a-f0-9]{40}$/.test(version)) throw new Error('APP_VERSION must be a full git SHA')
// splitting 产生版本化 chunk，旧产物不能混入本版本的 maps 上传目录。
await rm(`${output}/server`, { recursive: true, force: true })
const result = await build({
  absWorkingDir: root,
  entryPoints: { index: 'src/index.node.ts' },
  outdir: `${output}/server`,
  outExtension: { '.js': '.mjs' },
  splitting: true,
  sourcemap: 'external',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22.12',
  metafile: true,
  define: { __APP_VERSION__: JSON.stringify(version) },
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  plugins: [
    {
      name: 'external-runtime-packages',
      setup(build) {
        // workspace 与仅由业务包拥有的依赖编译进 ESM；声明的运行时依赖保持外置，允许原生模块。
        build.onResolve({ filter: /^[^./]/ }, ({ path }) => {
          if (path.startsWith('@product-res/')) return undefined
          if (path.startsWith('cloudflare:') || path.includes('@sentry/cloudflare'))
            throw new Error('Cloudflare dependency in Node jobs build')
          const name = path.startsWith('@')
            ? path.split('/').slice(0, 2).join('/')
            : path.split('/')[0]
          if (
            path.startsWith('node:') ||
            builtinModules.includes(path) ||
            manifest.dependencies[name]
          )
            return { path, external: true }
          return undefined
        })
      },
    },
  ],
})
const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports)
const externals = [...new Set(imports.filter((item) => item.external).map((item) => item.path))]
if (externals.some((path) => /cloudflare:|workerd|@sentry\/cloudflare/.test(path)))
  throw new Error('Cloudflare dependency in Node jobs output')
const runtimePackages = externals.filter(
  (path) => !path.startsWith('node:') && !builtinModules.includes(path),
)
await mkdir(output, { recursive: true })
await writeFile(
  `${output}/node-build.json`,
  `${JSON.stringify({ release: version, dist: 'jobs-node', externals: runtimePackages, inputs: Object.keys(result.metafile.inputs) }, null, 2)}\n`,
)
