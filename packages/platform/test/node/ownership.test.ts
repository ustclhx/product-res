import { readFile, stat } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nodeJobLockReleased } from '../../src/node/job-guard.ts'
import { type ProcessOwner, processExited, processOwner } from '../../src/node/job-owner.ts'

vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), stat: vi.fn() }))
vi.mock('../../src/node/job-guard.ts', () => ({ nodeJobLockReleased: vi.fn() }))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')
if (!platform) throw new Error('Process platform descriptor required')
const bootId = 'c5617dba-a32f-4032-9bcb-3e04fe1a8c18'
const machineId = 'fac4633b0e7e4cfe97c7b3b983e8cf86'
const current: ProcessOwner = {
  pid: 1,
  host: 'jobs-host',
  pidNamespace: '4026533001',
  token: 'current-token',
  machineId,
  bootId,
  startTime: '1000',
}
const previous: ProcessOwner = { ...current, token: 'previous-token' }
const lock = '/owners/previous.lock'
// /proc stat 的 field 22 是从 state（field 3）起的第 20 项。
const procStat = (pid: number, startTime: string) =>
  `${pid} (job (worker) name) S ${Array(18).fill('0').join(' ')} ${startTime} 0 0\n`

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  vi.mocked(readFile).mockResolvedValue(procStat(1, '1000'))
  vi.mocked(nodeJobLockReleased).mockResolvedValue(false)
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})

describe('Node executor incarnation ownership', () => {
  it('captures trusted host, boot, namespace and start time even when comm contains spaces and parentheses', async () => {
    vi.stubEnv('JOB_HOST_ID_FILE', '/run/job-host/machine-id')
    vi.mocked(readFile).mockImplementation(async (path) =>
      path === '/run/job-host/machine-id'
        ? `${machineId}\n`
        : path === '/proc/sys/kernel/random/boot_id'
          ? `${bootId}\n`
          : procStat(process.pid, '987654321'),
    )
    vi.mocked(stat).mockResolvedValue({ ino: 4026533001 } as Awaited<ReturnType<typeof stat>>)
    expect(await processOwner()).toMatchObject({
      pid: process.pid,
      machineId,
      bootId,
      pidNamespace: '4026533001',
      startTime: '987654321',
    })
  })

  it('proves exit only by the kernel releasing the old token lock, across namespaces and boots', async () => {
    for (const owner of [
      previous,
      { ...previous, pidNamespace: '4026532999' },
      { ...previous, bootId: 'e887606c-377a-4a0e-afaf-cb8d10074546' },
    ]) {
      vi.mocked(nodeJobLockReleased).mockResolvedValueOnce(false)
      expect(await processExited(owner, current, lock)).toBe(false)
      vi.mocked(nodeJobLockReleased).mockResolvedValueOnce(true)
      expect(await processExited(owner, current, lock)).toBe(true)
    }
    expect(nodeJobLockReleased).toHaveBeenCalledWith(lock)
    // PID 号、/proc 与 boot ID 不再作为 Linux 退出证明，避免依赖共享宿主 PID namespace。
    expect(readFile).not.toHaveBeenCalled()
  })

  it('refuses a different machine even when hostname matches and its lock is free', async () => {
    vi.mocked(nodeJobLockReleased).mockResolvedValue(true)
    expect(
      await processExited(
        { ...previous, machineId: '04e1a5188f9743f2b8d0a355a96c1c0a' },
        current,
        lock,
      ),
    ).toBe(false)
    expect(await processExited({ ...previous, host: 'other-host' }, current, lock)).toBe(false)
    expect(nodeJobLockReleased).not.toHaveBeenCalled()
  })

  it('refuses a legacy Linux owner without machine identity or without a lock path', async () => {
    vi.mocked(nodeJobLockReleased).mockResolvedValue(true)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error(), { code: 'ESRCH' })
    })
    const { machineId: _machineId, ...legacy } = previous
    expect(await processExited(legacy, current, lock)).toBe(false)
    expect(await processExited(previous, current)).toBe(false)
    expect(nodeJobLockReleased).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })

  it('refuses Linux startup without a reliable boot identity', async () => {
    vi.mocked(readFile).mockImplementation(async (path) =>
      path === (process.env.JOB_HOST_ID_FILE ?? '/etc/machine-id') ? machineId : 'not-a-boot-id',
    )
    await expect(processOwner()).rejects.toThrow('Invalid Linux boot identity')
  })

  it('refuses Linux startup without a valid host machine identity', async () => {
    for (const value of ['not-a-machine-id', '0'.repeat(32)]) {
      vi.mocked(readFile).mockResolvedValue(value)
      await expect(processOwner()).rejects.toThrow('Invalid Linux host identity')
    }
  })

  it('retains ESRCH-only exit proof on non-Linux hosts', async () => {
    vi.mocked(nodeJobLockReleased).mockResolvedValue(true)
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const hostOwner = { ...previous, pidNamespace: 'host' }
    const hostCurrent = { ...current, pidNamespace: 'host' }
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    expect(await processExited(hostOwner, hostCurrent)).toBe(false)
    kill.mockImplementation(() => {
      throw Object.assign(new Error(), { code: 'EPERM' })
    })
    expect(await processExited(hostOwner, hostCurrent)).toBe(false)
    kill.mockImplementation(() => {
      throw Object.assign(new Error(), { code: 'ESRCH' })
    })
    expect(await processExited(hostOwner, hostCurrent)).toBe(true)
    expect(nodeJobLockReleased).not.toHaveBeenCalled()
  })
})
