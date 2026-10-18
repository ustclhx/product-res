// 禁止生产源码引用旧测试工厂：导入别名与 namespace 调用也必须经过环境工厂。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ast from 'typescript/unstable/ast'
import { API } from 'typescript/unstable/async'

export async function checkPaymentRuntime(root, paths) {
  const diagnostics = []
  const files = paths.filter(
    (path) =>
      /^(apps|packages)\/.*\/src\/.*\.[cm]?[jt]sx?$/.test(path) &&
      !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path) &&
      path !== 'packages/billing/src/runtime.ts' &&
      readFileSync(resolve(root, path), 'utf8').includes('createTestPaymentRuntime'),
  )
  if (!files.length) return diagnostics
  const configPath = resolve(root, '__payment_runtime_check__.json')
  const config = JSON.stringify({
    compilerOptions: { allowJs: true, noEmit: true, noLib: true, jsx: 'preserve' },
    files: files.map((path) => resolve(root, path)),
  })
  const api = new API({
    cwd: root,
    fs: {
      readFile: (path) => (path === configPath ? config : undefined),
      fileExists: (path) => (path === configPath ? true : undefined),
    },
  })
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [configPath] })
    const project = snapshot.getProject(configPath)
    if (!project) throw new Error('Payment checker could not load its TypeScript project')
    for (const path of files) {
      const source = await project.program.getSourceFile(resolve(root, path))
      if (!source) throw new Error(`Payment checker could not parse ${path}`)
      const visit = (node) => {
        if (
          (ast.isIdentifier(node) || ast.isStringLiteral(node)) &&
          node.text === 'createTestPaymentRuntime'
        ) {
          diagnostics.push({
            path,
            line: source.text.slice(0, node.getStart(source)).split('\n').length,
            message: 'Use createPaymentRuntime for environment-aware payments',
          })
        }
        node.forEachChild(visit)
      }
      visit(source)
    }
    await snapshot.dispose()
  } finally {
    await api.close()
  }
  return diagnostics
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? resolve(import.meta.dirname, '..'))
  const paths = [
    ...new Set(
      execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
        cwd: root,
        encoding: 'utf8',
      })
        .split('\0')
        .filter(Boolean),
    ),
  ]
  const diagnostics = await checkPaymentRuntime(root, paths)
  for (const item of diagnostics) console.error(`${item.path}:${item.line}: ${item.message}`)
  if (diagnostics.length) process.exitCode = 1
  else console.log('Payment runtime check passed')
}
