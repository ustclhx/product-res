import { type ChildProcess, spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createDb } from '@product-res/db'
import { sql } from 'drizzle-orm'
import type { JsonValue, WorkflowState } from '../../src/workflow.ts'

export interface WorkflowWorkerConfig {
  runId: string
  name: string
  executorId: string
  ownershipDirectory: string
}
export interface WorkflowWorker {
  child: ChildProcess
  output(): string
  request(command: string, fields?: Record<string, unknown>): Promise<Record<string, unknown>>
  wait(event: string, timeoutMs?: number): Promise<Record<string, unknown>>
  stop(signal?: NodeJS.Signals): Promise<void>
}

export function workflowWorker(config: WorkflowWorkerConfig): WorkflowWorker {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      fileURLToPath(new URL('./fixtures/workflow-worker.ts', import.meta.url)),
    ],
    {
      env: { ...process.env, TEST_WORKFLOW_WORKER_CONFIG: JSON.stringify(config) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  )
  let output = ''
  let sequence = 0
  const messages: Record<string, unknown>[] = []
  const listeners = new Set<() => void>()
  child.stdout?.on('data', (value) => {
    output += String(value)
  })
  child.stderr?.on('data', (value) => {
    output += String(value)
  })
  child.on('message', (value) => {
    if (value && typeof value === 'object') {
      messages.push(value as Record<string, unknown>)
      for (const listener of listeners) listener()
    }
  })
  const take = (match: (message: Record<string, unknown>) => boolean, timeoutMs: number) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const finish = () => {
        const index = messages.findIndex(match)
        if (index < 0) return
        clearTimeout(timer)
        listeners.delete(finish)
        child.off('exit', exited)
        resolve(messages.splice(index, 1)[0] as Record<string, unknown>)
      }
      const exited = () => {
        clearTimeout(timer)
        listeners.delete(finish)
        reject(new Error(`Workflow worker exited: ${child.exitCode ?? child.signalCode}`))
      }
      const timer = setTimeout(() => {
        listeners.delete(finish)
        child.off('exit', exited)
        reject(new Error('Workflow worker response timed out'))
      }, timeoutMs)
      listeners.add(finish)
      child.once('exit', exited)
      finish()
    })
  return {
    child,
    output: () => output,
    async request(command, fields = {}) {
      const requestId = ++sequence
      const response = take((message) => message.requestId === requestId, 30_000)
      child.send({ command, requestId, ...fields })
      const value = await response
      if (value.error)
        throw Object.assign(
          new Error(
            `Workflow command failed: ${(value.error as { code?: string }).code ?? 'UNKNOWN'}`,
          ),
          value.error,
        )
      return value
    },
    wait: (event, timeoutMs = 30_000) => take((message) => message.event === event, timeoutMs),
    async stop(signal = 'SIGTERM') {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.kill(signal)
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
      try {
        await exited
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

export async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (accept(value)) return value
    await delay(50)
  }
  throw new Error('Timed out waiting for persistent workflow state')
}
export async function workflowState(worker: WorkflowWorker, id: string) {
  return (await worker.request('status', { id })).state as WorkflowState<JsonValue>
}
export async function completed(worker: WorkflowWorker, id: string, timeoutMs = 30_000) {
  const state = await eventually(
    () => workflowState(worker, id),
    (value) => ['completed', 'failed', 'terminated'].includes(value.status),
    timeoutMs,
  )
  if (state.status !== 'completed') throw new Error(`Workflow ended as ${state.status}`)
  return state.output
}
export async function prepareWorkflowTestTables(url: string) {
  const db = createDb(url, { max: 1, onnotice: () => {} })
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS test_workflow_attempt (
      run_id text NOT NULL, key text NOT NULL, step text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT clock_timestamp())`)
    await db.execute(sql`CREATE TABLE IF NOT EXISTS test_workflow_effect (
      run_id text NOT NULL, key text NOT NULL, step text NOT NULL,
      PRIMARY KEY (run_id,key,step))`)
    await db.execute(sql`GRANT SELECT,INSERT,UPDATE,DELETE ON
      test_workflow_attempt,test_workflow_effect TO app`)
  } finally {
    await db.close()
  }
}
