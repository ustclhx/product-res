import { spawnSync } from 'node:child_process'

// 调用者环境中的仓库定位变量会把命令导向错误的仓库或索引。
const repoVariables = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]

/**
 * Child-process environment without variables that redirect Git to another repository.
 * @param {Record<string, string>} [extra] Variables to add.
 * @returns {NodeJS.ProcessEnv}
 */
export function gitEnv(extra = {}) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...extra }
  for (const key of repoVariables) delete env[key]
  return env
}

/**
 * Run git and return the raw result without throwing.
 * @param {string} cwd Working directory.
 * @param {string[]} args Git arguments.
 * @param {{input?: string | Buffer, env?: Record<string, string>, encoding?: BufferEncoding | 'buffer'}} [options]
 * @returns {{status: number | null, stdout: string, stderr: string}}
 */
export function gitRaw(cwd, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd,
    input: options.input,
    env: gitEnv(options.env),
    encoding: options.encoding === 'buffer' ? undefined : 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  })
  if (result.error) throw result.error
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: typeof result.stderr === 'string' ? result.stderr : result.stderr.toString('utf8'),
  }
}

/**
 * Run git and return trimmed stdout; a non-zero exit throws with stderr.
 * @param {string} cwd Working directory.
 * @param {string[]} args Git arguments.
 * @param {{input?: string | Buffer, env?: Record<string, string>, trim?: boolean}} [options]
 * @returns {string}
 */
export function git(cwd, args, options = {}) {
  const result = gitRaw(cwd, args, options)
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} 失败：${result.stderr.trim() || `退出码 ${result.status}`}`)
  }
  return options.trim === false ? result.stdout : result.stdout.trim()
}
