import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { definePrompt } from '@product-res/ai'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { checks } from './checks.ts'
import { EvalConfigError } from './errors.ts'
import { LOCK_FILE, verifyLock } from './lock.ts'
import { parseSamples } from './sample.ts'
import {
  defineSuite,
  findPrompt,
  loadSuite,
  suiteDir,
  validateExpect,
  validateInputs,
} from './suite.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'evals-suite-'))
  dirs.push(dir)
  return dir
}

type Input = { topic: string }
const v1 = (system = 'Write briefly.') =>
  definePrompt<Input>({
    id: 'intro',
    version: 'v1',
    system,
    user: (input) => `Topic: ${input.topic}`,
    maxOutputTokens: 200,
  })
const v2 = definePrompt<Input>({
  id: 'intro',
  version: 'v2',
  system: 'Write well.',
  user: (input) => `Topic: ${input.topic}`,
  maxOutputTokens: 300,
})
const suiteWith = (prompts = [v1()]) =>
  defineSuite({
    name: 'demo',
    prompts,
    models: { gen: { provider: 'openai', providerModelId: 'gpt-x' } },
    generator: 'gen',
  })
const samples = (topic = 'tea') => parseSamples([{ id: 's1', input: { topic } }])

const expectConfigError = async (fn: () => unknown, pattern: RegExp) => {
  const error = await Promise.resolve()
    .then(fn)
    .then(
      () => undefined,
      (caught: unknown) => caught,
    )
  expect(error).toBeInstanceOf(EvalConfigError)
  expect((error as Error).message).toMatch(pattern)
}

describe('样本与套件定义', () => {
  it('拒绝重复样本 ID 与不合法的 expect', async () => {
    await expectConfigError(
      () =>
        parseSamples([
          { id: 'a', input: 1 },
          { id: 'a', input: 2 },
        ]),
      /duplicate sample id a/,
    )
    await expectConfigError(() => parseSamples([{ id: '../x', input: 1 }]), /invalid/)
    const suite = defineSuite({ ...suiteWith(), checks: [checks.length({ max: 10 })] })
    await expectConfigError(
      () => validateExpect(suite, parseSamples([{ id: 'a', input: 1, expect: { nope: {} } }])),
      /expect.nope has no matching check/,
    )
    await expectConfigError(
      () =>
        validateExpect(
          suite,
          parseSamples([{ id: 'a', input: 1, expect: { length: { max: 'x' } } }]),
        ),
      /expect.length is invalid/,
    )
  })

  it('未知提示词版本与不完整套件为配置错误', async () => {
    await expectConfigError(() => findPrompt(suiteWith(), 'intro@v9'), /unknown prompt version/)
    await expectConfigError(
      () => defineSuite({ ...suiteWith(), generator: 'missing' }),
      /generator missing/,
    )
    await expectConfigError(
      () => defineSuite({ ...suiteWith(), prompts: [v1(), v1()] }),
      /duplicate/,
    )
    const rubric = {
      version: 'r1',
      criteria: [{ id: 'a', description: 'A' }],
      scale: { min: 1, max: 5 },
    }
    for (const maxOutputTokens of [0, 1.5, -1])
      await expectConfigError(
        () => defineSuite({ ...suiteWith(), judge: { model: 'gen', rubric, maxOutputTokens } }),
        /judge.maxOutputTokens/,
      )
    await expectConfigError(
      () =>
        defineSuite({
          ...suiteWith(),
          models: {
            gen: {
              provider: 'deepseek',
              providerModelId: 'x',
              thinking: 'off' as unknown as boolean,
            },
          },
        }),
      /thinking must be true or false/,
    )
    expect(
      defineSuite({ ...suiteWith(), judge: { model: 'gen', rubric, maxOutputTokens: 8000 } }).judge
        ?.maxOutputTokens,
    ).toBe(8000)
  })

  it('prepareOutput 需要短标识版本与函数，evaluateRun 必须是函数', async () => {
    const run = ({ rawOutput }: { rawOutput: string }) => ({ output: rawOutput })
    for (const version of ['', 'has space', undefined as unknown as string])
      await expectConfigError(
        () => defineSuite({ ...suiteWith(), prepareOutput: { version, run } }),
        /prepareOutput.version/,
      )
    await expectConfigError(
      () =>
        defineSuite({
          ...suiteWith(),
          prepareOutput: { version: 'g1', run: 'x' as unknown as typeof run },
        }),
      /prepareOutput.run/,
    )
    await expectConfigError(
      () => defineSuite({ ...suiteWith(), evaluateRun: {} as unknown as () => { gates: [] } }),
      /evaluateRun must be a function/,
    )
    const ok = defineSuite({
      ...suiteWith(),
      prepareOutput: { version: 'guard.v4', run },
      evaluateRun: () => ({ gates: [] }),
    })
    expect(ok.prepareOutput?.version).toBe('guard.v4')
  })

  it('example 指向包内示例，其他名字指向根目录 evals/，不存在时配置错误', async () => {
    const root = temp()
    expect(suiteDir('example', root)).toBe(join(root, 'packages/evals/example'))
    expect(suiteDir('report', root)).toBe(join(root, 'evals/report'))
    await expectConfigError(() => suiteDir('../x', root), /invalid suite name/)
    await expectConfigError(() => loadSuite('report', root), /suite report not found/)
  })
})

describe('版本锁', () => {
  it('首次运行追加条目，改 system 报错且锁不变', async () => {
    const dir = temp()
    const first = await verifyLock(suiteWith(), samples(), dir)
    expect(first.appended).toBe(1)
    const before = readFileSync(join(dir, LOCK_FILE), 'utf8')
    expect(JSON.parse(before)['intro@v1'].s1.rendered).toBe(
      first.rendered.get('intro@v1')?.get('s1'),
    )
    await expectConfigError(
      () => verifyLock(suiteWith([v1('Write at length.')]), samples(), dir),
      /intro@v1 content changed for sample s1; create a new prompt version/,
    )
    expect(readFileSync(join(dir, LOCK_FILE), 'utf8')).toBe(before)
  })

  it('改样本输入提示新增样本 ID，而不是新建版本', async () => {
    const dir = temp()
    await verifyLock(suiteWith(), samples(), dir)
    const before = readFileSync(join(dir, LOCK_FILE), 'utf8')
    await expectConfigError(
      () => verifyLock(suiteWith(), samples('coffee'), dir),
      /sample s1 input changed .*add a new sample id/,
    )
    expect(readFileSync(join(dir, LOCK_FILE), 'utf8')).toBe(before)
  })

  it('新版本与新样本只追加，已有条目从不改写', async () => {
    const dir = temp()
    await verifyLock(suiteWith(), samples(), dir)
    const original = JSON.parse(readFileSync(join(dir, LOCK_FILE), 'utf8'))
    const more = parseSamples([
      { id: 's1', input: { topic: 'tea' } },
      { id: 's2', input: { topic: 'rice' } },
    ])
    const result = await verifyLock(suiteWith([v1(), v2]), more, dir)
    expect(result.appended).toBe(3)
    const lock = JSON.parse(readFileSync(join(dir, LOCK_FILE), 'utf8'))
    expect(lock['intro@v1'].s1).toEqual(original['intro@v1'].s1)
    expect(Object.keys(lock)).toEqual(['intro@v1', 'intro@v2'])
    expect(Object.keys(lock['intro@v2'])).toEqual(['s1', 's2'])
    // 再次运行无变化，不写文件
    const stamp = readFileSync(join(dir, LOCK_FILE), 'utf8')
    expect((await verifyLock(suiteWith([v1(), v2]), more, dir)).appended).toBe(0)
    expect(readFileSync(join(dir, LOCK_FILE), 'utf8')).toBe(stamp)
  })

  it('冻结时任何追加都是配置错误：删掉条目不能重新锁定改过的内容', async () => {
    const dir = temp()
    await verifyLock(suiteWith(), samples(), dir)
    // 删掉 v1 的条目后，用改过的 system 重新运行
    writeFileSync(join(dir, LOCK_FILE), '{}\n')
    await expectConfigError(
      () => verifyLock(suiteWith([v1('Write at length.')]), samples(), dir, { frozen: true }),
      /intro@v1 \/ s1 is not in prompts.lock.json; the lock is frozen/,
    )
    expect(readFileSync(join(dir, LOCK_FILE), 'utf8')).toBe('{}\n')
  })

  it('锁文件结构不合法时为配置错误', async () => {
    const dir = temp()
    writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ 'intro@v1': { s1: { input: 'x' } } }))
    await expectConfigError(() => verifyLock(suiteWith(), samples(), dir), /invalid shape/)
  })

  it('样本输入不符合套件 inputSchema 时为配置错误', async () => {
    const suite = defineSuite({
      ...suiteWith(),
      inputSchema: z.strictObject({ topic: z.string() }),
    })
    validateInputs(suite, samples())
    await expectConfigError(
      () => validateInputs(suite, parseSamples([{ id: 'bad', input: { topic: 1 } }])),
      /sample bad: input does not match the suite inputSchema/,
    )
  })

  it('锁文件不是 JSON 时为配置错误', async () => {
    const dir = temp()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, LOCK_FILE), '{')
    await expectConfigError(() => verifyLock(suiteWith(), samples(), dir), /not valid JSON/)
  })
})
