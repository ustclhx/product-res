import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowTimeoutDuration,
} from 'cloudflare:workers'

/**
 * 7.2 实测用 Workflow（模拟 apps/jobs）：可选先 step.sleep，再依次 waitForEvent。
 * 每一步的时间都通过 step.do 记录（step 结果会持久化，重放时不变）。
 */
export interface ProbeParams {
  /** 进入第一个 waitForEvent 之前 step.sleep 的秒数；0 表示不 sleep */
  sleepSeconds: number
  /** 依次执行的 waitForEvent；timeout 用 Workflows 的时长字符串，如 '2 minutes' */
  waits: { type: string; timeout: string }[]
}

type WaitResult =
  | { index: number; type: string; ok: true; payload: unknown; eventTimestamp: string; at: number }
  | { index: number; type: string; ok: false; error: string; at: number }

export class ProbeWorkflow extends WorkflowEntrypoint<unknown, ProbeParams> {
  override async run(event: WorkflowEvent<ProbeParams>, step: WorkflowStep) {
    const { sleepSeconds, waits } = event.payload
    const startedAt = await step.do('start', async () => Date.now())
    if (sleepSeconds > 0) {
      await step.sleep('pre-wait sleep', `${sleepSeconds} seconds`)
    }
    const waitStartedAt = await step.do('before-wait', async () => Date.now())

    const results: WaitResult[] = []
    for (const [index, wait] of waits.entries()) {
      try {
        const ev = await step.waitForEvent(`wait-${index}`, {
          type: wait.type,
          timeout: wait.timeout as WorkflowTimeoutDuration,
        })
        const at = await step.do(`after-wait-${index}`, async () => Date.now())
        results.push({
          index,
          type: wait.type,
          ok: true,
          payload: ev.payload,
          eventTimestamp: new Date(ev.timestamp).toISOString(),
          at,
        })
      } catch (e) {
        const at = await step.do(`after-wait-${index}`, async () => Date.now())
        results.push({ index, type: wait.type, ok: false, error: String(e), at })
      }
    }

    return { createdAt: event.timestamp.toISOString(), startedAt, waitStartedAt, results }
  }
}

export default {
  async fetch() {
    return new Response('probe-72-workflow: no HTTP interface', { status: 404 })
  },
}
