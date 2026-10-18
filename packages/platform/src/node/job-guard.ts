import { spawn } from 'node:child_process'
import { closeSync, constants, fstatSync, openSync, statSync } from 'node:fs'
import { AppError } from '@product-res/shared'

// 锁属于本进程持有的打开文件描述；只有进程真正退出（含 SIGKILL/OOM/reboot）后内核才释放。
// 描述符刻意永不关闭：close 后仍可能有未合作 callback，不能提前让出 executor。
const held: number[] = []

function failure(): AppError {
  return new AppError('JOB_ENGINE_EXECUTOR_IN_USE', 'Node job engine executor is in use', {
    status: 503,
  })
}

/** flock(1) 只对继承的同一打开文件描述加锁后立即退出，锁仍由本进程的描述符承载。 */
function flockDescriptor(fd: number, mode: '-x' | '-s'): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('flock', ['-n', mode, '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] })
    child.once('error', () => resolve(false))
    child.once('close', (code) => resolve(code === 0))
  })
}

/**
 * 在共享 ownership 卷上取得进程生命周期内的排他锁。同一宿主内核上不同容器/PID namespace
 * 对同一 inode 的 flock 互斥，因此无需共享宿主 PID namespace 即可拒绝仍存活的旧进程。
 */
export async function holdNodeJobLock(path: string, options?: { create?: boolean }) {
  if (process.platform !== 'linux') return
  const flags =
    constants.O_RDWR |
    constants.O_NOFOLLOW |
    constants.O_CREAT |
    (options?.create ? constants.O_EXCL : 0)
  let fd: number
  try {
    fd = openSync(path, flags, 0o600)
  } catch {
    throw failure()
  }
  try {
    if (!(await flockDescriptor(fd, '-x'))) throw failure()
    // 锁文件被替换后会锁住孤立 inode；路径必须仍指向已加锁的同一文件。
    const opened = fstatSync(fd)
    const named = statSync(path)
    if (opened.dev !== named.dev || opened.ino !== named.ino) throw failure()
  } catch {
    closeSync(fd)
    throw failure()
  }
  held.push(fd)
}

/** 只在锁文件存在且无人持有时证明其 incarnation 已退出；缺失、打不开或调用失败都拒绝。 */
export async function nodeJobLockReleased(path: string): Promise<boolean> {
  if (process.platform !== 'linux') return false
  let fd: number
  try {
    // 不创建：缺失的锁文件不是退出证明，探测也不得留下一个空闲锁冒充旧 owner。
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return false
  }
  try {
    return await flockDescriptor(fd, '-s')
  } finally {
    closeSync(fd)
  }
}
