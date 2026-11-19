import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { main, parseCliArgs } from './cli.ts'
import { REPO_ROOT } from './suite.ts'

const evidence = mkdtempSync(join(tmpdir(), 'evals-cli-'))
afterAll(() => rmSync(evidence, { recursive: true, force: true }))
const SECRET = 'sk-cli-test-secret'

/** 与根脚本相同的方式运行：Node 类型剥离，不经打包 */
function cli(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', 'packages/evals/src/cli.ts', ...args],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        EVIDENCE_DIR: evidence,
        OPENAI_API_KEY: SECRET,
        ...env,
      },
      timeout: 60_000,
    },
  )
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

// 子进程经类型剥离加载 @product-res/ai 全部源码，机器繁忙时可能超过默认 5 秒
describe('命令行（子进程）', { timeout: 60_000 }, () => {
  it('--help 输出用法并以 0 退出', () => {
    const { status, output } = cli(['--help'])
    expect(status).toBe(0)
    expect(output).toContain('用法：pnpm eval:prompts --suite <name>')
  })

  it('未知套件以 2 退出', () => {
    const { status, output } = cli(['--suite', 'missing-suite'])
    expect(status).toBe(2)
    expect(output).toContain('suite missing-suite not found')
    expect(output).not.toContain(SECRET)
  })

  it('--live 未给预算以 2 退出', () => {
    const { status, output } = cli(['--suite', 'example', '--live'])
    expect(status).toBe(2)
    expect(output).toContain('--live requires --budget-usd')
  })

  it('示例套件以回放完整运行并以 0 退出，终端只输出汇总与报告路径', () => {
    const { status, output } = cli(['--suite', 'example', '--baseline', 'product-intro@v1'])
    expect(status).toBe(0)
    expect(output).toContain('基线 product-intro@v1')
    expect(output).toContain(`报告：${evidence}`)
    expect(output).not.toContain(SECRET)
  })
})

describe('参数解析', () => {
  it('解析选择与模式参数，拒绝未知参数与互斥模式', async () => {
    expect(
      parseCliArgs([
        '--suite',
        'example',
        '--record',
        '--budget-usd',
        '0.5',
        '--samples',
        'a, b',
        '--no-judge',
        '--concurrency',
        '2',
      ]),
    ).toEqual({
      suite: 'example',
      mode: 'record',
      budgetUsd: 0.5,
      samples: ['a', 'b'],
      noJudge: true,
      concurrency: 2,
    })
    const errors: string[] = []
    const out = { log: () => {}, error: (text: string) => errors.push(text) }
    expect(await main(['--suite', 'example', '--bogus'], {}, out)).toBe(2)
    expect(await main(['--suite', 'example', '--live', '--record'], {}, out)).toBe(2)
    expect(await main(['--suite', 'example', '--budget-usd', 'abc'], {}, out)).toBe(2)
    expect(await main([], {}, out)).toBe(2)
    expect(errors.join('\n')).toContain('--suite <name> is required')
  })
})
