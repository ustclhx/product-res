import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { EvalConfigError, EXIT, safeErrorMessage } from './errors.ts'
import { EXIT_MEANINGS } from './report.ts'
import { MAX_CONCURRENCY, type RunDeps, type RunOptions, runEval } from './runner.ts'
import { REPO_ROOT } from './suite.ts'

export const USAGE = `用法：pnpm eval:prompts --suite <name> [选项]

套件：example 为模板示例（packages/evals/example/），其他名字为项目自有的 evals/<name>/suite.ts。

模式（缺省为回放：只读录制，离线、零费用）：
  --live --budget-usd <美元>     调用真实模型，不写录制
  --record --budget-usd <美元>   调用真实模型并写入回放录制
  CI 环境变量为真时拒绝 --live / --record。

选择：
  --prompt <id@version>          评测的提示词版本（缺省为套件 defaultPrompt）
  --model <key>                  生成模型（缺省为套件 generator）
  --judge-model <key>            评委模型（缺省为套件 judge.model）
  --no-judge                     只跑确定性检查
  --samples <id,id>              只跑指定样本
  --tag <tag>                    只跑带此标签的样本
  --concurrency <1-${MAX_CONCURRENCY}>           并发数，缺省 1
  --frozen-lock                  版本锁只校验不追加（CI 为真时总是如此）

基线：
  --baseline <id@version>        同一次运行中以回放跑基线版本并对比（推荐）
  --baseline-report <path>       与以前的 report.json 对比
  --max-regression <0-1>         平均总分下降超过此值判为回退（缺省取套件值，再缺省 0.05）

退出码：0 通过；1 检查 / 转换 / 生成 / 评委失败或录制缺失、过期；2 配置错误；3 预算触顶；4 回退；
      5 套件 evaluateRun 门槛未达成或必需门槛证据不足。多种情况同时出现时取最小的非零码。
报告写入 $EVIDENCE_DIR/prompt-evals/<suite>/，未设置时为 test-results/evidence/（不进仓库）。
`

const OPTIONS = {
  suite: { type: 'string' },
  prompt: { type: 'string' },
  model: { type: 'string' },
  'judge-model': { type: 'string' },
  'no-judge': { type: 'boolean' },
  samples: { type: 'string' },
  tag: { type: 'string' },
  concurrency: { type: 'string' },
  live: { type: 'boolean' },
  record: { type: 'boolean' },
  'budget-usd': { type: 'string' },
  baseline: { type: 'string' },
  'baseline-report': { type: 'string' },
  'max-regression': { type: 'string' },
  'frozen-lock': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

function number(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (value.trim() === '' || !Number.isFinite(parsed))
    throw new EvalConfigError(`--${name} must be a number`)
  return parsed
}

export function parseCliArgs(argv: readonly string[]): RunOptions | 'help' {
  let values: ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>['values']
  try {
    ;({ values } = parseArgs({
      args: [...argv],
      options: OPTIONS,
      strict: true,
      allowPositionals: false,
    }))
  } catch (error) {
    throw new EvalConfigError(error instanceof Error ? error.message : String(error))
  }
  if (values.help) return 'help'
  if (!values.suite) throw new EvalConfigError('--suite <name> is required')
  if (values.live && values.record) throw new EvalConfigError('use either --live or --record')
  const concurrency = number('concurrency', values.concurrency)
  const budgetUsd = number('budget-usd', values['budget-usd'])
  const maxRegression = number('max-regression', values['max-regression'])
  return {
    suite: values.suite,
    mode: values.record ? 'record' : values.live ? 'live' : 'replay',
    ...(values.prompt ? { prompt: values.prompt } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values['judge-model'] ? { judgeModel: values['judge-model'] } : {}),
    ...(values['no-judge'] ? { noJudge: true } : {}),
    ...(values.samples
      ? {
          samples: values.samples
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean),
        }
      : {}),
    ...(values.tag ? { tag: values.tag } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    ...(values.baseline ? { baseline: values.baseline } : {}),
    ...(values['baseline-report'] ? { baselineReport: values['baseline-report'] } : {}),
    ...(maxRegression !== undefined ? { maxRegression } : {}),
    ...(values['frozen-lock'] ? { frozenLock: true } : {}),
  }
}

const usd = (value: number | null) => (value === null ? '—' : `$${value.toFixed(4)}`)

/** 终端只输出汇总与报告路径；错误信息不含环境变量值 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  deps: RunDeps = {},
  out: { log: (text: string) => void; error: (text: string) => void } = console,
): Promise<number> {
  let options: RunOptions | 'help'
  try {
    options = parseCliArgs(argv)
  } catch (error) {
    out.error(`配置错误：${safeErrorMessage(error)}\n\n${USAGE}`)
    return EXIT.config
  }
  if (options === 'help') {
    out.log(USAGE)
    return EXIT.ok
  }
  try {
    const { report, reportDir, exitCode } = await runEval(options, deps)
    const { summary } = report
    const lines = [
      `套件 ${report.suite} · ${report.prompt.promptVersion} · ${report.mode} · 生成 ${report.generator.key}${report.judge ? ` · 评委 ${report.judge.key}` : ''}`,
      `样本 ${summary.total}：通过 ${summary.passed}，失败 ${summary.failed}，预算跳过 ${summary.skippedBudget}，警告 ${summary.warnings}`,
      `平均分 ${summary.averageScore === null ? '—' : summary.averageScore.toFixed(3)}（${summary.scoredSamples} 个样本）`,
      report.mode === 'replay'
        ? `费用 $0（回放）；按录制用量估算真实运行约 ${usd(summary.estimatedLiveCostUsd)}`
        : `费用 ${usd(summary.costUsd)} / 预算 ${usd(report.budget.limitUsd)}${report.budget.exhausted ? '（已触顶）' : ''}`,
    ]
    if (report.baseline)
      lines.push(
        `基线 ${report.baseline.promptVersion}：平均分差 ${
          report.baseline.delta === null ? '—' : report.baseline.delta.toFixed(3)
        }${report.baseline.regressed ? '（回退）' : ''}，两侧有分 ${report.baseline.scoredPairs} / ${report.baseline.comparedSamples}${
          report.baseline.baselineFailures.length
            ? `；基线回放失败 ${report.baseline.baselineFailures.length} 个，需重录基线`
            : ''
        }`,
      )
    if (report.scope.filtered)
      lines.push(
        `范围：${report.scope.selectedSamples} / ${report.scope.totalSamples} 个样本（已筛选）`,
      )
    if (report.assessment)
      lines.push(
        `门槛${report.assessment.failed ? '未达成' : '达成'}：${report.assessment.gates
          .map((gate) => `${gate.id} ${gate.status}${gate.required ? '' : '（非必需）'}`)
          .join('，')}`,
      )
    const root = deps.root ?? REPO_ROOT
    const shown = relative(root, reportDir)
    lines.push(
      `报告：${shown.startsWith('..') ? reportDir : shown}`,
      `退出码 ${exitCode}：${EXIT_MEANINGS[exitCode] ?? ''}`,
    )
    out.log(lines.join('\n'))
    return exitCode
  } catch (error) {
    if (error instanceof EvalConfigError) {
      out.error(`配置错误：${safeErrorMessage(error)}`)
      return EXIT.config
    }
    out.error(`评测异常：${safeErrorMessage(error)}`)
    return EXIT.failed
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 不用 --env-file-if-exists（Node 22.9 起才有）：loadEnvFile 自 Node 21.7 可用，且不输出任何值
  const envFile = join(REPO_ROOT, '.env.local')
  if (existsSync(envFile)) process.loadEnvFile(envFile)
  process.exitCode = await main()
}
