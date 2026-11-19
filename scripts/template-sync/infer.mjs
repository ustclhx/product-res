import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { postprocessProject } from '../create-project.mjs'
import {
  normalizeParams,
  paramsToArgs,
  serializeBaseRecord,
  sourceState,
} from '../template-base.mjs'
import { cloneTemplate, generateAt, releaseVersion, resolveCommit } from './generate.mjs'
import { git, gitRaw } from './git.mjs'

const listKeys = ['ai', 'billing', 'features', 'media-providers', 'oauth']
const booleanKeys = [
  'billing-enabled',
  'credits-enabled',
  'i18n',
  'marketing',
  'multi-tenant',
  'turnstile',
]
const keys = Object.keys(normalizeParams({ name: 'fixture', url: 'https://fixture.example' }))
const toolRoot = fileURLToPath(new URL('../../', import.meta.url))

// 只解析静态字面量；不执行生成提交中的配置代码。
function literal(text) {
  const tokens =
    text
      .match(
        /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$-]*|-?\d+(?:\.\d+)?|[^\s]/g,
      )
      ?.filter((token) => !token.startsWith('//') && !token.startsWith('/*')) ?? []
  let index = 0
  const value = () => {
    const token = tokens[index++]
    if (token === '{' || token === '[') {
      const object = token === '{'
      const result = object ? {} : []
      const end = object ? '}' : ']'
      while (tokens[index] !== end) {
        if (index >= tokens.length) throw new Error('配置不是静态字面量')
        if (object) {
          const key = tokens[index++]
          if (tokens[index++] !== ':') throw new Error('配置不是静态字面量')
          result[key.startsWith('"') || key.startsWith("'") ? string(key) : key] = value()
        } else result.push(value())
        if (tokens[index] === ',') index++
        else if (tokens[index] !== end) throw new Error('配置不是静态字面量')
      }
      index++
      return result
    }
    if (token?.startsWith('"') || token?.startsWith("'")) return string(token)
    if (token === 'true' || token === 'false') return token === 'true'
    if (token === 'null') return null
    if (/^-?\d/.test(token ?? '')) return Number(token)
    throw new Error('配置不是静态字面量')
  }
  return value()
}
function string(token) {
  if (token.startsWith('"')) return JSON.parse(token)
  return token.slice(1, -1).replace(/\\(['\\])/g, '$1')
}

/** Recover complete generator parameters exclusively from the selected Git commit. */
export function inferParams(project, commit, overrides = []) {
  const files = git(project, ['ls-tree', '-rz', '--name-only', commit]).split('\0').filter(Boolean)
  const read = (path) => (files.includes(path) ? git(project, ['show', `${commit}:${path}`]) : '')
  const params = {}
  const sources = {}
  const put = (key, value, source) => {
    if (value !== undefined && value !== null) {
      params[key] = value
      sources[key] = `${commit}:${source}`
    }
  }
  let config = {}
  try {
    const text = read('template.config.ts')
    const offset = text.search(/defineTemplateConfig\s*\(\s*\{/)
    if (offset >= 0) config = literal(text.slice(text.indexOf('{', offset)))
  } catch {
    // 非静态配置必须由使用者明确补参，不能执行项目代码或套用当前默认值。
  }
  for (const [key, value] of Object.entries({
    locale: config.i18n?.defaultLocale,
    theme: config.ui?.preset,
    i18n: config.i18n?.enabled,
    marketing: config.marketing?.enabled,
    'billing-enabled': config.billing?.enabled,
    'credits-enabled': config.credits?.enabled,
    billing: config.billing?.providers,
    oauth: config.auth?.oauth,
    turnstile: config.auth?.turnstile,
    'multi-tenant': config.tenancy?.multiTenant,
    'support-email': config.app?.supportEmail,
    'media-providers': config.ai?.mediaProviders,
  }))
    put(key, value, 'template.config.ts')
  const ai = ['text', 'image', 'video'].map((name) =>
    typeof config.ai?.[name] === 'object' ? config.ai[name]?.enabled : config.ai?.[name],
  )
  if (ai.every((enabled) => typeof enabled === 'boolean')) {
    put(
      'ai',
      ['text', 'image', 'video'].filter((_, i) => ai[i]),
      'template.config.ts',
    )
  }
  const features = ['publicApi', 'blog', 'docs', 'waitlist', 'newsletter']
  if (features.every((key) => typeof config.features?.[key] === 'boolean')) {
    put(
      'features',
      // guides 是后加的开关，旧项目的配置里没有它。
      [...features, 'guides'].filter((key) => config.features[key] === true),
      'template.config.ts',
    )
  }
  try {
    const name = JSON.parse(read('package.json')).name
    put('name', name?.match(/^@([^/]+)\//)?.[1] ?? name, 'package.json')
  } catch {
    /* 缺失或非 JSON 的包信息由 --param 补齐。 */
  }
  const wranglers = files.filter((path) => /(?:^|\/)wrangler\.jsonc?$/.test(path))
  for (const path of wranglers) {
    const text = read(path)
    // staging 的 APP_URL 不等于项目域名，只从 production 段读取；没有该段时读全文（旧项目两者相同）。
    const production = text.search(/["']?production["']?\s*:\s*\{/)
    const appUrl = text
      .slice(Math.max(production, 0))
      .match(/["']?APP_URL["']?\s*:\s*["'](https:\/\/[^"']+)["']/)?.[1]
    const route = text.match(/["']pattern["']\s*:\s*["']([^"']+)["']/)?.[1]
    if (appUrl || route) {
      try {
        put('domain', new URL(appUrl ?? `https://${route.replace(/\/.*$/, '')}`).origin, path)
      } catch {
        /* 需要补参。 */
      }
      if (appUrl) break
    }
  }
  const workflowPath = '.github/workflows/selfhost-publish.yml'
  const cf = ['deploy-staging.yml', 'deploy-production.yml'].some((name) =>
    files.includes(`.github/workflows/${name}`),
  )
  if (cf) put('target', 'cloudflare', '.github/workflows/deploy-staging.yml|deploy-production.yml')
  else if (files.includes(workflowPath)) put('target', 'selfhost', workflowPath)
  const namespace = read(workflowPath)
    .match(/^ {6}namespace:\s*\n((?: {8}[^\n]*\n?)*)/m)?.[1]
    ?.match(/^ {8}default:\s*['"]?(ghcr\.io\/[^\s'"]+)/m)?.[1]
  put('image-namespace', namespace, workflowPath)
  if (params.target === 'selfhost') {
    const env = read('deploy/selfhost/.env.example')
    if (!params['image-namespace'])
      put(
        'image-namespace',
        env.match(/^IMAGE_NAMESPACE=(ghcr\.io\/\S+)/m)?.[1],
        'deploy/selfhost/.env.example',
      )
    if (!params.domain)
      put('domain', env.match(/^APP_URL=(https:\/\/\S+)/m)?.[1], 'deploy/selfhost/.env.example')
  }
  const setup = read('PROJECT_SETUP.md')
  if (!params.target) {
    if (/^# .* selfhost 初始化清单/m.test(setup)) put('target', 'selfhost', 'PROJECT_SETUP.md')
    else if (/^## Worker Secrets/m.test(setup)) put('target', 'cloudflare', 'PROJECT_SETUP.md')
  }
  if (!params['image-namespace'])
    put(
      'image-namespace',
      setup.match(/(?:namespace=|OCI namespace[：:]\s*)(ghcr\.io\/[a-z0-9._/-]+)/)?.[1],
      'PROJECT_SETUP.md',
    )
  for (const path of ['apps/web/.dev.vars.example', '.dev.vars.example']) {
    if (!params.domain) put('domain', read(path).match(/^APP_URL=(https:\/\/[^\s]+)/m)?.[1], path)
  }
  for (const entry of overrides) {
    const separator = entry.indexOf('=')
    const key = entry.slice(0, separator)
    const raw = entry.slice(separator + 1)
    if (separator < 1 || !keys.includes(key))
      throw new Error(`无效 --param ${key}，应为已知的 key=value`)
    if (booleanKeys.includes(key) && !['true', 'false'].includes(raw))
      throw new Error(`--param ${key} 必须为 true 或 false`)
    params[key] = listKeys.includes(key)
      ? [...new Set(raw.split(',').filter(Boolean))]
      : booleanKeys.includes(key)
        ? raw === 'true'
        : raw
    sources[key] = '--param'
  }
  // cloudflare 副本不含镜像发布材料，生成器此时用默认 namespace，推断沿用同一默认值。
  if (!Object.hasOwn(params, 'image-namespace') && params.target === 'cloudflare' && params.name) {
    params['image-namespace'] = `ghcr.io/configure-owner/${params.name}`
    sources['image-namespace'] = '生成器默认（cloudflare）'
  }
  // theme 为后加参数；旧提交没有该配置时，不向旧候选生成器传递新 flag。
  const missing = keys.filter((key) => key !== 'theme' && !Object.hasOwn(params, key))
  if (missing.length)
    throw new Error(
      `无法从生成提交还原参数，请补齐：${missing.map((key) => `--param ${key}=<值>`).join(' ')}`,
    )
  const normalized = normalizeParams({
    name: params.name,
    url: params.domain,
    ai: params.ai,
    billing: params.billing,
    billingEnabled: params['billing-enabled'],
    creditsEnabled: params['credits-enabled'],
    features: params.features,
    i18n: params.i18n,
    imageNamespace: params['image-namespace'],
    locale: params.locale,
    theme: params.theme,
    marketing: params.marketing,
    mediaProviders: params['media-providers'],
    multiTenant: params['multi-tenant'],
    oauth: params.oauth,
    supportEmail: params['support-email'],
    target: params.target,
    turnstile: params.turnstile,
  })
  if (!Object.hasOwn(params, 'theme')) delete normalized.theme
  paramsToArgs(normalized)
  return { params: normalized, sources, files }
}

/** Compare only generated paths; project-only additions do not contribute to the score. */
async function scoreCopy(copy, original, work, projectFiles) {
  const compared = join(work, 'compare')
  await mkdir(compared)
  git(compared, ['init', '--quiet'])
  git(compared, ['--work-tree', copy, 'add', '--force', '--all'])
  gitRaw(compared, ['rm', '--cached', '--ignore-unmatch', '.template-base.json'])
  const paths = git(compared, ['ls-files', '-z']).split('\0').filter(Boolean)
  // 索引仅有生成路径，比较时跳过项目独有文件。
  const output = git(compared, ['--work-tree', original, 'diff', '--numstat', '--no-renames', '-z'])
  const differences = []
  const binaryFiles = []
  for (const entry of output.split('\0').filter(Boolean)) {
    const first = entry.indexOf('\t')
    const second = entry.indexOf('\t', first + 1)
    const added = entry.slice(0, first)
    const removed = entry.slice(first + 1, second)
    const path = entry.slice(second + 1)
    if (added === '-') binaryFiles.push(path)
    else differences.push({ path, added, removed, lines: Number(added) + Number(removed) })
  }
  differences.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path))
  return {
    score: differences.reduce((sum, file) => sum + file.lines, 0),
    binaryFiles,
    differences,
    projectOnly: projectFiles.filter(
      (path) => path !== '.template-base.json' && !paths.includes(path),
    ),
  }
}

function selectGenerationCommit(project, selected, log) {
  const withTime = (sha) => ({
    sha,
    time: Number(git(project, ['show', '-s', '--format=%ct', sha])),
  })
  if (selected === undefined) {
    const roots = git(project, ['rev-list', '--max-parents=0', 'HEAD']).split('\n')
    if (roots.length > 1)
      log('检测到多个根提交，可用 --generation-commit <完整 SHA> 指定生成提交。')
    return roots.map(withTime).sort((a, b) => a.time - b.time || a.sha.localeCompare(b.sha))[0]
  }
  const head = git(project, ['rev-parse', '--verify', 'HEAD'])
  if (selected.length !== head.length || !/^[a-f0-9]+$/i.test(selected))
    throw new Error('--generation-commit 必须为完整的提交 SHA')
  const sha = selected.toLowerCase()
  const commit = gitRaw(project, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])
  if (commit.status !== 0 || commit.stdout.trim() !== sha)
    throw new Error('--generation-commit 必须指向存在的提交')
  const ancestry = gitRaw(project, ['merge-base', '--is-ancestor', sha, head])
  if (ancestry.status !== 0) throw new Error('--generation-commit 必须为 HEAD 或 HEAD 的祖先')
  return withTime(sha)
}

function logCandidate(log, candidate) {
  log(
    `${candidate.commit} ${candidate.date} ${candidate.title} 分数=${candidate.score} 二进制差异=${candidate.binaryFiles.length}`,
  )
  for (const file of candidate.differences.slice(0, 5))
    log(`  ${file.path}: +${file.added} -${file.removed}`)
  if (candidate.binaryFiles.length) {
    log('  请人工核对以下二进制差异：')
    for (const path of candidate.binaryFiles) log(`    ${JSON.stringify(path)}`)
  }
  log(`  项目独有路径（不计分）：${candidate.projectOnly.join(', ') || '无'}`)
}

/** Infer a baseline without modifying the project unless an eligible SHA is explicitly selected. */
export async function runInfer(options) {
  if (options.force && !options.write) throw new Error('--force 必须与 --write 一起使用')
  const project = await realpath(resolve(options.project))
  const log = options.log ?? console.log
  const template = options.template ?? toolRoot
  const threshold = Number(options.threshold ?? 50)
  if (!Number.isFinite(threshold) || threshold < 0)
    throw new Error('--threshold 必须是非负有限行数')
  if (resolve(git(project, ['rev-parse', '--show-toplevel'])) !== project)
    throw new Error('--project 必须是 Git 仓库根目录')
  const generation = selectGenerationCommit(project, options.generationCommit, log)
  const { params, sources, files } = inferParams(project, generation.sha, options.params)
  const since = options.since?.match(/^\d{4}-\d{2}-\d{2}$/)
    ? `${options.since}T00:00:00.000Z`
    : (options.since ?? new Date((generation.time - 3 * 86400) * 1000).toISOString())
  const until = options.until?.match(/^\d{4}-\d{2}-\d{2}$/)
    ? `${options.until}T23:59:59.999Z`
    : (options.until ?? new Date((generation.time + 3 * 86400) * 1000).toISOString())
  if (
    !Number.isFinite(Date.parse(since)) ||
    !Number.isFinite(Date.parse(until)) ||
    Date.parse(since) > Date.parse(until)
  )
    throw new Error('无效的 --since/--until 时间窗')
  const clone = await cloneTemplate(template, log)
  const work = await mkdtemp(join(tmpdir(), 'template-infer-'))
  try {
    const original = join(work, 'original')
    await mkdir(original)
    const archive = join(work, 'project.tar')
    git(project, ['archive', '--format=tar', '-o', archive, generation.sha])
    const extracted = spawnSync('tar', ['-xf', archive, '-C', original], { encoding: 'utf8' })
    if (extracted.status !== 0) throw new Error(`生成提交解包失败：${extracted.stderr}`)
    const main = resolveCommit(clone, 'origin/main')
    if (!main) throw new Error('模板缺少 main 分支')
    const commits = git(clone.dir, [
      'log',
      '--first-parent',
      `--since-as-filter=${since}`,
      `--until=${until}`,
      '--format=%H',
      main,
    ])
      .split('\n')
      .filter(Boolean)
    // 用同一套规则比较生成提交与所有候选，保持分数可比较。
    const postprocess = { reference: toolRoot }
    if (commits.length) await postprocessProject(original, postprocess)
    const candidates = []
    for (const commit of commits) {
      const directory = join(work, commit)
      await mkdir(directory)
      const copy = join(directory, 'generated')
      await generateAt(clone, commit, params, copy)
      await postprocessProject(copy, postprocess)
      const scored = await scoreCopy(copy, original, directory, files)
      const [date, title] = git(clone.dir, ['show', '-s', '--format=%cI%n%s', commit]).split('\n')
      const journal = JSON.parse(
        await readFile(join(copy, 'packages/db/migrations/meta/_journal.json'), 'utf8'),
      )
      if (
        !Array.isArray(journal.entries) ||
        journal.entries.some((entry) => typeof entry.tag !== 'string')
      )
        throw new Error(`候选 ${commit} 的迁移 journal 无效`)
      candidates.push({
        commit,
        date,
        title,
        ...scored,
        version: releaseVersion(clone, commit),
        migrations: journal.entries.map((entry) => entry.tag),
      })
    }
    candidates.sort(
      (a, b) =>
        a.score - b.score ||
        a.binaryFiles.length - b.binaryFiles.length ||
        b.date.localeCompare(a.date) ||
        a.commit.localeCompare(b.commit),
    )
    const commitLabel = options.generationCommit === undefined ? '首个提交' : '生成提交'
    log(`${commitLabel}：${generation.sha}\n时间窗：${since} 至 ${until}\n还原参数：`)
    for (const key of keys) log(`${key}=${JSON.stringify(params[key])}（${sources[key]}）`)
    const shown = candidates.slice(0, 5)
    for (const candidate of shown) logCandidate(log, candidate)
    const result = {
      status: 'inferred',
      root: generation.sha,
      since,
      until,
      params,
      sources,
      candidates,
    }
    if (!candidates.length) throw new Error('时间窗内没有 main 候选提交，请调整 --since/--until')
    if (!options.write) {
      log(
        candidates[0].score > threshold
          ? `所有候选均超过 ${threshold} 行阈值。人工核对后可用 --write <完整候选 SHA> --force 写入基准。`
          : '确认候选后使用 --write <完整候选 SHA> 写入基准。',
      )
      return result
    }
    const selected = candidates.find((candidate) => candidate.commit === options.write)
    if (!selected) throw new Error('--write 必须为本时间窗内候选的完整 SHA')
    if (!shown.includes(selected)) logCandidate(log, selected)
    if (selected.score > threshold && !options.force)
      throw new Error(`候选差异 ${selected.score} 超过 ${threshold} 行阈值，拒绝写入`)
    const repository = sourceState(clone.dir).repository
    // 本地 clone 的 origin 是路径，来源必须取模板自己的远端地址。
    const source = sourceState(resolve(template)).repository
    const record = {
      schemaVersion: 1,
      repository: repository ?? source,
      commit: selected.commit,
      version: selected.version,
      clean: true,
      params,
      migrations: selected.migrations,
    }
    if (!record.repository)
      throw new Error('无法确定去凭据的 HTTPS 模板来源，请为本地模板配置 origin')
    await writeFile(join(project, '.template-base.json'), serializeBaseRecord(record), {
      flag: 'wx',
    })
    if (selected.score > threshold)
      log(`警告：候选差异 ${selected.score} 超过 ${threshold} 行阈值，已使用 --force 写入基准。`)
    log(`已写入 .template-base.json：${selected.commit}；未创建 Git 提交`)
    return { ...result, status: 'written', record }
  } finally {
    await clone.cleanup()
    await rm(work, { recursive: true, force: true })
  }
}

/** CLI adapter used by template-sync.mjs. */
export async function inferCommand(args) {
  const { values } = parseArgs({
    args,
    options: {
      project: { type: 'string' },
      template: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      'generation-commit': { type: 'string' },
      param: { type: 'string', multiple: true },
      write: { type: 'string' },
      force: { type: 'boolean' },
      threshold: { type: 'string' },
    },
  })
  if (!values.project)
    throw new Error('infer-base 需要 --project <路径>，可选 --template <URL|路径>')
  await runInfer({
    ...values,
    generationCommit: values['generation-commit'],
    params: values.param ?? [],
  })
  return 0
}
