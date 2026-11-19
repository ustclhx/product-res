import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { Report } from './runner.ts'

/**
 * 报告（design D9）：写到 `$EVIDENCE_DIR/prompt-evals/<suite>/<UTC 时间戳>-<版本>-<模式>/`，
 * 未设置时为已被忽略的 `test-results/evidence/`；不写环境变量、密钥、请求头或端点。
 */
export function evidenceRoot(root: string, env: Readonly<Record<string, string | undefined>>) {
  const configured = env.EVIDENCE_DIR?.trim()
  if (!configured) return resolve(root, 'test-results/evidence')
  return isAbsolute(configured) ? configured : resolve(root, configured)
}

const stamp = (date: Date) =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')

export function reportDirFor(
  report: Pick<Report, 'suite' | 'mode' | 'prompt'>,
  options: { root: string; env: Readonly<Record<string, string | undefined>>; now: Date },
) {
  return join(
    evidenceRoot(options.root, options.env),
    'prompt-evals',
    report.suite,
    `${stamp(options.now)}-${report.prompt.promptVersion}-${report.mode}`,
  )
}

export function writeReport(
  report: Report,
  options: { root: string; env: Readonly<Record<string, string | undefined>>; now: Date },
  /** 声明 prepareOutput 时的原文与被评正文：写 `outputs/<id>.txt`，与原文不同时另写 `.raw.txt` */
  texts?: ReadonlyMap<string, { readonly raw: string; readonly output?: string }>,
): string {
  const dir = reportDirFor(report, options)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(dir, 'report.md'), renderMarkdown(report))
  if (texts?.size) {
    const outputs = join(dir, 'outputs')
    mkdirSync(outputs, { recursive: true })
    // 样本 ID 已按 idPattern 校验，不含路径分隔符
    for (const [id, { raw, output }] of texts) {
      // 转换失败时没有被评正文，只写原文
      if (output !== undefined) writeFileSync(join(outputs, `${id}.txt`), output)
      if (raw !== output) writeFileSync(join(outputs, `${id}.raw.txt`), raw)
    }
  }
  return dir
}

const usd = (value: number | null) => (value === null ? '—' : `$${value.toFixed(4)}`)
const score = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : value.toFixed(3)
const signed = (value: number | null) =>
  value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(3)}`
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ')

export const EXIT_MEANINGS: Readonly<Record<number, string>> = {
  0: 'passed',
  1: 'check, generation or judge failures, or missing / stale recordings',
  2: 'configuration error',
  3: 'budget reached; some samples skipped',
  4: 'regression against baseline',
  5: 'project gates failed or required gates incomplete',
}

function scopeText(report: Report): string {
  const { scope } = report
  const filters = [
    scope.sampleFilter ? `--samples ${scope.sampleFilter.join(',')}` : '',
    scope.tag ? `--tag ${scope.tag}` : '',
  ].filter(Boolean)
  return `${scope.selectedSamples} of ${scope.totalSamples} samples${
    scope.filtered ? ` (filtered${filters.length ? `: ${filters.join('; ')}` : ''})` : ''
  }`
}

export function renderMarkdown(report: Report): string {
  const { summary } = report
  const lines = [
    `# Prompt eval: ${report.suite} / ${report.prompt.promptVersion}`,
    '',
    `- Mode: ${report.mode}`,
    `- Created: ${report.createdAt}`,
    `- Commit: ${report.gitCommit ?? 'unknown'}`,
    `- Generator: ${report.generator.key} (${report.generator.provider} ${report.generator.providerModelId})`,
    `- Judge: ${
      report.judge
        ? `${report.judge.key} (${report.judge.provider} ${report.judge.providerModelId}), rubric ${report.judge.rubricVersion}`
        : 'none'
    }`,
    `- Scope: ${scopeText(report)}`,
    ...(report.prepareVersion ? [`- prepareOutput: ${report.prepareVersion}`] : []),
    `- Exit code: ${report.exitCode} (${EXIT_MEANINGS[report.exitCode] ?? ''})`,
    '',
    '## Summary',
    '',
    `- Samples: ${summary.total}; passed ${summary.passed}; failed ${summary.failed}; skipped (budget) ${summary.skippedBudget}; warnings ${summary.warnings}`,
    `- Pass rate: ${(summary.passRate * 100).toFixed(1)}%`,
    `- Average score: ${score(summary.averageScore)} over ${summary.scoredSamples} scored samples${
      summary.expectedScores ? ` (expected ${summary.expectedScores})` : ''
    }`,
    `- Cost: ${usd(summary.costUsd)}${
      report.budget.limitUsd !== null
        ? ` of budget ${usd(report.budget.limitUsd)}${report.budget.exhausted ? ' (reached)' : ''}`
        : ''
    }`,
    ...(report.mode === 'replay'
      ? [`- Estimated live cost from recorded usage: ${usd(summary.estimatedLiveCostUsd)}`]
      : []),
    ...(summary.inputTokenRatio !== null
      ? [`- Actual / estimated input tokens: ${summary.inputTokenRatio.toFixed(2)}`]
      : []),
    '',
  ]
  if (report.assessment) {
    lines.push(
      '## Gates',
      '',
      `- Result: ${report.assessment.failed ? 'not met' : 'met'}${
        report.scope.filtered ? ' (filtered run: covers only the selected samples)' : ''
      }`,
      '',
      '| Gate | Status | Required | Detail |',
      '| --- | --- | --- | --- |',
      ...report.assessment.gates.map(
        (gate) =>
          `| ${gate.id} | ${gate.status} | ${gate.required ? 'yes' : 'no'} | ${cell(gate.detail)} |`,
      ),
      '',
    )
    for (const gate of report.assessment.gates)
      if (gate.metrics)
        lines.push(`- ${gate.id} metrics: \`${cell(JSON.stringify(gate.metrics))}\``)
    if (report.assessment.gates.some((gate) => gate.metrics)) lines.push('')
  }
  if (report.baseline) {
    const { baseline } = report
    lines.push(
      '## Baseline',
      '',
      `- Baseline: ${baseline.promptVersion} (${baseline.kind === 'prompt' ? 'replayed in this run' : `report ${baseline.source}`})`,
      `- Average: ${score(baseline.baselineAverage)} → ${score(baseline.currentAverage)} (${signed(baseline.delta)}), threshold ${baseline.threshold}`,
      `- Regression: ${baseline.regressed ? 'yes' : 'no'}`,
      `- Scored on both sides: ${baseline.scoredPairs} of ${baseline.comparedSamples} compared samples${
        baseline.scoredPairs < baseline.comparedSamples
          ? ' — the regression check covers only these; re-record the missing side'
          : ''
      }`,
      ...(baseline.baselineFailures.length
        ? [
            `- Baseline replay failures: ${baseline.baselineFailures
              .map((item) => `${item.id} (${item.status})`)
              .join(', ')}`,
          ]
        : []),
      '',
      '| Sample | Baseline | Current | Δ | Check changes |',
      '| --- | --- | --- | --- | --- |',
      ...baseline.samples.map(
        (sample) =>
          `| ${sample.id} | ${score(sample.baselineScore)} | ${score(sample.score)} | ${signed(sample.delta)}${sample.regressed ? ' ⚠' : ''} | ${
            sample.checksChanged
              .map(
                (change) =>
                  `${change.id}: ${change.before ? 'pass' : 'fail'}→${change.after ? 'pass' : 'fail'}`,
              )
              .join(', ') || '—'
          } |`,
      ),
      '',
    )
  }
  lines.push(
    '## Samples',
    '',
    '| Sample | Status | Failed checks | Score | Cost |',
    '| --- | --- | --- | --- | --- |',
    ...report.samples.map(
      (sample) =>
        `| ${sample.id} | ${sample.status} | ${
          sample.checks
            .filter((check) => !check.pass)
            .map((check) => `${check.id}${check.severity === 'warn' ? ' (warn)' : ''}`)
            .join(', ') || '—'
        } | ${score(sample.judge?.score)} | ${usd(report.mode === 'replay' ? sample.estimatedCostUsd : sample.costUsd)} |`,
    ),
    '',
    '## Details',
    '',
  )
  for (const sample of report.samples) {
    lines.push(`### ${sample.id}`, '', `- Status: ${sample.status}`)
    if (sample.error) lines.push(`- Error: ${cell(sample.error)}`)
    const generation = sample.usage.generation
    if (generation)
      lines.push(
        `- Generation: ${generation.outputTokens ?? '—'} output tokens, ${
          generation.durationMs === undefined ? 'duration unknown' : `${generation.durationMs} ms`
        }`,
      )
    if (sample.prepared)
      lines.push(
        `- Prepared (${sample.prepared.version}): ${sample.prepared.changed ? 'changed' : 'unchanged'}, ${sample.prepared.rawChars} → ${sample.prepared.outputChars} chars${
          sample.prepared.annotations
            ? `; annotations \`${cell(JSON.stringify(sample.prepared.annotations))}\``
            : ''
        }`,
      )
    for (const check of sample.checks)
      lines.push(
        `- Check ${check.id}: ${check.pass ? 'pass' : `fail (${check.severity})`}${check.detail ? ` — ${cell(check.detail)}` : ''}`,
      )
    if (sample.judge) {
      lines.push(
        `- Judge (${sample.judge.model}): ${sample.judge.status}${sample.judge.error ? ` — ${cell(sample.judge.error)}` : ''}`,
      )
      for (const [id, item] of Object.entries(sample.judge.criteria ?? {}))
        lines.push(`  - ${id}: ${item.score} — ${cell(item.reason)}`)
      if (sample.judge.summary) lines.push(`  - Summary: ${cell(sample.judge.summary)}`)
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}
