import type { SchedulerHealth } from './capabilities.ts'

export interface ScheduleDefinition {
  readonly id: string
  readonly cron: string
  readonly timeZone: string
  readonly missedRun: 'skip' | 'once'
}
export interface ScheduledRun {
  readonly scheduledAt: Date
}
export type ScheduledHandler = (context: ScheduledRun) => Promise<void>
export interface Scheduler {
  register(definition: ScheduleDefinition, handler: ScheduledHandler): void
  health(): Promise<SchedulerHealth>
}
