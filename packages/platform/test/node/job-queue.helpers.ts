import { type ChildProcess, spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createDb } from '@product-res/db'
import { sql } from 'drizzle-orm'
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const effects = pgTable('test_job_engine_effect', {
  runId: text('run_id').notNull(),
  key: text('key').notNull(),
})
export const attempts = pgTable('test_job_engine_attempt', {
  runId: text('run_id').notNull(),
  messageId: text('message_id').notNull(),
  key: text('key').notNull(),
  queue: text('queue').notNull(),
  executorId: text('executor_id').notNull(),
  batchId: text('batch_id').notNull(),
  batchSize: integer('batch_size').notNull(),
  attempt: integer('attempt').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
})

export interface Body {
  key: string
  mode?: 'retry' | 'retry-once' | 'invalid' | 'permanent' | 'before-ack' | undefined
  holdMs?: number
  privateContent?: string
}
export interface WorkerConfig {
  runId: string
  executorId: string
  ownershipDirectory: string
  queues: {
    name: string
    policy?:
      | {
          batchSize?: number
          batchTimeoutMs?: number
          concurrency?: number
          rateLimit?: { limit: number; periodMs: number }
        }
      | undefined
  }[]
  fault?: 'claimed' | 'accepted' | undefined
}
export interface Worker {
  child: ChildProcess
  output: () => string
  wait: (event: string, timeoutMs?: number) => Promise<Record<string, unknown>>
  send: (command: string, queue?: string) => void
  stop: (signal?: NodeJS.Signals) => Promise<void>
}

export function worker(config: WorkerConfig): Worker {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      fileURLToPath(new URL('./fixtures/job-worker.ts', import.meta.url)),
    ],
    {
      env: { ...process.env, TEST_JOB_WORKER_CONFIG: JSON.stringify(config) },
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
    if (typeof message === 'object' && message !== null) {
      messages.push(message as Record<string, unknown>)
      for (const notify of waiters) notify()
    }
  })
  return {
    child,
    output: () => output,
    send: (command, queue) => {
      child.send({ command, queue })
    },
    wait(event, timeoutMs = 30_000) {
      return new Promise((resolve, reject) => {
        const finish = () => {
          const failed = messages.find((message) => message.event === 'command-failed')
          if (failed) {
            clearTimeout(timer)
            waiters.delete(finish)
            reject(new Error(`Worker command failed: ${failed.code}`))
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
          reject(new Error(`Worker did not reach ${event}; exit=${child.exitCode}`))
        }, timeoutMs)
        waiters.add(finish)
        finish()
      })
    },
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

export async function until(predicate: () => Promise<boolean>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(100)
  }
  throw new Error('Timed out waiting for persistent queue state')
}

export async function prepareTestTables(url: string) {
  const db = createDb(url, { max: 1, onnotice: () => {} })
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS test_job_engine_effect (
      run_id text NOT NULL, key text NOT NULL, PRIMARY KEY(run_id,key))`)
    await db.execute(sql`CREATE TABLE IF NOT EXISTS test_job_engine_attempt (
      run_id text NOT NULL, message_id text NOT NULL, key text NOT NULL,
      queue text NOT NULL, executor_id text NOT NULL, batch_id text NOT NULL,
      batch_size integer NOT NULL, attempt integer NOT NULL,
      started_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz)`)
    await db.execute(sql`GRANT SELECT, INSERT, UPDATE, DELETE ON
      test_job_engine_effect, test_job_engine_attempt TO app`)
  } finally {
    await db.close()
  }
}
