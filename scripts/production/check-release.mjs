import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * 生产发布前置校验（production-deployment spec）：被发布的提交必须在 main 历史上，
 * 且该完整 SHA 有一次成功的 `Deploy staging` 运行。任一不满足即在迁移前失败。
 * 只输出结论，不输出 API 响应正文。
 */
export async function checkRelease(sha, { isOnMain, stagingRuns, write = console.error }) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) {
    write('release check: expected a full 40-character commit SHA')
    return 1
  }
  if (!(await isOnMain(sha))) {
    write(`release check: ${sha} is not on main`)
    return 1
  }
  const runs = await stagingRuns(sha)
  const ok = runs.some((run) => run.head_sha === sha && run.conclusion === 'success')
  if (!ok) {
    write(`release check: ${sha} has no successful Deploy staging run`)
    return 1
  }
  write(`release check: ${sha} is on main and was deployed to staging`)
  return 0
}

async function isOnMainViaGit(sha) {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'])
    return true
  } catch {
    return false
  }
}

async function stagingRunsViaGh(sha) {
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) throw new Error('GITHUB_REPOSITORY is required')
  const { stdout } = await execFileAsync('gh', [
    'api',
    `repos/${repo}/actions/workflows/deploy-staging.yml/runs?head_sha=${sha}&status=success&per_page=20`,
    '--jq',
    '[.workflow_runs[] | {head_sha, conclusion}]',
  ])
  return JSON.parse(stdout)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await checkRelease(process.argv[2], {
    isOnMain: isOnMainViaGit,
    stagingRuns: stagingRunsViaGh,
  })
}
