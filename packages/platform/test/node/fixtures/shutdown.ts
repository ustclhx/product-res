import { setTimeout as delay } from 'node:timers/promises'
// 聚合入口会加载无关的数据库与任务引擎模块，CI 并发时可能在 ready 前耗尽 watchdog。
import { createNodeBackgroundTasks } from '../../../src/node/background.ts'

const mode = process.argv[2]
const tasks = createNodeBackgroundTasks()
const releaseRequest = tasks.beginRequest()
let finishTask: () => void = () => {}
const task = new Promise<void>((resolve) => {
  finishTask = resolve
})
tasks.waitUntil(task)
tasks.waitUntil(Promise.reject(new Error('fixture private rejection content')))
process.once('SIGTERM', async () => {
  const result = await tasks.shutdown({
    timeoutMs: 150,
    stopReceiving: () => {
      console.log('stop')
      if (mode === 'complete') {
        void delay(20).then(() => {
          // 在途请求可在停机开始后注册新后台任务。
          tasks.waitUntil(delay(20).then(() => console.log('late-task')))
          console.log('request-complete')
          releaseRequest()
          finishTask()
        })
      }
    },
    closeResources: async () => {
      console.log('close-cache-db')
    },
  })
  console.log(JSON.stringify(result))
  process.exit(result.resourcesClosed ? 0 : 1)
})
console.log('ready')
// 保持进程存活直到信号；只由本测试创建的子进程持有。
setInterval(() => {}, 10_000)
