import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// support 在导入时固定 target/run ID；单测必须先设本地目标，不能碰真实证据目录。
vi.mock('@playwright/test', () => ({ chromium: {}, expect: vi.fn(), test: {} }))
const runId = 'fault-evidence-unit'
const directory = new URL(
  '../../../../../test-results/evidence/staging-acceptance/',
  import.meta.url,
)
const file = new URL(`${new Date().toISOString().slice(0, 10)}/${runId}-safe.json`, directory)
afterEach(async () => {
  await rm(file, { force: true })
  vi.unstubAllEnvs()
  vi.resetModules()
})
async function support() {
  vi.stubEnv('EVIDENCE_DIR', '')
  vi.stubEnv('STAGING_ACCEPTANCE_LOCAL', '1')
  vi.stubEnv('STAGING_ACCEPTANCE_RUN_ID', runId)
  return import('../../../e2e/staging-acceptance/support.ts')
}

// 每个用例重新导入 staging-acceptance support（含 Playwright 辅助模块），完整 pnpm test 并发负载下可超过默认 5 秒
describe('fault evidence safety', { timeout: 30_000 }, () => {
  it('只写本地已忽略目录，保留纯 ID、注入布尔值及用量', async () => {
    const { evidence } = await support()
    const data = {
      resourceId: '019a0000-0000-7000-8000-000000000001',
      proof: { mode: 'chat-mid-stream', injected: true, realProviderCalled: true },
      hasOutput: true,
      charCount: 200,
      inputTokens: 100,
      outputTokens: 200,
    }
    await evidence('safe', data)
    const saved = JSON.parse(await readFile(file, 'utf8'))
    expect(saved.target).toBe('local-mocked')
    expect(saved.data).toEqual(data)
  })

  it('EVIDENCE_DIR 指定私有 checkout，写入和恢复读取使用同一目录', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'private-evidence-'))
    try {
      await support()
      vi.stubEnv('EVIDENCE_DIR', directory)
      vi.resetModules()
      const { evidence, readEvidence } = await import('../../../e2e/staging-acceptance/support.ts')
      await evidence('custom', { resourceId: 'fixture-id' })
      expect(await readEvidence('custom')).toEqual({ resourceId: 'fixture-id' })
      const path = join(
        directory,
        'staging-acceptance',
        new Date().toISOString().slice(0, 10),
        `${runId}-custom.json`,
      )
      expect(JSON.parse(await readFile(path, 'utf8')).runId).toBe(runId)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('拒绝嵌套正文别名、凭据、邮箱和各种签名 URL，错误不回显值', async () => {
    vi.stubEnv('TEST_SECRET', 'unit-private-secret-value')
    const { assertSafeEvidence } = await support()
    const forbidden = [
      { nested: { partial_text: 'private response' } },
      { callback_payload: { arbitrary: true } },
      { note: 'unit-private-secret-value' },
      { note: 'private@example.test' },
      { note: 'https://files.example/a?X-Amz-Signature=private' },
      { note: 'https://files.example/a?sig=private' },
      { access_token: 'private' },
      { parts: [] },
      { output: 'private response' },
    ]
    for (const value of forbidden) {
      expect(() => assertSafeEvidence(value)).toThrow(
        'Evidence contains a forbidden sensitive value or field',
      )
    }
  })
})

describe('fault scenario subset', () => {
  async function definitions() {
    vi.stubEnv('STAGING_ACCEPTANCE_LOCAL', '1')
    vi.stubEnv('STAGING_ACCEPTANCE_RUN_ID', runId)
    return import('../../../e2e/staging-acceptance/fault-definitions.ts')
  }

  it('缺省为完整矩阵，子集只保留指定场景', async () => {
    const { FAULT_MODELS, selectFaultModels } = await definitions()
    expect(selectFaultModels('')).toBe(FAULT_MODELS)
    expect(selectFaultModels(undefined)).toHaveLength(11)
    expect(selectFaultModels(' chat-mid-stream-per_call ').map((m) => m.key)).toEqual([
      'acceptance-fault-chat-mid-stream-per_call',
    ])
  })

  it.each(['chat-mid-stream', 'chat-mid-stream-per_call,chat-mid-stream-per_call', ','])(
    '未知或重复场景 %j 拒绝而不是退回全量',
    async (filter) => {
      const { selectFaultModels } = await definitions()
      expect(() => selectFaultModels(filter)).toThrow('Invalid STAGING_FAULT_SCENARIOS')
    },
  )
})
