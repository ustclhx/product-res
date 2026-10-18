import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { nodeJobLockReleased } from './job-guard.ts'

export interface ProcessOwner {
  readonly pid: number
  readonly host: string
  readonly pidNamespace: string
  readonly token: string
  // 旧 Linux 记录缺宿主身份或 token 锁时必须人工核验迁移，不能自动接管。
  readonly machineId?: string
  readonly bootId?: string
  readonly startTime?: string
}

async function processStartTime(pid: number): Promise<string> {
  const value = await readFile(`/proc/${pid}/stat`, 'utf8')
  // comm 可以含空格和括号，最后一个 ')' 之后才是从 field 3 开始的字段。
  const end = value.lastIndexOf(')')
  const fields = value
    .slice(end + 1)
    .trim()
    .split(/\s+/)
  const startTime = fields[19]
  if (!value.startsWith(`${pid} (`) || end < 0 || !startTime || !/^\d+$/.test(startTime))
    throw new Error('Invalid Linux process identity')
  return startTime
}

export async function processOwner(): Promise<ProcessOwner> {
  const base = { pid: process.pid, host: hostname(), token: randomUUID() }
  if (process.platform !== 'linux') return { ...base, pidNamespace: 'host' }
  const machineId = (await readFile(process.env.JOB_HOST_ID_FILE ?? '/etc/machine-id', 'utf8'))
    .trim()
    .toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(machineId) || /^0+$/.test(machineId))
    throw new Error('Invalid Linux host identity')
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(bootId))
    throw new Error('Invalid Linux boot identity')
  const namespace = await stat('/proc/self/ns/pid')
  if (!Number.isSafeInteger(namespace.ino) || namespace.ino <= 0)
    throw new Error('Invalid Linux PID namespace')
  return {
    ...base,
    machineId,
    pidNamespace: String(namespace.ino),
    bootId,
    startTime: await processStartTime(process.pid),
  }
}

function pidExited(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return !!error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'
  }
}

export async function processExited(
  owner: ProcessOwner,
  current: ProcessOwner,
  lockPath?: string,
): Promise<boolean> {
  if (owner.host !== current.host) return false
  if (process.platform === 'linux') {
    // flock 只在同一宿主内核内有效；恢复到另一台机器的卷没有持锁者，不能据此证明旧机退出。
    if (!owner.machineId || owner.machineId !== current.machineId || !lockPath) return false
    // 旧 incarnation 在写记录前已对自己的 token 锁加排他锁并持有到进程退出；不同容器、
    // PID namespace 或 reboot 后都由内核释放，无需共享宿主 PID namespace 或推断 PID 复用。
    return nodeJobLockReleased(lockPath)
  }
  if (owner.pidNamespace !== current.pidNamespace) return false
  return pidExited(owner.pid)
}
