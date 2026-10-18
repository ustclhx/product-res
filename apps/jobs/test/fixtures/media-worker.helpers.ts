import { type ChildProcess, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { NodeStorageConfig } from '@product-res/config/node'

export function startMediaWorker(
  config: {
    executorId: string
    ownershipDirectory: string
    storage: NodeStorageConfig
    secret: string
    crashAfter?: 'persist' | 'settle-and-notify'
  },
  counts: Map<string, number>,
) {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', fileURLToPath(new URL('./media-worker.ts', import.meta.url))],
    {
      env: { ...process.env, TEST_MEDIA_WORKER_CONFIG: JSON.stringify(config) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  )
  // 消费日志避免 pipe 背压；驱动/SDK错误不连同临时配置暴露给测试报告。
  child.stdout?.resume()
  child.stderr?.resume()
  const messages: Record<string, unknown>[] = []
  const listeners = new Set<() => void>()
  child.on('message', (value) => {
    if (!value || typeof value !== 'object') return
    const message = value as Record<string, unknown>
    if (['submit', 'download', 'cancel'].includes(String(message.event))) {
      const event = String(message.event)
      counts.set(event, (counts.get(event) ?? 0) + 1)
    }
    messages.push(message)
    for (const listener of listeners) listener()
  })
  const wait = (event: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const finish = () => {
        const index = messages.findIndex((message) => message.event === event)
        if (index === -1) return
        clearTimeout(timer)
        listeners.delete(finish)
        child.off('exit', exited)
        resolve(messages.splice(index, 1)[0] as Record<string, unknown>)
      }
      const exited = () => {
        clearTimeout(timer)
        listeners.delete(finish)
        reject(new Error(`Node media worker exited: ${child.exitCode ?? child.signalCode}`))
      }
      const timer = setTimeout(() => {
        listeners.delete(finish)
        child.off('exit', exited)
        reject(new Error('Node media worker IPC timed out'))
      }, 30_000)
      listeners.add(finish)
      child.once('exit', exited)
      finish()
      if (child.exitCode !== null || child.signalCode !== null) exited()
    })
  return {
    child,
    wait,
    async exited() {
      if (child.exitCode !== null || child.signalCode !== null) return
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    },
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      await stopChild(child, signal)
    },
  }
}

async function stopChild(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill(signal)
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
  try {
    await exited
  } finally {
    clearTimeout(timer)
  }
}
