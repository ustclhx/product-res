import { type ChildProcess, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createDb } from '@product-res/db'
import { sql } from 'drizzle-orm'
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import type { NodeScheduleDefinition } from '../../src/node/scheduler.ts'

export const schedulerAttempts = pgTable('test_scheduler_attempt', {
  runId: text('run_id').notNull(),
  scheduleId: text('schedule_id').notNull(),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
  workflowId: text('workflow_id').notNull(),
  executorId: text('executor_id').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
})
export const schedulerEffects = pgTable('test_scheduler_effect', {
  runId: text('run_id').notNull(),
  scheduleId: text('schedule_id').notNull(),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
})
export interface SchedulerWorkerConfig {
  runId: string
  executorId: string
  ownershipDirectory: string
  prepareAt?: string
  fault?: 'claimed-before-publish' | 'finish-after-checkpoint'
  schedules: (NodeScheduleDefinition & {
    mode?: 'pause-once' | 'gated' | 'heartbeat'
    holdMs?: number
  })[]
}
export interface SchedulerWorker {
  child: ChildProcess
  output(): string
  wait(event: string, timeoutMs?: number): Promise<Record<string, unknown>>
  send(command: string, now?: string): void
  stop(signal?: NodeJS.Signals): Promise<void>
}
export function schedulerWorker(config: SchedulerWorkerConfig): SchedulerWorker {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      fileURLToPath(new URL('./fixtures/scheduler-worker.ts', import.meta.url)),
    ],
    {
      env: { ...process.env, TEST_SCHEDULER_WORKER_CONFIG: JSON.stringify(config) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  )
  let output = ''
  const messages: Record<string, unknown>[] = []
  const waiters = new Set<() => void>()
  child.stdout?.on('data', (chunk) => {
    output += String(chunk)
  })
  child.stderr?.on('data', (chunk) => {
    output += String(chunk)
  })
  child.on('message', (message) => {
    if (typeof message !== 'object' || message === null) return
    messages.push(message as Record<string, unknown>)
    for (const notify of waiters) notify()
  })
  return {
    child,
    output: () => output,
    send: (command, now) => {
      child.send({ command, now })
    },
    wait(event, timeoutMs = 30_000) {
      return new Promise((resolve, reject) => {
        const finish = () => {
          const failed = messages.find(
            (message) =>
              message.event === 'command-failed' ||
              (event === 'ready' && message.event === 'startup-failed'),
          )
          if (failed) {
            clearTimeout(timer)
            waiters.delete(finish)
            reject(new Error(`Scheduler command failed: ${failed.code}`))
            return
          }
          const index = messages.findIndex((message) => message.event === event)
          if (index < 0) return
          clearTimeout(timer)
          waiters.delete(finish)
          resolve(messages.splice(index, 1)[0] as Record<string, unknown>)
        }
        const timer = setTimeout(() => {
          waiters.delete(finish)
          reject(new Error(`Scheduler did not reach ${event}; exit=${child.exitCode}`))
        }, timeoutMs)
        waiters.add(finish)
        finish()
      })
    },
    async stop(signal = 'SIGTERM') {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.kill(signal)
      const timer = setTimeout(() => child.kill('SIGKILL'), 6_000)
      try {
        await exited
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
export async function prepareSchedulerTestTables(url: string) {
  const db = createDb(url, { max: 1, onnotice: () => {} })
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS test_scheduler_attempt (
      run_id text NOT NULL, schedule_id text NOT NULL, scheduled_at timestamptz NOT NULL,
      workflow_id text NOT NULL, executor_id text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz)`)
    await db.execute(sql`CREATE TABLE IF NOT EXISTS test_scheduler_effect (
      run_id text NOT NULL, schedule_id text NOT NULL, scheduled_at timestamptz NOT NULL,
      PRIMARY KEY(run_id,schedule_id,scheduled_at))`)
    await db.execute(sql`GRANT SELECT, INSERT, UPDATE, DELETE ON
      test_scheduler_attempt, test_scheduler_effect TO app`)
  } finally {
    await db.close()
  }
}
