import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promptSha256 } from '@product-res/ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from './cli.ts'
import { EXIT } from './errors.ts'
import { fixedModel } from './mock.ts'
import { type RunDeps, type RunOptions, runEval } from './runner.ts'
import { GOOD, type TempSuite, tempSuite } from './test-support.ts'

/**
 * 两个扩展点（add-eval-extension-points）：被评正文转换与评测后聚合门槛。
 * 全部用固定录制或模拟模型离线完成；门槛数值只出现在本夹具中，模板不内置。
 */
const cleanups: (() => void)[] = []
let evidence: string
let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  evidence = mkdtempSync(join(tmpdir(), 'evals-ext-'))
  cleanups.push(() => rmSync(evidence, { recursive: true, force: true }))
  fetchSpy = vi.fn(() => Promise.reject(new Error('network is not allowed in tests')))
  vi.stubGlobal('fetch', fetchSpy)
})
afterEach(() => {
  vi.unstubAllGlobals()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const suite = (options: Parameters<typeof tempSuite>[0] = {}): TempSuite => {
  const created = tempSuite(options)
  cleanups.push(created.cleanup)
  return created
}
const run = (s: TempSuite, options: Partial<RunOptions> = {}, deps: Partial<RunDeps> = {}) =>
  runEval(
    { suite: s.name, ...options },
    { root: s.root, env: { EVIDENCE_DIR: evidence }, gitCommit: null, ...deps },
  )

// 项目式转换：字形补正与年份修正（领域规则只在夹具里）
const PREPARE = `prepareOutput: {
  version: 'g1',
  run: ({ rawOutput }) => {
    const glyphs = [...rawOutput].filter((char) => char === '這').length
    const output = rawOutput.replaceAll('這', '这').replaceAll('2025 年', '2026 年')
    return { output, annotations: { glyphs, years: output === rawOutput ? 0 : 1, unresolved: 0 } }
  },
},`
const RAW = '## Summary\n\n這是 2025 年的总结。'
const FIXED = '## Summary\n\n这是 2026 年的总结。'
const VARIANT_CHECKS = `[checks.sections(), checks.chineseVariant({ variant: 'zh-Hans' })]`

describe('prepareOutput', () => {
  it('回放：检查与评委都使用修正文，生成录制保留原文，报告带版本、注释与正文文件', async () => {
    const s = suite({ extra: PREPARE, checks: VARIANT_CHECKS })
    for (const id of ['s1', 's2'])
      await s.record('demo@v2', id, RAW, [5, 5], { judgedOutput: FIXED, prepareVersion: 'g1' })
    const result = await run(s, { prompt: 'demo@v2' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.exitCode).toBe(0)
    const [sample] = result.report.samples
    expect(sample?.checks.find((check) => check.id === 'chinese-variant')?.pass).toBe(true)
    expect(sample?.prepared).toMatchObject({
      version: 'g1',
      changed: true,
      rawSha256: await promptSha256(RAW),
      outputSha256: await promptSha256(FIXED),
      annotations: { glyphs: 1, years: 1, unresolved: 0 },
    })
    expect(result.report.prepareVersion).toBe('g1')
    expect(readFileSync(join(result.reportDir, 'outputs/s1.txt'), 'utf8')).toBe(FIXED)
    expect(readFileSync(join(result.reportDir, 'outputs/s1.raw.txt'), 'utf8')).toBe(RAW)
    const recording = JSON.parse(
      readFileSync(join(s.dir, 'recordings/demo@v2/gen/s1.json'), 'utf8'),
    )
    expect(recording.output).toBe(RAW)
    const markdown = readFileSync(join(result.reportDir, 'report.md'), 'utf8')
    expect(markdown).toContain('Prepared (g1): changed')
    expect(markdown).toContain('"unresolved":0')
  })

  it('录制模式：评委请求收到修正文，评委录制绑定修正文与转换版本，之后回放可复用', async () => {
    const s = suite({
      extra: PREPARE,
      checks: VARIANT_CHECKS,
      samples: [{ id: 's1', input: { topic: 'tea' } }],
    })
    const judgeText = JSON.stringify({
      criteria: { accuracy: { score: 5, reason: 'a' }, clarity: { score: 4, reason: 'c' } },
      summary: 's',
    })
    const gen = fixedModel({ text: RAW, usage: { inputTokens: 5, outputTokens: 7 } })
    const judge = fixedModel({ text: judgeText, usage: { inputTokens: 5, outputTokens: 7 } })
    const recorded = await run(
      s,
      { mode: 'record', budgetUsd: 10, prompt: 'demo@v2' },
      { modelFor: (key) => (key === 'gen' ? gen : judge) },
    )
    expect(recorded.exitCode).toBe(0)
    const judgePrompt = JSON.stringify(judge.doGenerateCalls[0]?.prompt)
    expect(judgePrompt).toContain('这是 2026 年')
    expect(judgePrompt).not.toContain('這是')
    const generation = JSON.parse(
      readFileSync(join(s.dir, 'recordings/demo@v2/gen/s1.json'), 'utf8'),
    )
    expect(generation.output).toBe(RAW)
    expect(generation.durationMs).toEqual(expect.any(Number))
    const judged = JSON.parse(
      readFileSync(join(s.dir, 'recordings/demo@v2/gen/s1.judge.judge.json'), 'utf8'),
    )
    expect(judged).toMatchObject({ prepareVersion: 'g1', outputHash: await promptSha256(FIXED) })
    expect(recorded.report.samples[0]?.usage.judge?.durationMs).toEqual(expect.any(Number))
    const replayed = await run(s, { prompt: 'demo@v2' })
    expect(replayed.exitCode).toBe(0)
    expect(replayed.report.samples[0]?.judge?.score).toBe(recorded.report.samples[0]?.judge?.score)
  })

  it('转换版本变化、评委录制绑定原文时都视为过期，不沿用', async () => {
    const s = suite({ extra: PREPARE, samples: [{ id: 's1', input: { topic: 'tea' } }] })
    await s.record('demo@v2', 's1', RAW, [5, 5], { judgedOutput: FIXED, prepareVersion: 'g0' })
    const versionChanged = await run(s, { prompt: 'demo@v2' })
    expect(versionChanged.report.samples[0]).toMatchObject({
      status: 'stale-recording',
      judge: { status: 'stale-recording' },
    })
    expect(versionChanged.exitCode).toBe(EXIT.failed)
    await s.record('demo@v2', 's1', RAW, [5, 5])
    const rawJudged = await run(s, { prompt: 'demo@v2' })
    expect(rawJudged.report.samples[0]?.status).toBe('stale-recording')
  })

  it.each([
    [
      '抛出异常',
      `run: () => { throw new Error('guard failed') }`,
      /prepareOutput threw: guard failed/,
    ],
    ['返回非字符串', `run: () => ({ output: 42 })`, /must return \{ output: string \}/],
    [
      '注释不可序列化',
      `run: ({ rawOutput }) => ({ output: rawOutput, annotations: { at: new Date() } })`,
      /annotations/,
    ],
    [
      '结果不可重复',
      `run: ({ rawOutput }) => ({ output: rawOutput + String(globalThis.__prepareCalls = (globalThis.__prepareCalls ?? 0) + 1) })`,
      /not repeatable/,
    ],
  ])('%s时样本记为 prepare-error，不运行检查与评委，不回退为原文', async (_name, body, pattern) => {
    const s = suite({
      extra: `prepareOutput: { version: 'g1', ${body} },`,
      samples: [{ id: 's1', input: { topic: 'tea' } }],
    })
    await s.record('demo@v2', 's1', GOOD, [5, 5])
    const result = await run(s, { prompt: 'demo@v2' })
    const [sample] = result.report.samples
    expect(sample).toMatchObject({ status: 'prepare-error', checks: [], judge: null })
    expect(sample?.error).toMatch(pattern)
    // 转换失败也保留原文，便于排查；没有被评正文文件
    expect(readFileSync(join(result.reportDir, 'outputs/s1.raw.txt'), 'utf8')).toBe(GOOD)
    expect(existsSync(join(result.reportDir, 'outputs/s1.txt'))).toBe(false)
    expect(result.exitCode).toBe(EXIT.failed)
    expect(result.report.summary.failed).toBe(1)
  })

  it('新增转换后基线评委录制过期：报告与终端列出基线失败与两侧有分样本数', async () => {
    const s = suite({ extra: PREPARE, samples: [{ id: 's1', input: { topic: 'tea' } }] })
    await s.record('demo@v1', 's1', RAW, [5, 5])
    await s.record('demo@v2', 's1', RAW, [5, 5], { judgedOutput: FIXED, prepareVersion: 'g1' })
    const result = await run(s, { baseline: 'demo@v1' })
    expect(result.report.baseline).toMatchObject({
      comparedSamples: 1,
      scoredPairs: 0,
      baselineFailures: [{ id: 's1', status: 'stale-recording' }],
      regressed: false,
    })
    const markdown = readFileSync(join(result.reportDir, 'report.md'), 'utf8')
    expect(markdown).toContain('Scored on both sides: 0 of 1')
    expect(markdown).toContain('Baseline replay failures: s1 (stale-recording)')
  })

  it('未声明转换时不写 outputs，报告 prepareVersion 为 null', async () => {
    const s = suite()
    await s.record('demo@v2', 's1', GOOD, [5, 5])
    await s.record('demo@v2', 's2', GOOD, [5, 5])
    const result = await run(s, { prompt: 'demo@v2' })
    expect(result.exitCode).toBe(0)
    expect(result.report.prepareVersion).toBeNull()
    expect(result.report.samples[0]?.prepared).toBeUndefined()
    expect(existsSync(join(result.reportDir, 'outputs'))).toBe(false)
  })
})

// 项目式门槛：逐维相对、绝对分、P95 token / 时长、覆盖范围（数值只在夹具中）
const GATES = `evaluateRun: ({ samples, scope, candidate, baseline }) => {
  const ids = samples.map((sample) => sample.id)
  const score = (id) => (result) => result.judge?.criteria?.[id]?.score
  const gates = []
  for (const id of ['accuracy', 'clarity']) {
    const current = collect(candidate, ids, score(id))
    const before = collect(baseline, ids, score(id))
    const missing = [...new Set([...current.missing, ...(baseline ? before.missing : ids)])]
    if (missing.length) {
      gates.push({ id: 'relative-' + id, status: 'incomplete', detail: 'missing ' + missing.join(','), metrics: { missing } })
      continue
    }
    const delta = mean(current.values) - mean(before.values)
    gates.push({ id: 'relative-' + id, status: delta >= -0.1 - 1e-9 ? 'passed' : 'failed', detail: 'delta ' + delta.toFixed(3), metrics: { delta } })
  }
  const accuracy = collect(candidate, ids, score('accuracy'))
  gates.push(accuracy.missing.length
    ? { id: 'accuracy-min', status: 'incomplete', detail: 'missing ' + accuracy.missing.join(',') }
    : { id: 'accuracy-min', status: mean(accuracy.values) >= 4 - 1e-9 ? 'passed' : 'failed', detail: 'mean ' + mean(accuracy.values) })
  const tokens = collect(candidate, ids, (result) => result.usage.generation?.outputTokens)
  const p95Tokens = percentile(tokens.values, 95)
  gates.push(tokens.missing.length
    ? { id: 'p95-tokens', status: 'incomplete', detail: 'missing ' + tokens.missing.join(',') }
    : { id: 'p95-tokens', status: p95Tokens <= 70 ? 'passed' : 'failed', detail: 'p95 ' + p95Tokens, metrics: { p95: p95Tokens, limit: 70 } })
  const durations = collect(candidate, ids, (result) => result.usage.generation?.durationMs)
  const p95Duration = percentile(durations.values, 95)
  gates.push(durations.missing.length
    ? { id: 'p95-duration', status: 'incomplete', detail: 'missing ' + durations.missing.join(','), metrics: { missing: durations.missing } }
    : { id: 'p95-duration', status: p95Duration <= 240000 ? 'passed' : 'failed', detail: 'p95 ' + p95Duration + ' ms', metrics: { p95: p95Duration } })
  gates.push({ id: 'coverage', status: scope.filtered ? 'incomplete' : 'passed', required: false,
    detail: scope.selectedSamples + ' of ' + scope.totalSamples,
    metrics: { generator: candidate.generator?.key ?? null, rubric: candidate.judge?.rubricVersion ?? null, baseline: baseline?.source ?? null } })
  return { gates }
},`

type Pair = readonly [number, number]
const usage = { outputTokens: 60, durationMs: 200000 }
async function recordPairs(s: TempSuite, version: string, pairs: readonly Pair[], extra = usage) {
  for (const [index, pair] of pairs.entries())
    await s.record(version, `s${index + 1}`, GOOD, pair, extra)
}
const gate = (result: Awaited<ReturnType<typeof run>>, id: string) =>
  result.report.assessment?.gates.find((item) => item.id === id)

describe('evaluateRun', () => {
  it('总分相同但一维下降 0.11：内置回退不触发，项目门槛失败，退出码 5', async () => {
    const s = suite({ extra: GATES })
    await recordPairs(s, 'demo@v1', [
      [4.5, 4],
      [4.5, 4],
    ])
    await recordPairs(s, 'demo@v2', [
      [4.39, 4.11],
      [4.39, 4.11],
    ])
    const result = await run(s, { baseline: 'demo@v1' })
    expect(result.report.baseline?.regressed).toBe(false)
    expect(Math.abs(result.report.baseline?.delta ?? 1)).toBeLessThan(1e-9)
    expect(gate(result, 'relative-accuracy')?.status).toBe('failed')
    expect(gate(result, 'relative-clarity')?.status).toBe('passed')
    expect(gate(result, 'accuracy-min')?.status).toBe('passed')
    expect(result.report.assessment?.failed).toBe(true)
    expect(result.exitCode).toBe(EXIT.gates)
    expect(gate(result, 'coverage')?.metrics).toEqual({
      generator: 'gen',
      rubric: 'r1',
      baseline: 'run',
    })
    const markdown = readFileSync(join(result.reportDir, 'report.md'), 'utf8')
    expect(markdown).toContain('## Gates')
    expect(markdown).toMatch(/\| relative-accuracy \| failed \| yes \|/)
  })

  it('一维恰好下降 0.1（含浮点误差）通过；accuracy 3.9 失败、恰好 4.0 通过', async () => {
    const s = suite({ extra: GATES })
    await recordPairs(s, 'demo@v1', [
      [4.5, 4],
      [4.5, 4],
    ])
    await recordPairs(s, 'demo@v2', [
      [4.4, 4.1],
      [4.4, 4.1],
    ])
    const tolerance = await run(s, { baseline: 'demo@v1' })
    expect(gate(tolerance, 'relative-accuracy')?.status).toBe('passed')
    expect(tolerance.exitCode).toBe(0)

    await recordPairs(s, 'demo@v1', [
      [3.9, 4],
      [3.9, 4],
    ])
    await recordPairs(s, 'demo@v2', [
      [3.9, 4],
      [3.9, 4],
    ])
    const low = await run(s, { baseline: 'demo@v1' })
    expect(gate(low, 'relative-accuracy')?.status).toBe('passed')
    expect(gate(low, 'accuracy-min')?.status).toBe('failed')
    expect(low.exitCode).toBe(EXIT.gates)

    await recordPairs(s, 'demo@v1', [
      [4, 4],
      [4, 4],
    ])
    await recordPairs(s, 'demo@v2', [
      [4, 4],
      [4, 4],
    ])
    expect(gate(await run(s, { baseline: 'demo@v1' }), 'accuracy-min')?.status).toBe('passed')
  })

  it('P95 token 与录制耗时：等于上限通过，超过失败；回放使用录制耗时', async () => {
    const s = suite({ extra: GATES })
    await recordPairs(s, 'demo@v1', [
      [4, 4],
      [4, 4],
    ])
    await recordPairs(
      s,
      'demo@v2',
      [
        [4, 4],
        [4, 4],
      ],
      { outputTokens: 70, durationMs: 240000 },
    )
    const atLimit = await run(s, { baseline: 'demo@v1' })
    expect(atLimit.report.samples[0]?.usage.generation?.durationMs).toBe(240000)
    expect(gate(atLimit, 'p95-tokens')?.status).toBe('passed')
    expect(gate(atLimit, 'p95-duration')).toMatchObject({
      status: 'passed',
      metrics: { p95: 240000 },
    })
    expect(atLimit.exitCode).toBe(0)

    await s.record('demo@v2', 's2', GOOD, [4, 4], { outputTokens: 71, durationMs: 240001 })
    const over = await run(s, { baseline: 'demo@v1' })
    expect(gate(over, 'p95-tokens')?.status).toBe('failed')
    expect(gate(over, 'p95-duration')?.status).toBe('failed')
    expect(over.exitCode).toBe(EXIT.gates)
  })

  it('缺耗时或基线报告缺样本时判 incomplete，并列出缺口', async () => {
    const s = suite({ extra: GATES })
    await recordPairs(s, 'demo@v1', [
      [4, 4],
      [4, 4],
    ])
    await s.record('demo@v2', 's1', GOOD, [4, 4], usage)
    await s.record('demo@v2', 's2', GOOD, [4, 4], { outputTokens: 60 })
    const noDuration = await run(s, { baseline: 'demo@v1' })
    expect(gate(noDuration, 'p95-duration')).toMatchObject({
      status: 'incomplete',
      metrics: { missing: ['s2'] },
    })
    expect(noDuration.exitCode).toBe(EXIT.gates)

    // 旧报告作基线：只有 s1
    const old = await run(s, { prompt: 'demo@v1', samples: ['s1'] })
    const reportPath = join(old.reportDir, 'report.json')
    await s.record('demo@v2', 's2', GOOD, [4, 4], usage)
    const fromReport = await run(s, { baselineReport: reportPath })
    expect(gate(fromReport, 'relative-accuracy')).toMatchObject({
      status: 'incomplete',
      metrics: { missing: ['s2'] },
    })
    expect(gate(fromReport, 'coverage')?.metrics).toMatchObject({ baseline: 'report' })
    // 旧报告作基线时只交选定范围内的样本
    const filtered = await run(s, { baselineReport: reportPath, samples: ['s2'] })
    expect(gate(filtered, 'relative-accuracy')).toMatchObject({
      status: 'incomplete',
      metrics: { missing: ['s2'] },
    })
    expect(fromReport.exitCode).toBe(EXIT.gates)
  })

  it('评委 JSON 无法解析：样本 judge-error，门槛 incomplete，退出码仍为 1，有效评分数少于应有', async () => {
    const s = suite({ extra: GATES })
    await recordPairs(s, 'demo@v1', [
      [4, 4],
      [4, 4],
    ])
    await s.record('demo@v2', 's1', GOOD, [4, 4], usage)
    await s.record('demo@v2', 's2', GOOD, 'not json', usage)
    const result = await run(s, { baseline: 'demo@v1' })
    expect(result.report.samples[1]?.status).toBe('judge-error')
    expect(result.report.summary).toMatchObject({ scoredSamples: 1, expectedScores: 2 })
    expect(gate(result, 'relative-accuracy')).toMatchObject({
      status: 'incomplete',
      metrics: { missing: ['s2'] },
    })
    expect(gate(result, 'accuracy-min')?.status).toBe('incomplete')
    expect(result.report.assessment?.failed).toBe(true)
    expect(result.exitCode).toBe(EXIT.failed)
  })

  it('筛选运行：报告与 ctx 标明范围，非必需的覆盖门槛 incomplete 不影响退出码', async () => {
    const s = suite({ extra: GATES })
    await recordPairs(s, 'demo@v1', [
      [4, 4],
      [4, 4],
    ])
    await recordPairs(s, 'demo@v2', [
      [4, 4],
      [4, 4],
    ])
    const result = await run(s, { baseline: 'demo@v1', samples: ['s1'] })
    expect(result.report.scope).toEqual({
      totalSamples: 2,
      selectedSamples: 1,
      filtered: true,
      sampleFilter: ['s1'],
    })
    expect(gate(result, 'coverage')).toMatchObject({
      status: 'incomplete',
      required: false,
      detail: '1 of 2',
    })
    expect(result.exitCode).toBe(0)
    const markdown = readFileSync(join(result.reportDir, 'report.md'), 'utf8')
    expect(markdown).toContain('- Scope: 1 of 2 samples (filtered: --samples s1)')
    expect(markdown).toContain('filtered run: covers only the selected samples')
  })

  it('回退与门槛同时未达成时退出码为 4，门槛仍写入报告', async () => {
    const s = suite({ extra: GATES })
    await recordPairs(s, 'demo@v1', [
      [5, 5],
      [5, 5],
    ])
    await recordPairs(s, 'demo@v2', [
      [3, 3],
      [3, 3],
    ])
    const result = await run(s, { baseline: 'demo@v1' })
    expect(result.report.baseline?.regressed).toBe(true)
    expect(result.report.assessment?.failed).toBe(true)
    expect(result.exitCode).toBe(EXIT.regression)
  })

  it('evaluateRun 抛错时记 evaluate-run 失败门槛，样本结果保留，退出码 5；终端列出门槛', async () => {
    const s = suite({ extra: `evaluateRun: () => { throw new Error('gate bug') },` })
    await recordPairs(s, 'demo@v2', [
      [4, 4],
      [4, 4],
    ])
    const result = await run(s)
    expect(result.report.samples.map((sample) => sample.status)).toEqual(['passed', 'passed'])
    expect(result.report.assessment?.gates).toEqual([
      {
        id: 'evaluate-run',
        status: 'failed',
        detail: 'evaluateRun threw: gate bug',
        required: true,
      },
    ])
    expect(result.exitCode).toBe(EXIT.gates)
    const logs: string[] = []
    const code = await main(
      ['--suite', s.name],
      { root: s.root, env: { EVIDENCE_DIR: evidence }, gitCommit: null },
      {
        log: (text) => logs.push(text),
        error: (text) => logs.push(text),
      },
    )
    expect(code).toBe(5)
    expect(logs.join('\n')).toContain('门槛未达成：evaluate-run failed')
  })

  it('未声明 evaluateRun 时 assessment 为 null，示例套件退出码不变', async () => {
    const example = await runEval(
      { suite: 'example', baseline: 'product-intro@v1' },
      { env: { EVIDENCE_DIR: evidence }, gitCommit: null },
    )
    expect(example.exitCode).toBe(0)
    expect(example.report.assessment).toBeNull()
    expect(example.report.prepareVersion).toBeNull()
    expect(example.report.scope).toEqual({ totalSamples: 6, selectedSamples: 6, filtered: false })
    expect(existsSync(join(example.reportDir, 'outputs'))).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
