import * as cp from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

// 只记录正式 fixture 的控制与退出边界；IPC ownership token 和消息正文不输出。
const spawn = cp.default.spawn
cp.default.spawn = function (...args) {
  const child = spawn.apply(this, args)
  if (!args[1]?.some((arg) => String(arg).endsWith('/fixtures/job-worker.ts'))) return child
  const config = JSON.parse(args[2]?.env?.TEST_JOB_WORKER_CONFIG ?? '{}')
  const record = (event, extra = {}) =>
    appendFileSync(
      // biome-ignore lint/suspicious/noUndeclaredEnvVars: 直接Node验收临时路径，不进入Turbo任务缓存
      process.env.B_ACCEPT_EVIDENCE_IPC,
      `${JSON.stringify({
        observedAt: new Date().toISOString(),
        event,
        pid: child.pid,
        runId: config.runId,
        executorId: config.executorId,
        queues: config.queues.map((queue) => queue.name),
        fault: config.fault,
        ...extra,
      })}\n`,
    )
  record('spawn')
  child.on('message', (message) => record('ipc', { boundary: message.event }))
  child.on('exit', (code, signal) => record('exit', { code, signal }))
  const send = child.send
  child.send = function (message, ...rest) {
    record('command', { command: message.command })
    return send.call(this, message, ...rest)
  }
  const kill = child.kill
  child.kill = function (signal) {
    record('signal', { signal })
    return kill.call(this, signal)
  }
  return child
}
syncBuiltinESMExports()
