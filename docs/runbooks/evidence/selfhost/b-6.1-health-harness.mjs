import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const acceptanceEnv = process.env

// 仅提供验收控制信号；实际注册、引擎、心跳与 HTTP 均来自未修改的生产构建。
const output = resolve('apps/jobs/.output/server')
const files = await readdir(output)
const runtimeFile = files.find((file) => /^runtime-.*\.mjs$/.test(file))
let configFile
for (const file of files.filter((name) => /^chunk-.*\.mjs$/.test(name))) {
  const source = await readFile(resolve(output, file), 'utf8')
  if (source.includes('function loadNodeEnv(')) configFile = file
}
if (!runtimeFile || !configFile) throw new Error('Production Node build required')
const { loadNodeEnv } = await import(pathToFileURL(resolve(output, configFile)).href)
const { startNodeJobs } = await import(pathToFileURL(resolve(output, runtimeFile)).href)
const runtime = await startNodeJobs(loadNodeEnv(), {
  host: '127.0.0.1',
  port: Number(acceptanceEnv.PORT),
  executorId: acceptanceEnv.JOB_EXECUTOR_ID,
  ownershipDirectory: acceptanceEnv.JOB_OWNERSHIP_DIRECTORY,
  applicationVersion: acceptanceEnv.ACCEPT_BUILD_SHA,
})
process.send?.({ event: 'ready', pid: process.pid })
process.on('message', (message) => {
  if (message.command === 'pause') {
    runtime.scheduler.stopReceiving()
    process.send?.({ event: 'paused', at: new Date().toISOString() })
  }
})
process.once('SIGTERM', () => {
  void runtime
    .shutdown()
    .then((result) => process.exit(result.completed && result.resourcesClosed ? 0 : 1))
})
