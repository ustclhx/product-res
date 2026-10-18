import { execFileSync } from 'node:child_process'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../', import.meta.url))

export function nodeMapTargets(root) {
  return [
    { directory: resolve(root, 'apps/web/.output/server'), dist: 'web-node' },
    { directory: resolve(root, 'apps/jobs/.output/server'), dist: 'jobs-node' },
  ]
}

async function* serverMaps(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // trace 进来的第三方依赖自带 map，不属于本次上传的产物校验范围。
    if (entry.name === 'node_modules') continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) yield* serverMaps(path)
    else if (entry.name.endsWith('.map')) yield path
  }
}

/**
 * 上传前拦截无法在 Sentry 读出源码的 map：仓库源码缺 sourcesContent、mappings 被清空，
 * 或仍指向带自身 map 的 Nitro/Vite 中间产物（二次打包未串接）。至少要有一份 TypeScript 源码。
 */
export async function assertNodeMaps(directory) {
  let typeScript = false
  for await (const path of serverMaps(directory)) {
    const map = JSON.parse(await readFile(path, 'utf8'))
    const sources = map.sources ?? []
    const name = path.slice(directory.length + 1)
    if (sources.length > 0 && !map.mappings) throw new Error(`Empty source map mappings: ${name}`)
    for (const [index, source] of sources.entries()) {
      const content = map.sourcesContent?.[index]
      if (
        source.includes('/.nitro/vite/services/') &&
        /\/\/# sourceMappingURL=/.test(content ?? '')
      )
        throw new Error(`Unchained intermediate source map: ${name}`)
      // 第三方依赖、URL 与 virtual: 模块不要求源码；只检查仓库内相对路径。
      if (source.includes('node_modules') || /^[a-z][a-z0-9+.-]*:/i.test(source)) continue
      if (typeof content !== 'string') throw new Error(`Missing sourcesContent: ${name}`)
      if (/\.tsx?$/.test(source)) typeScript = true
    }
  }
  if (!typeScript) throw new Error(`No TypeScript sources in Node maps: ${directory}`)
}

async function removePublicMaps(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) await removePublicMaps(path)
    else if (entry.name.endsWith('.map')) await rm(path)
  }
}

/** 只有显式 upload 才取得上传凭据；本地 inject 不读取部署密钥，也不联系 Sentry。 */
export async function prepareNodeMaps({
  root = repository,
  release,
  upload = false,
  env = process.env,
  run = (args, environment) =>
    execFileSync('pnpm', ['exec', 'sentry-cli', ...args], {
      cwd: root,
      env: environment,
      stdio: 'inherit',
    }),
}) {
  if (!/^[a-f0-9]{40}$/.test(release ?? ''))
    throw new Error('SENTRY_RELEASE must be a full git SHA')
  const targets = nodeMapTargets(root)
  for (const target of targets) {
    const metadata = JSON.parse(
      await readFile(resolve(target.directory, '../node-build.json'), 'utf8'),
    )
    if (metadata.release !== release || metadata.dist !== target.dist)
      throw new Error(`Node build metadata mismatch: ${target.dist}`)
    await stat(resolve(target.directory, 'index.mjs.map'))
    await assertNodeMaps(target.directory)
  }
  const environment = { ...env }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('SENTRY_')) delete environment[key]
  }
  const uploadEnvironment = { ...environment }
  if (upload) {
    for (const key of ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT']) {
      if (!env[key]) throw new Error(`Missing ${key}`)
      uploadEnvironment[key] = env[key]
    }
    run(['releases', 'new', release], uploadEnvironment)
  }
  for (const target of targets) {
    run(['sourcemaps', 'inject', target.directory], environment)
    if (upload)
      run(
        [
          'sourcemaps',
          'upload',
          '--release',
          release,
          '--dist',
          target.dist,
          '--validate',
          '--strict',
          '--wait',
          target.directory,
        ],
        uploadEnvironment,
      )
  }
  await removePublicMaps(resolve(root, 'apps/web/.output/public'))
  if (upload) run(['releases', 'finalize', release], uploadEnvironment)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const upload = process.argv.includes('--upload')
  const release =
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: 上传脚本在 Turbo 缓存之外执行。
    process.env.SENTRY_RELEASE ??
    process.env.APP_VERSION ??
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
  await prepareNodeMaps({ release, upload })
}
