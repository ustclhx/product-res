import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { WorkspaceTransferWorkflowParams } from '@product-res/follow/transfer'
import type { Workflow } from '@product-res/platform'
import { afterEach, expect, it } from 'vitest'
import { createNodeTransferWorkflowClient } from '../../web/src/node/transfer-workflow.ts'
import { createNodeTransferWorkflowHttpHandler } from '../src/node/transfer.ts'

// add-workspace-data-transfer 4.1：Node 目标 web → jobs 的流转 Workflow 内部接口。
const secret = 'transfer-fixture-secret-at-least-32-characters'
const servers: Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

async function serve() {
  const created: { id: string | undefined; params: WorkspaceTransferWorkflowParams }[] = []
  const workflow: Workflow<WorkspaceTransferWorkflowParams> = {
    async create(options) {
      created.push({ id: options.id, params: options.params })
      return this.get(options.id as string)
    },
    async get(id) {
      return {
        id,
        status: async () => ({ status: 'running' as const }),
        terminate: async () => {},
        sendEvent: async () => {},
      }
    },
  }
  const handler = createNodeTransferWorkflowHttpHandler({
    workflow: { available: true, value: workflow },
    secret,
  })
  const server = createServer((request, response) => void handler(request, response))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, created }
}

it('派生 Bearer 鉴权，create / status 往返；实例 id 必须属于该流转', async () => {
  const { url, created } = await serve()
  const client = createNodeTransferWorkflowClient({ jobsUrl: url, secret })
  const transferId = '01a174cd-eca2-7309-8313-9330bb46afce'
  const instance = await client.create({ id: transferId, params: { transferId } })
  expect(instance.id).toBe(transferId)
  expect(await (await client.get(transferId)).status()).toEqual({ status: 'running' })
  const resumeId = `${transferId}-01a174cd-eca2-7309-8313-9330bb46afcf`
  await client.create({ id: resumeId, params: { transferId } })
  expect(created.map((c) => c.id)).toEqual([transferId, resumeId])
  await expect(
    client.create({
      id: '01a174cd-eca2-7309-8313-9330bb46afcf',
      params: { transferId },
    }),
  ).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' })

  const wrong = createNodeTransferWorkflowClient({ jobsUrl: url, secret: `${secret}-other` })
  await expect(wrong.get(transferId)).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' })
  const raw = await fetch(`${url}/`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
    body: JSON.stringify({ operation: 'get', id: transferId }),
  })
  // 主密钥本身不是有效凭据
  expect(raw.status).toBe(401)
})
