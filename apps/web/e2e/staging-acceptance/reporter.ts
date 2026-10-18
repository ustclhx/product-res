import type {
  FullResult,
  Reporter,
  TestCase,
  TestError,
  TestResult,
} from '@playwright/test/reporter'

import { guidancePrefix } from './accounts.ts'
import { safeDiagnostic } from './diagnostic.ts'

// 默认 reporter 的 locator/请求诊断可能包含邮箱或请求体；这里只输出固定标题与状态。
export default class AcceptanceReporter implements Reporter {
  onStdOut(chunk: string | Buffer) {
    // 只转发固定人工登录提示，不能放行页面、请求或第三方诊断输出。
    const prompt = '请在弹出的浏览器中登录管理员账号（可使用 Google，等待时间 5 分钟）\n'
    if (String(chunk) === prompt) process.stdout.write(prompt)
  }
  onTestEnd(test: TestCase, result: TestResult) {
    const skip =
      result.status === 'skipped'
        ? test.annotations
            .filter((item) => item.type === 'skip')
            .map((item) => item.description)
            .join('; ')
        : ''
    process.stdout.write(`${result.status}: ${test.title}${skip ? ` (${skip})` : ''}\n`)
    for (const error of result.errors) this.onError(error)
  }
  onError(error: TestError) {
    const message = error.message?.replace(/^Error: /, '')
    // 准备检查只构造固定指引、模型 key、数值和 UUID，不输出通用异常中的敏感数据。
    if (message?.startsWith(guidancePrefix)) process.stdout.write(`${message}\n`)
    else process.stdout.write(`Failure diagnostic: ${safeDiagnostic(message)}\n`)
    const frames =
      error.stack?.split('\n').filter((line) => /^\s+at .*\.[cm]?tsx?:\d+:\d+\)?$/.test(line)) ?? []
    process.stdout.write(
      `Failure location: ${frames.slice(0, 3).join('\n') || 'setup/server; inspect locally without exporting logs'}\n`,
    )
  }
  onEnd(result: FullResult) {
    process.stdout.write(`Acceptance suite: ${result.status}\n`)
  }
}
