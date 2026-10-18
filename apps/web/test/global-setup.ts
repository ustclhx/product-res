import { createServer, type Server } from 'node:net'
import migrate from '@product-res/db/test/global-setup'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    /** 接受 TCP 连接但从不响应的端口：模拟挂起的数据库 */
    hangingDbPort: number
    /** 没有任何进程监听的端口：模拟拒绝连接的数据库 */
    refusedDbPort: number
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address) resolve(address.port)
      else reject(new Error('无法获取监听端口'))
    })
  })
}

export default async function setup(project: TestProject) {
  await migrate()

  const sockets = new Set<import('node:net').Socket>()
  const hanging = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  project.provide('hangingDbPort', await listen(hanging))

  // 取一个空闲端口后立即释放，之后连接该端口会被拒绝
  const probe = createServer()
  project.provide('refusedDbPort', await listen(probe))
  await new Promise((resolve) => probe.close(resolve))

  return async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => hanging.close(resolve))
  }
}
