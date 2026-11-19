import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from './cli.ts'
import { EvalConfigError } from './errors.ts'
import { fixedModel } from './mock.ts'
import { type RunDeps, type RunOptions, runEval } from './runner.ts'
import { REPO_ROOT } from './suite.ts'
import { GOOD, type TempSuite, tempSuite } from './test-support.ts'

const SECRET = 'sk-evals-test-secret-value'
const cleanups: (() => void)[] = []
let evidence: string
let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  evidence = mkdtempSync(join(tmpdir(), 'evals-evidence-'))
  cleanups.push(() => rmSync(evidence, { recursive: true, force: true }))
  // 回放与模拟模型都不应访问网络：全局 fetch 被调用即失败
  fetchSpy = vi.fn(() => Promise.reject(new Error('network is not allowed in tests')))
  vi.stubGlobal('fetch', fetchSpy)
})
afterEach(() => {
  vi.unstubAllGlobals()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const env = (extra: Record<string, string> = {}) => ({
  EVIDENCE_DIR: evidence,
  OPENAI_API_KEY: SECRET,
  AI_GATEWAY_TOKEN: SECRET,
  ...extra,
})
const suite = (options: Parameters<typeof tempSuite>[0] = {}): TempSuite => {
  const created = tempSuite(options)
  cleanups.push(created.cleanup)
  return created
}
const run = (s: TempSuite, options: Partial<RunOptions> = {}, deps: Partial<RunDeps> = {}) =>
  runEval({ suite: s.name, ...options }, { root: s.root, env: env(), gitCommit: null, ...deps })
const configError = async (promise: Promise<unknown>, pattern: RegExp) => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(EvalConfigError)
  expect((error as Error).message).toMatch(pattern)
}
const filesUnder = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name))
    : []

describe('示例套件回放', () => {
  it('两个版本回放对比，退出码 0，零网络调用，报告给出分数差与估算费用', async () => {
    const result = await runEval(
      { suite: 'example', baseline: 'product-intro@v1' },
      { env: env(), gitCommit: null },
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.exitCode).toBe(0)
    const { report } = result
    expect(report.prompt.promptVersion).toBe('product-intro@v2')
    expect(report.summary).toMatchObject({
      total: 6,
      passed: 6,
      failed: 0,
      warnings: 1,
      costUsd: 0,
    })
    expect(report.summary.estimatedLiveCostUsd).toBeGreaterThan(0)
    expect(report.baseline).toMatchObject({ kind: 'prompt', promptVersion: 'product-intro@v1' })
    expect(report.baseline?.delta).toBeGreaterThan(0)
    expect(report.baseline?.samples).toHaveLength(6)
    const warned = report.samples.find((sample) => sample.id === 'zh-planner')
    expect(warned?.checks.find((check) => check.id === 'length')).toMatchObject({
      pass: false,
      severity: 'warn',
    })
    expect(result.reportDir.startsWith(join(evidence, 'prompt-evals', 'example'))).toBe(true)
    expect(existsSync(join(result.reportDir, 'report.md'))).toBe(true)
  })
})

describe('模式与录制（4.1）', () => {
  it('录制缺失记为 no-recording，不回退真实调用；渲染不符记为 stale-recording', async () => {
    const s = suite()
    await s.record('demo@v2', 's1', GOOD, [5, 5])
    const result = await run(s, { prompt: 'demo@v2' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.exitCode).toBe(1)
    expect(result.report.samples.map((sample) => sample.status)).toEqual(['passed', 'no-recording'])
    // 录制的 renderedHash 与当前渲染不符
    const path = join(s.dir, 'recordings/demo@v2/gen/s1.json')
    const recording = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...recording, renderedHash: 'sha256:old' }))
    const stale = await run(s, { prompt: 'demo@v2', samples: ['s1'] })
    expect(stale.report.samples[0]?.status).toBe('stale-recording')
    expect(stale.exitCode).toBe(1)
  })

  it('评委录制的输出摘要或评分标准版本不符视为录制缺失', async () => {
    const s = suite()
    await s.record('demo@v2', 's1', GOOD, [5, 5])
    const path = join(s.dir, 'recordings/demo@v2/gen/s1.judge.judge.json')
    const recording = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...recording, rubricVersion: 'r0' }))
    const result = await run(s, { prompt: 'demo@v2', samples: ['s1'] })
    expect(result.report.samples[0]).toMatchObject({
      status: 'stale-recording',
      judge: { status: 'stale-recording' },
    })
  })

  it('CI 为真时拒绝真实与录制模式；缺预算、缺单价在任何调用前拒绝', async () => {
    const s = suite()
    const modelFor = vi.fn()
    await configError(
      run(s, { mode: 'live', budgetUsd: 1 }, { env: env({ CI: 'true' }), modelFor }),
      /refused when CI is set/,
    )
    await configError(
      run(s, { mode: 'record', budgetUsd: 10 }, { env: env({ CI: '1' }), modelFor }),
      /refused when CI is set/,
    )
    await configError(run(s, { mode: 'live' }, { modelFor }), /requires --budget-usd/)
    const unpriced = suite({ name: 'unpriced', price: false })
    await configError(run(unpriced, { mode: 'live', budgetUsd: 1 }, { modelFor }), /no priceUsd/)
    const free = suite({ name: 'free', price: 'zero' })
    await configError(
      run(free, { mode: 'record', budgetUsd: 1 }, { modelFor }),
      /priceUsd must be positive/,
    )
    expect(modelFor).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(filesUnder(evidence)).toEqual([])
  })

  it('录制模式经真实出口工厂写入录制，录制与报告不含密钥、请求头或端点', async () => {
    const s = suite()
    const bodies: string[] = []
    fetchSpy.mockImplementation(async (_input: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      bodies.push(body)
      const judging = body.includes('Candidate output')
      const content = judging
        ? JSON.stringify({
            criteria: { accuracy: { score: 4, reason: 'ok' }, clarity: { score: 5, reason: 'ok' } },
            summary: 'fine',
          })
        : GOOD
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-test',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const result = await run(
      s,
      { mode: 'record', budgetUsd: 10 },
      {
        env: env({
          AI_TEXT_EGRESS: 'direct',
          OPENAI_BASE_URL: 'https://llm.invalid/v1',
        }),
      },
    )
    expect(fetchSpy).toHaveBeenCalledTimes(4)
    expect(result.exitCode).toBe(0)
    expect(result.report.summary.costUsd).toBeCloseTo((4 * ((12 + 8) * 1000)) / 1e6)
    const files = [...filesUnder(join(s.dir, 'recordings')), ...filesUnder(evidence)]
    expect(files.filter((file) => file.includes('recordings'))).toHaveLength(4)
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const forbidden of [
        SECRET,
        'llm.invalid',
        'authorization',
        'x-api-key',
        'x-goog-api-key',
      ])
        expect(text.toLowerCase(), `${file} contains ${forbidden}`).not.toContain(
          forbidden.toLowerCase(),
        )
    }
    const recording = JSON.parse(
      readFileSync(join(s.dir, 'recordings/demo@v2/gen/s1.json'), 'utf8'),
    )
    expect(recording.durationMs).toEqual(expect.any(Number))
    expect(Object.keys(recording).sort()).toEqual(
      [
        'durationMs',
        'finishReason',
        'kind',
        'model',
        'output',
        'promptVersion',
        'recordedAt',
        'renderedHash',
        'source',
        'usage',
      ].sort(),
    )
    expect(recording).toMatchObject({ source: 'recorded', output: GOOD })
    // 录制后可直接回放
    fetchSpy.mockClear()
    const replay = await run(s)
    expect(replay.exitCode).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('凭据脱敏', () => {
  it('Provider 401 回显密钥时，报告与终端输出都不含密钥', async () => {
    const s = suite({ judge: false, samples: [{ id: 's1', input: { topic: 'tea' } }] })
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: `Incorrect API key provided: ${SECRET}. authorization: Bearer ${SECRET}`,
              type: 'invalid_request_error',
              code: 'invalid_api_key',
            },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    )
    const lines: string[] = []
    const out = {
      log: (text: string) => lines.push(text),
      error: (text: string) => lines.push(text),
    }
    const code = await main(
      ['--suite', s.name, '--live', '--budget-usd', '10'],
      {
        root: s.root,
        gitCommit: null,
        env: env({ AI_TEXT_EGRESS: 'direct', OPENAI_BASE_URL: 'https://llm.invalid/v1' }),
      },
      out,
    )
    expect(fetchSpy).toHaveBeenCalled()
    expect(code).toBe(1)
    const reportText = filesUnder(evidence)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')
    expect(reportText).toContain('generation-error')
    for (const text of [reportText, lines.join('\n')]) {
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain('llm.invalid')
    }
  })
})

describe('运行器与报告（4.2）', () => {
  it('报告字段完整、按选择运行，不含环境变量值', async () => {
    const s = suite()
    await s.record('demo@v2', 's1', GOOD, [5, 3])
    await s.record('demo@v2', 's2', GOOD, [4, 4])
    const result = await run(s, { tag: 'b' })
    expect(result.report.samples.map((sample) => sample.id)).toEqual(['s2'])
    const all = await run(s, { samples: ['s1', 's2'], concurrency: 4 })
    const { report } = all
    expect(Object.keys(report).sort()).toEqual(
      [
        'assessment',
        'baseline',
        'budget',
        'createdAt',
        'exitCode',
        'generator',
        'gitCommit',
        'judge',
        'mode',
        'prepareVersion',
        'prompt',
        'samples',
        'scope',
        'suite',
        'summary',
      ].sort(),
    )
    expect(report.prompt.renderedHashes.s1).toMatch(/^sha256:/)
    expect(report.generator).toEqual({
      key: 'gen',
      provider: 'openai',
      providerModelId: 'gpt-test',
    })
    expect(report.judge).toMatchObject({ key: 'judge', rubricVersion: 'r1' })
    expect(report.samples[0]?.judge).toMatchObject({
      status: 'scored',
      score: 0.75,
      criteria: { accuracy: { score: 5, reason: 'a' } },
    })
    expect(report.summary.averageScore).toBeCloseTo((0.75 + 0.75) / 2)
    expect(report.summary.estimatedLiveCostUsd).toBeCloseTo(
      (2 * ((10 + 20 + 30 + 40) * 1000)) / 1e6,
    )
    for (const file of filesUnder(all.reportDir))
      expect(readFileSync(file, 'utf8')).not.toContain(SECRET)
    const noJudge = await run(s, { noJudge: true })
    expect(noJudge.report.judge).toBeNull()
    expect(noJudge.report.samples[0]?.judge).toBeNull()
    await configError(run(s, { concurrency: 5 }), /concurrency/)
    await configError(run(s, { samples: ['nope'] }), /unknown samples: nope/)
    await configError(run(s, { prompt: 'demo@v9' }), /unknown prompt version/)
  })

  it.skipIf(spawnSync('git', ['rev-parse', '--git-dir'], { cwd: REPO_ROOT }).status !== 0)(
    '未设 EVIDENCE_DIR 时写入被 .gitignore 忽略的 test-results/evidence/',
    async () => {
      const result = await runEval(
        { suite: 'example', samples: ['en-mug'] },
        { env: {}, gitCommit: null },
      )
      cleanups.push(() => rmSync(result.reportDir, { recursive: true, force: true }))
      expect(
        result.reportDir.startsWith(join(REPO_ROOT, 'test-results/evidence/prompt-evals')),
      ).toBe(true)
      const ignored = spawnSync(
        'git',
        ['check-ignore', '-q', join(result.reportDir, 'report.json')],
        {
          cwd: REPO_ROOT,
        },
      )
      expect(ignored.status).toBe(0)
    },
  )
})

describe('基线与退出码（4.3）', () => {
  it('同次回放基线：平均分下降超过阈值时以 4 退出，命令行阈值与报告基线可用', async () => {
    const s = suite({ extra: 'regressionThreshold: 0.05,' })
    // 两项等权、1–5 分：v1 两个样本都是 1.0，v2 为 0.875 与 1.0，平均分差 -0.0625
    await s.record('demo@v1', 's1', GOOD, [5, 5])
    await s.record('demo@v1', 's2', GOOD, [5, 5])
    await s.record('demo@v2', 's1', GOOD, [5, 4])
    await s.record('demo@v2', 's2', GOOD, [5, 5])
    const small = await run(s, { baseline: 'demo@v1' })
    expect(small.report.baseline?.delta).toBeCloseTo(-0.0625)
    expect(small.exitCode).toBe(4)
    expect(small.report.baseline?.samples[0]).toMatchObject({
      id: 's1',
      delta: -0.125,
      regressed: true,
    })
    // 命令行阈值覆盖套件值
    expect((await run(s, { baseline: 'demo@v1', maxRegression: 0.1 })).exitCode).toBe(0)
    // 以前的报告作基线
    const previous = join(small.reportDir, 'report.json')
    const fromReport = await run(s, { prompt: 'demo@v1', baselineReport: previous })
    expect(fromReport.report.baseline).toMatchObject({ kind: 'report', promptVersion: 'demo@v2' })
    expect(fromReport.report.baseline?.delta).toBeCloseTo(0.0625)
    expect(fromReport.exitCode).toBe(0)
  })

  it('spec 场景：平均分比基线低 0.08、阈值 0.05 时判为回退', async () => {
    const s = suite({
      extra: 'regressionThreshold: 0.05,',
      samples: [{ id: 's1', input: { topic: 'tea' } }],
    })
    // 当前 (5,4) 归一为 0.875；以前的报告中基线为 0.955，平均分差 -0.08
    await s.record('demo@v2', 's1', GOOD, [5, 4])
    const baselineFile = join(s.root, 'baseline.json')
    writeFileSync(
      baselineFile,
      JSON.stringify({
        suite: 'demo',
        prompt: { promptVersion: 'demo@v1' },
        samples: [{ id: 's1', judge: { score: 0.955 }, checks: [] }],
      }),
    )
    const result = await run(s, { baselineReport: baselineFile })
    expect(result.report.baseline?.delta).toBeCloseTo(-0.08)
    expect(result.report.baseline?.regressed).toBe(true)
    expect(result.exitCode).toBe(4)
  })

  it('基线缺录制时在调用前报配置错误；检查失败与回退同时出现时退出码为 1', async () => {
    const s = suite()
    await s.record('demo@v2', 's1', GOOD, [1, 1])
    await s.record('demo@v2', 's2', 'no heading here', [1, 1])
    await configError(
      run(s, { baseline: 'demo@v1' }),
      /baseline demo@v1 has no recordings for gen: s1, s2/,
    )
    expect(filesUnder(evidence)).toEqual([])
    await s.record('demo@v1', 's1', GOOD, [5, 5])
    await s.record('demo@v1', 's2', GOOD, [5, 5])
    const result = await run(s, { baseline: 'demo@v1' })
    expect(result.report.baseline?.regressed).toBe(true)
    expect(result.report.samples[1]?.status).toBe('failed')
    expect(result.report.baseline?.samples[1]?.checksChanged).toEqual([
      { id: 'sections', before: true, after: false },
    ])
    expect(result.exitCode).toBe(1)
  })

  it('评委输出无法解析记为评委错误、计入失败、不计平均分', async () => {
    const s = suite()
    await s.record('demo@v2', 's1', GOOD, 'not json')
    await s.record('demo@v2', 's2', GOOD, [5, 5])
    const result = await run(s)
    expect(result.report.samples[0]).toMatchObject({
      status: 'judge-error',
      judge: { status: 'judge-error' },
    })
    expect(result.report.summary).toMatchObject({ averageScore: 1, scoredSamples: 1, failed: 1 })
    expect(result.exitCode).toBe(1)
  })
})

describe('真实模式预算（模拟模型）', () => {
  it('并发 4、实际用量超过估算时：结算后触顶，不再发出新调用，超支只来自在途调用', async () => {
    const samples = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      input: { topic: `t${i}` },
    }))
    const s = suite({ judge: false, samples })
    let inFlight = 0
    let peak = 0
    const modelFor = vi.fn(() =>
      fixedModel(async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight--
        // 输出远超 maxOutputTokens（100）：估算偏低
        return { text: GOOD, usage: { inputTokens: 10, outputTokens: 400 } }
      }),
    )
    const result = await run(s, { mode: 'live', budgetUsd: 1, concurrency: 4 }, { modelFor })
    const started = modelFor.mock.calls.length
    // 首批 4 个并发调用都已预留；第一个结算即触顶，之后不再发出
    expect(started).toBe(4)
    expect(peak).toBeLessThanOrEqual(4)
    expect(result.report.budget.exhausted).toBe(true)
    expect(
      result.report.samples.filter((sample) => sample.status === 'skipped-budget'),
    ).toHaveLength(8)
    // 每次实际 0.41 美元：总额超过上限 1 美元，超支只来自这 4 个在途调用的估算误差
    expect(result.report.budget.spentUsd).toBeGreaterThan(1)
    expect(result.report.budget.spentUsd).toBeCloseTo(4 * 0.41)
    expect(result.exitCode).toBe(3)
  })

  // 单价 1000 美元 / 百万 token = 0.001 美元 / token
  const generationEstimate = (topic: string) =>
    (8 + 'Write clearly about the topic.'.length + 8 + `Topic: ${topic}`.length + 100) / 1000

  it('预算触顶：剩余样本记为预算跳过，以 3 退出', async () => {
    const s = suite({ judge: false })
    const modelFor = vi.fn(() =>
      fixedModel({ text: GOOD, usage: { inputTokens: 10, outputTokens: 10 } }),
    )
    const budget = generationEstimate('tea') + 0.001
    const result = await run(s, { mode: 'live', budgetUsd: budget, concurrency: 1 }, { modelFor })
    expect(result.report.samples.map((sample) => sample.status)).toEqual([
      'passed',
      'skipped-budget',
    ])
    expect(modelFor).toHaveBeenCalledTimes(1)
    expect(result.report.budget).toMatchObject({ limitUsd: budget, exhausted: true })
    expect(result.report.budget.spentUsd).toBeCloseTo(0.02)
    expect(result.exitCode).toBe(3)
  })

  it('评委调用估算超额时不发出，样本记为预算跳过，生成费用计入报告', async () => {
    const s = suite({ samples: [{ id: 's1', input: { topic: 'tea' } }] })
    const modelFor = vi.fn((key: string) =>
      fixedModel({
        text: key === 'gen' ? GOOD : '{}',
        usage: { inputTokens: 10, outputTokens: 10 },
      }),
    )
    const result = await run(
      s,
      { mode: 'live', budgetUsd: generationEstimate('tea') + 0.01 },
      { modelFor },
    )
    expect(modelFor).toHaveBeenCalledTimes(1)
    expect(result.report.samples[0]).toMatchObject({
      status: 'skipped-budget',
      judge: { status: 'skipped-budget' },
    })
    expect(result.report.samples[0]?.costUsd).toBeCloseTo(0.02)
    expect(result.exitCode).toBe(3)
  })

  it('真实模式请求形状：system 经 instructions 发送，评委按缺省输出上限估算并下发', async () => {
    const s = suite({ samples: [{ id: 's1', input: { topic: 'tea' } }] })
    const models = new Map<string, ReturnType<typeof fixedModel>>()
    const modelFor = vi.fn((key: string) => {
      const model = fixedModel({
        text:
          key === 'gen'
            ? GOOD
            : JSON.stringify({
                criteria: {
                  accuracy: { score: 5, reason: 'a' },
                  clarity: { score: 5, reason: 'b' },
                },
                summary: 'ok',
              }),
        usage: { inputTokens: 10, outputTokens: 10 },
      })
      models.set(key, model)
      return model
    })
    const result = await run(s, { mode: 'live', budgetUsd: 100 }, { modelFor })
    expect(result.report.samples[0]?.status).toBe('passed')
    const generation = models.get('gen')?.doGenerateCalls[0]
    expect(generation?.prompt).toEqual([
      { role: 'system', content: 'Write clearly about the topic.' },
      { role: 'user', content: [{ type: 'text', text: 'Topic: tea' }] },
    ])
    expect(generation?.maxOutputTokens).toBe(100)
    const judge = models.get('judge')?.doGenerateCalls[0]
    expect(judge?.prompt[0]).toMatchObject({ role: 'system' })
    expect(judge?.maxOutputTokens).toBe(4096)
    // openai 无 thinking 适配器：不改变请求
    expect(judge?.reasoning).toBeUndefined()
  })

  it.each([
    { provider: 'openai', thinking: undefined, expected: undefined },
    { provider: 'deepseek', thinking: undefined, expected: undefined },
    { provider: 'deepseek', thinking: false, expected: 'disabled' },
    { provider: 'deepseek', thinking: true, expected: 'enabled' },
    { provider: 'openai', thinking: false, expected: undefined },
  ] as const)(
    '生成模型声明 thinking=$thinking（$provider）与线上模型行同一语义下发',
    async ({ provider, thinking, expected }) => {
      const s = suite({
        judge: false,
        samples: [{ id: 's1', input: { topic: 'tea' } }],
        gen: { provider, extra: thinking === undefined ? '' : `thinking: ${thinking},` },
      })
      const model = fixedModel({ text: GOOD, usage: { inputTokens: 10, outputTokens: 10 } })
      await run(s, { mode: 'live', budgetUsd: 100 }, { modelFor: () => model })
      const request = model.doGenerateCalls[0]
      if (expected === undefined) {
        expect(request?.providerOptions?.deepseek).toBeUndefined()
        expect(request?.reasoning).toBeUndefined()
      } else {
        expect(request?.providerOptions).toMatchObject({
          deepseek: { thinking: { type: expected } },
        })
        expect(request?.reasoning).toBe(expected === 'enabled' ? 'high' : 'none')
      }
    },
  )

  it('模型未返回用量时按调用前估算记账', async () => {
    const s = suite({ judge: false, samples: [{ id: 's1', input: { topic: 'tea' } }] })
    const result = await run(
      s,
      { mode: 'live', budgetUsd: 1 },
      { modelFor: () => fixedModel({ text: GOOD }) },
    )
    expect(result.exitCode).toBe(0)
    expect(result.report.summary.costUsd).toBeCloseTo(generationEstimate('tea'))
  })
})
