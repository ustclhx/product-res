import type { Scheduler } from '@product-res/platform'
import { log } from '@product-res/shared/log'

/**
 * `DATA_PIPELINE_SCHEDULES=paused` 时暂停的定时计划（add-beta-access-gate D3）：
 * 数据层每日流水线与选品 / 回看计划。`datasources-reconcile-v1` 只过期悬挂的额度预留、
 * 不访问外部数据源，保持运行。
 */
export const PAUSABLE_PIPELINE_SCHEDULES: ReadonlySet<string> = new Set([
  'datasources-daily-v1',
  'selection-daily-v1',
  'selection-label-v1',
  'selection-readiness-v1',
  'selection-review-v1',
])

/**
 * 暂停时仍向原调度器注册（健康检查与就绪门不变），只把处理函数换成记日志后返回，
 * 本次运行记为成功；队列与手动触发入口不经过这里。
 */
export function pausePipelineSchedules(
  scheduler: Scheduler,
  paused: boolean,
  ids: ReadonlySet<string> = PAUSABLE_PIPELINE_SCHEDULES,
): Scheduler {
  if (!paused) return scheduler
  return {
    register(definition, handler) {
      if (!ids.has(definition.id)) return scheduler.register(definition, handler)
      scheduler.register(definition, async () => {
        log.info('pipeline.paused', { scheduleId: definition.id })
      })
    },
    health: () => scheduler.health(),
  }
}
