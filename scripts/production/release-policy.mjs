import { execFile } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const fullSha = /^[0-9a-f]{40}$/
const escapeCommand = (value) =>
  value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
const escapeHtml = (value) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

export function jobSummary(value) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${value}\n`)
}

export function policyEnv(env = process.env) {
  return {
    phase: env.RELEASE_PHASE || 'live',
    event: env.GITHUB_EVENT_NAME,
    bypass: env.RELEASE_BYPASS || 'none',
    reason: env.RELEASE_REASON || '',
    actor: env.GITHUB_ACTOR || 'unknown',
  }
}

export async function ciRunsViaGh(sha) {
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) throw new Error('GITHUB_REPOSITORY is required')
  const { stdout } = await execFileAsync('gh', [
    'api',
    `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&branch=main&event=push&status=success&per_page=100`,
    '--jq',
    '[.workflow_runs[] | {head_sha, head_branch, event, conclusion}]',
  ])
  return JSON.parse(stdout)
}

export async function isOnMainViaGit(sha) {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'])
    return true
  } catch {
    return false
  }
}

export async function checkCi(
  sha,
  {
    phase = 'live',
    event,
    bypass = 'none',
    reason = '',
    actor = 'unknown',
    ciRuns = ciRunsViaGh,
    write = console.error,
    summary = jobSummary,
  } = {},
) {
  if (!fullSha.test(sha ?? '') || !['testing', 'live'].includes(phase)) {
    write('release check: full commit SHA and RELEASE_PHASE=testing|live are required')
    return 1
  }
  if (
    !['none', 'hotfix'].includes(bypass) ||
    (bypass === 'hotfix' && (event !== 'workflow_dispatch' || !reason.trim()))
  ) {
    write('release check: hotfix bypass requires workflow_dispatch and a nonempty reason')
    return 1
  }
  if (phase === 'testing' || bypass === 'hotfix') {
    const record = {
      type: phase === 'testing' ? 'testing' : 'hotfix',
      reason: phase === 'testing' ? reason.trim() || 'RELEASE_PHASE=testing' : reason.trim(),
      actor,
      sha,
    }
    write(
      `::warning::CI bypass ${escapeCommand(`type=${record.type} reason=${record.reason} actor=${record.actor} sha=${sha}`)}`,
    )
    summary(`CI bypass\n<pre>${escapeHtml(JSON.stringify(record, null, 2))}</pre>`)
    return 0
  }
  const runs = await ciRuns(sha)
  if (
    !runs.some(
      (run) =>
        run.head_sha === sha &&
        run.head_branch === 'main' &&
        run.event === 'push' &&
        run.conclusion === 'success',
    )
  ) {
    write(`release check: ${sha} has no successful CI push run on main`)
    return 1
  }
  write(`release check: ${sha} passed CI on main`)
  return 0
}

export function checkSentry(
  env = process.env,
  { write = console.error, summary = jobSummary } = {},
) {
  const phase = env.RELEASE_PHASE || 'live'
  if (!['testing', 'live'].includes(phase)) {
    write('release check: RELEASE_PHASE must be testing or live')
    return 1
  }
  const missing = ['SENTRY_DSN', 'SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT'].filter(
    (name) => !env[name]?.trim(),
  )
  if (!missing.length) return 0
  const message = `Production Sentry configuration missing: ${missing.join(', ')}`
  write(`::${phase === 'testing' ? 'warning' : 'error'}::${message}`)
  summary(`Sentry ${phase === 'testing' ? 'warning' : 'error'}: ${message}`)
  return phase === 'testing' ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'sentry') {
    process.exitCode = checkSentry()
  } else {
    const sha = process.argv[2]
    if (!fullSha.test(sha ?? '') || !(await isOnMainViaGit(sha))) {
      console.error('release check: expected a full commit SHA on main')
      process.exitCode = 1
    } else {
      process.exitCode = await checkCi(sha, policyEnv())
    }
  }
}
