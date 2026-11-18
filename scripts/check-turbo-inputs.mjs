#!/usr/bin/env node
// CI 会持久化 Turbo 本地缓存（.github/workflows/ci.yml）。任务 hash 只覆盖本包文件、依赖闭包、
// globalDependencies 与显式声明的 inputs；源码用相对路径读取或导入这些范围之外的仓库文件时，
// 那个文件改动不会使缓存失效，CI 会回放旧的通过结果。本检查把这类引用列为违规。
// 只识别字面量相对路径（'../x'、`../x`）；拼接出的动态路径无法静态发现，需在评审中把关。
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const CACHED_TASKS = ['build', 'typecheck', 'test']
// 测试、夹具与 e2e 文件不进入构建产物，只要求 typecheck 与 test 覆盖其引用
const TEST_FILE = /(?:^|\/)(?:test|tests|e2e|e2e-live|__tests__|fixtures)\/|\.(?:test|spec)\.[^/]+$/
const SOURCE = /\.(?:[cm]?[jt]sx?|jsonc?)$/
const LITERAL = /['"`]((?:\.\.?\/)+[^'"`\s$?#]*)/g
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

/** turbo.json 允许注释与尾逗号 */
export function parseJsonc(text) {
  const stripped = text.replace(
    /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_match, string) => string ?? '',
  )
  return JSON.parse(stripped.replace(/,(\s*[}\]])/g, '$1'))
}

/** 只支持本仓库 turbo.json 用到的 glob：`**`、`*` 与精确路径 */
export function globToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      out += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (c === '*') out += '[^/]*'
    else out += c.replace(/[.+^${}()|[\]\\?]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

function closure(names, byName) {
  const seen = new Set()
  const stack = [...names]
  while (stack.length) {
    const name = stack.pop()
    if (seen.has(name) || !byName.has(name)) continue
    seen.add(name)
    stack.push(...byName.get(name).deps)
  }
  return seen
}

/**
 * @param {{
 *   files: string[],
 *   read: (file: string) => string,
 *   rootDeps: string[],
 *   rootTurbo: { globalDependencies?: string[], tasks?: Record<string, any> },
 *   packages: { dir: string, name: string, deps: string[], scripts: string[], turbo?: { tasks?: Record<string, any> } }[],
 * }} repo
 */
export function findCacheHazards(repo) {
  const byName = new Map(repo.packages.map((pkg) => [pkg.name, pkg]))
  const tracked = new Set(repo.files)
  const dirsOf = (names) => [...names].map((name) => byName.get(name).dir)
  const globalDirs = dirsOf(closure(repo.rootDeps, byName))
  const globalGlobs = (repo.rootTurbo.globalDependencies ?? []).map(globToRegExp)
  const inside = (file, dir) => file === dir || file.startsWith(`${dir}/`)
  const violations = []

  for (const pkg of repo.packages) {
    const tasks = CACHED_TASKS.filter((task) => pkg.scripts.includes(task))
      .map((task) => ({
        task,
        config: { ...repo.rootTurbo.tasks?.[task], ...pkg.turbo?.tasks?.[task] },
      }))
      .filter(({ config }) => config.cache !== false)
    if (!tasks.length) continue
    const depDirs = dirsOf(closure([pkg.name], byName))
    const refs = new Map()
    for (const file of repo.files) {
      if (!inside(file, pkg.dir) || !SOURCE.test(file)) continue
      for (const [, spec] of repo.read(file).matchAll(LITERAL)) {
        const target = posix.normalize(posix.join(posix.dirname(file), spec)).replace(/\/$/, '')
        // 指向包本身或其祖先目录（仓库根、apps/）的是基准路径，后续拼接无法静态追踪
        if (target.startsWith('..') || target === '.' || inside(target, pkg.dir)) continue
        if (inside(pkg.dir, target)) continue
        // 未跟踪的目标（.env.worktree、生成物、测试输出）不在 CI checkout 中，不影响缓存
        const hits = tracked.has(target)
          ? [target]
          : repo.files.filter((f) => f.startsWith(`${target}/`))
        if (!hits.length) continue
        const key = `${target}\0${TEST_FILE.test(file.slice(pkg.dir.length))}`
        if (!refs.has(key)) refs.set(key, { target, from: file, hits })
      }
    }
    for (const { target, from, hits } of refs.values()) {
      const testOnly = TEST_FILE.test(from.slice(pkg.dir.length))
      for (const { task, config } of tasks) {
        if (testOnly && task === 'build') continue
        const explicit = (config.dependsOn ?? [])
          .filter((dep) => dep.includes('#') && !dep.startsWith('#'))
          .map((dep) => dep.split('#')[0])
        const dirs = [...globalDirs, ...depDirs, ...dirsOf(closure(explicit, byName))]
        const globs = [
          ...globalGlobs,
          ...(config.inputs ?? [])
            .filter((input) => input.startsWith('$TURBO_ROOT$/'))
            .map((input) => globToRegExp(input.slice('$TURBO_ROOT$/'.length))),
        ]
        const uncovered = hits.find(
          (file) => !dirs.some((dir) => inside(file, dir)) && !globs.some((re) => re.test(file)),
        )
        if (uncovered)
          violations.push(
            `${pkg.name}#${task}: ${from} 引用 ${target}，不在任务 hash 内（${uncovered}）。` +
              '在该包 turbo.json 的 inputs 加 $TURBO_ROOT$/…、加入根 globalDependencies，或对该任务设 cache: false',
          )
      }
    }
  }
  return violations
}

export function readRepo(root = ROOT) {
  const files = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  const manifest = (dir) => JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
  const workspaceDeps = (json) =>
    DEP_FIELDS.flatMap((field) =>
      Object.entries(json[field] ?? {})
        .filter(([, version]) => String(version).startsWith('workspace:'))
        .map(([name]) => name),
    )
  const packages = ['apps', 'packages'].flatMap((group) =>
    existsSync(join(root, group))
      ? readdirSync(join(root, group))
          .map((name) => `${group}/${name}`)
          .filter((dir) => existsSync(join(root, dir, 'package.json')))
          .map((dir) => {
            const json = manifest(dir)
            const turbo = join(root, dir, 'turbo.json')
            return {
              dir,
              name: json.name,
              deps: workspaceDeps(json),
              scripts: Object.keys(json.scripts ?? {}),
              turbo: existsSync(turbo) ? parseJsonc(readFileSync(turbo, 'utf8')) : undefined,
            }
          })
      : [],
  )
  return {
    files,
    read: (file) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : ''),
    rootDeps: workspaceDeps(manifest('.')),
    rootTurbo: parseJsonc(readFileSync(join(root, 'turbo.json'), 'utf8')),
    packages,
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const violations = findCacheHazards(readRepo(dirname(import.meta.dirname)))
  for (const line of violations) console.error(line)
  if (violations.length) process.exitCode = 1
  else console.log('turbo 缓存输入检查通过')
}
