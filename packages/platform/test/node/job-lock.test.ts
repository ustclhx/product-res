import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { holdNodeJobLock, nodeJobLockReleased } from '../../src/node/job-guard.ts'

const helper = fileURLToPath(new URL('../../src/node/job-guard.ts', import.meta.url))

/** 独立 Node 进程持锁，以便测试真实进程退出而不是本进程内的状态。 */
async function holder(path: string, create = false) {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      `const { holdNodeJobLock } = await import(${JSON.stringify(helper)})
       try { await holdNodeJobLock(process.argv[1], { create: process.argv[2] === '1' }); process.stdout.write('held\\n') }
       catch { process.stdout.write('refused\\n') }
       setInterval(() => {}, 1000)`,
      path,
      create ? '1' : '0',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stderr.resume()
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const result = await new Promise<string>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', () => reject(new Error('Lock holder exited early')))
    child.stdout.once('data', (value) => resolve(String(value).trim()))
  })
  return { child, exited, result }
}

async function kill(process: { child: ChildProcess; exited: Promise<void> }) {
  process.child.kill('SIGKILL')
  await process.exited
}

describe.runIf(process.platform === 'linux')('Linux process-lifetime kernel lock', () => {
  it('stays held by a live process after the flock helper exits and is released by real exit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'job-lock-'))
    const path = join(directory, 'executor.lock')
    const first = await holder(path)
    try {
      expect(first.result).toBe('held')
      expect(await nodeJobLockReleased(path)).toBe(false)
      const duplicate = await holder(path)
      expect(duplicate.result).toBe('refused')
      await kill(duplicate)
      await expect(holdNodeJobLock(path)).rejects.toMatchObject({
        code: 'JOB_ENGINE_EXECUTOR_IN_USE',
      })
      await kill(first)
      // 内核在进程退出时同步释放；不需要 sleep、TTL 或 PID 推断。
      expect(await nodeJobLockReleased(path)).toBe(true)
      const next = await holder(path)
      expect(next.result).toBe('held')
      await kill(next)
    } finally {
      await kill(first)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('never treats a missing lock file as exit proof and never creates one while probing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'job-lock-missing-'))
    const path = join(directory, 'token.lock')
    try {
      expect(await nodeJobLockReleased(path)).toBe(false)
      expect(existsSync(path)).toBe(false)
      const token = await holder(path, true)
      expect(token.result).toBe('held')
      // 新 token 锁必须是新文件；已有文件不能被另一个 incarnation 当作自己的 token 锁。
      const reused = await holder(path, true)
      expect(reused.result).toBe('refused')
      await kill(reused)
      await kill(token)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
