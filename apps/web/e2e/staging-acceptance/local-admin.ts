import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseEnv } from 'node:util'

// worktree 没有被忽略的 .env.local；经共享的 git 目录定位主 checkout，不写死本机路径。
function mainLocalEnv() {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: import.meta.dirname,
    encoding: 'utf8',
  }).trim()
  return join(dirname(common), '.env.local')
}

export function readLocalAdminCredentials(env = process.env, envFile?: string) {
  let fileEnv: Record<string, string | undefined> = {}
  if (env.LOCAL_ADMIN_EMAIL === undefined || env.LOCAL_ADMIN_PASSWORD === undefined) {
    try {
      fileEnv = parseEnv(readFileSync(envFile ?? mainLocalEnv(), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  // 仅返回本地管理员键，不把主 checkout 的远程目标或其他密钥注入进程。
  const email = (env.LOCAL_ADMIN_EMAIL ?? fileEnv.LOCAL_ADMIN_EMAIL)?.trim().toLowerCase()
  const password = env.LOCAL_ADMIN_PASSWORD ?? fileEnv.LOCAL_ADMIN_PASSWORD
  return email && password ? { email, password } : undefined
}
