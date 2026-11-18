import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const fullSha = /^[0-9a-f]{40}$/

export async function checkRollback(
  target,
  { currentVersion, isAncestor, addedMigrations, migrationSql, write = console.error },
) {
  try {
    const current = await currentVersion()
    if (!fullSha.test(target ?? '') || !fullSha.test(current ?? '')) {
      write('rollback check: target and production health version must be full commit SHAs')
      return 1
    }
    if (target === current || (await isAncestor(current, target))) {
      write('rollback check: same version or forward release')
      return 0
    }
    if (!(await isAncestor(target, current))) {
      write('rollback check: versions have divergent history; use a forward fix')
      return 1
    }
    const files = await addedMigrations(target, current)
    for (const file of files) {
      // 声明必须来自已运行版本，不能用目标 tag 或后补注释冒充已部署的兼容约定。
      const sql = await migrationSql(current, file)
      if (!/^\s*-- rollback-safe:[ \t]*\S[^\r\n]*$/m.test(sql)) {
        write(`rollback check: ${file} lacks -- rollback-safe: <reason>; use a forward fix`)
        return 1
      }
      write(`rollback check: compatible migration ${file}`)
    }
    write(`rollback check: ${files.length} newer migrations are compatible`)
    return 0
  } catch {
    // git / health 的原始错误可能含地址或凭据，只输出脱敏结论。
    write(
      'rollback check: cannot verify production version or migration history; use a forward fix',
    )
    return 1
  }
}

async function git(args) {
  return (await execFileAsync('git', args)).stdout.trim()
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await checkRollback(process.argv[2], {
    currentVersion: async () => {
      const url = new URL('/api/health', process.env.PRODUCTION_URL)
      if (url.protocol !== 'https:') throw new Error('HTTPS is required')
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' })
      if (!response.ok) throw new Error('health unavailable')
      return (await response.json()).version
    },
    isAncestor: async (a, b) => {
      try {
        await git(['merge-base', '--is-ancestor', a, b])
        return true
      } catch (error) {
        if (error.code === 1) return false
        throw error
      }
    },
    addedMigrations: async (target, current) => {
      const files = await git([
        'diff',
        '--name-only',
        '--diff-filter=A',
        target,
        current,
        '--',
        'packages/db/migrations/*.sql',
      ])
      return files ? files.split('\n') : []
    },
    migrationSql: (current, file) => git(['show', `${current}:${file}`]),
  })
}
