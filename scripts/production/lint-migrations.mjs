import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

export function checkIgnoreReasons(sql) {
  return sql
    .split('\n')
    .flatMap((line, index) =>
      /--\s*squawk-ignore(?:-file)?\b/.test(line) && !/--\s*reason:\s*\S.+/.test(line)
        ? [index + 1]
        : [],
    )
}

export function lintMigrations(files, write = console.log) {
  let invalid = false
  for (const file of files) {
    for (const line of checkIgnoreReasons(readFileSync(file, 'utf8'))) {
      write(`${file}:${line}: squawk ignore requires a same-line -- reason: explanation`)
      invalid = true
    }
  }
  if (invalid) return { code: 1 }
  if (!files.length) {
    write('No added migration SQL files')
    return { code: 0 }
  }
  const bin = join(dirname(require.resolve('squawk-cli/package.json')), 'js/bin/squawk')
  // Drizzle 在事务里运行迁移；同一事务中新建表的索引可安全识别。
  const result = spawnSync(process.execPath, [bin, '--assume-in-transaction', ...files], {
    encoding: 'utf8',
  })
  if (result.stdout) write(result.stdout.trimEnd())
  if (result.stderr) write(result.stderr.trimEnd())
  return { code: result.status === 0 ? 0 : 1 }
}

export function addedMigrations(base) {
  if (!base) throw new Error('Migration lint requires an explicit base revision')
  return execFileSync(
    'git',
    [
      'diff',
      '--name-only',
      '--diff-filter=A',
      '-z',
      base,
      'HEAD',
      '--',
      'packages/db/migrations/*.sql',
    ],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = lintMigrations(addedMigrations(process.argv[2])).code
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
