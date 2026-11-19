#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as ts from 'typescript/unstable/ast'
import { createVirtualFileSystem } from 'typescript/unstable/fs'
import { API } from 'typescript/unstable/sync'
import { componentLockViolations } from './ui-lock.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const PROJECT_INDEX =
  '// 项目自有组件入口。模板仅初始化此文件，后续组件与导出由衍生项目维护。\nexport {}\n'
const RULES = {
  'color-literal': '颜色应使用设计 token',
  'arbitrary-class': 'className 应使用 token 工具类，禁止任意值',
  'native-select': '请使用共享组件包的 Select',
  'browser-dialog': '请使用共享组件包的确认对话框',
}
const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.wrangler',
  '.output',
  '.turbo',
  '__tests__',
  '__snapshots__',
  'test',
  'tests',
  'generated',
  '__generated__',
  'paraglide',
])
const COLOR =
  /(?<![\w#])#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\w-])|\b(?:rgba?|hsla?|oklch)\([^)]*\)/gi
// 方括号变体（如 aria-[current=page]:text-primary）仍使用 token，只拦截工具值/属性值。
const ARBITRARY_CLASS = /(?<!\S)(?:[^\s]*-\[[^\]]+\]|(?:[^\s]*:)?\[[^\]]+\])(?:\/[^\s]+)?(?=\s|$)/g

function sourceFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return EXCLUDED_DIRS.has(entry.name) ? [] : sourceFiles(path)
    }
    return entry.isFile() &&
      entry.name.endsWith('.tsx') &&
      !/\.(?:test|spec|gen|generated)\.tsx$/.test(entry.name)
      ? [path]
      : []
  })
}

function findingsOfSource(source, checker) {
  const findings = []
  const classNodes = new Set()
  function add(node, rule, value) {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source))
    findings.push({ rule, value, line: line + 1, column: character + 1 })
  }
  function isStringPart(node) {
    return (
      ts.isStringLiteral(node) ||
      node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    )
  }
  function scanClass(node) {
    if (classNodes.has(node)) return
    classNodes.add(node)
    if (isStringPart(node)) {
      for (const match of node.text.matchAll(ARBITRARY_CLASS)) {
        add(node, 'arbitrary-class', match[0])
      }
    }
    if (ts.isIdentifier(node)) {
      const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration?.resolve()
      if (
        declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        declaration.getSourceFile().fileName === source.fileName
      ) {
        scanClass(declaration.initializer)
      }
    }
    node.forEachChild(scanClass)
  }
  function visit(node) {
    if (isStringPart(node)) {
      for (const match of node.text.matchAll(COLOR)) add(node, 'color-literal', match[0])
    }
    if (ts.isJsxAttribute(node) && node.name.text === 'className') scanClass(node)
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      node.tagName.text === 'select'
    ) {
      add(node, 'native-select', '<select>')
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (
        ts.isIdentifier(callee) &&
        ['confirm', 'alert'].includes(callee.text) &&
        !checker.getSymbolAtLocation(callee)
      ) {
        add(node, 'browser-dialog', callee.text)
      } else if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const target = callee.expression
        const name = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : callee.argumentExpression.text
        if (
          ts.isIdentifier(target) &&
          ['window', 'globalThis', 'self'].includes(target.text) &&
          !checker.getSymbolAtLocation(target)?.declarations.length &&
          ['confirm', 'alert'].includes(name) &&
          (ts.isPropertyAccessExpression(callee) || isStringPart(callee.argumentExpression))
        ) {
          add(node, 'browser-dialog', `${target.text}.${name}`)
        }
      }
    }
    node.forEachChild(visit)
  }
  visit(source)
  return findings
}

// 与 check-deps 一样使用 TS 7 native parser，批量解析且不加载依赖。
function scanSources(files) {
  if (Object.keys(files).length === 0) return []
  const config = '/check-ui/tsconfig.json'
  const api = new API({
    cwd: '/check-ui',
    fs: createVirtualFileSystem({
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true, jsx: 'preserve' },
        files: Object.keys(files),
      }),
      ...files,
    }),
  })
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] })
    try {
      const { program, checker } = snapshot.getProject(config)
      return Object.keys(files).flatMap((file) =>
        findingsOfSource(program.getSourceFile(file), checker).map((finding) => ({
          file,
          ...finding,
        })),
      )
    } finally {
      snapshot.dispose()
    }
  } finally {
    api.close()
  }
}

export function findingsOf(text, file = 'source.tsx') {
  return scanSources({ [resolve('/check-ui', file)]: text })
}

function readAllowList(root, name, optional = false) {
  const path = join(root, 'scripts', name)
  if (optional && !existsSync(path)) return []
  const config = JSON.parse(readFileSync(path, 'utf8'))
  const entries = []
  for (const group of ['exceptions', 'pendingReplacement']) {
    for (const [file, allowances] of Object.entries(config[group] ?? {})) {
      if (file.startsWith('/') || file.includes('\\') || file.split('/').includes('..')) {
        throw new Error(`${name}：例外必须使用仓库相对文件路径：${file}`)
      }
      for (const entry of allowances) {
        if (
          !Object.hasOwn(RULES, entry.rule) ||
          typeof entry.reason !== 'string' ||
          !entry.reason.trim() ||
          (group === 'pendingReplacement' &&
            (typeof entry.value !== 'string' || !Number.isInteger(entry.count) || entry.count < 1))
        ) {
          throw new Error(`${name}：${file} 的 ${group} 登记缺少有效规则、原因或待替换值/数量`)
        }
        entries.push({ file, ...entry, remaining: entry.count ?? Infinity })
      }
    }
  }
  return entries
}

function projectDirectoryViolations(root) {
  if (existsSync(join(root, '.template-base.json'))) return []
  const dir = 'packages/ui/src/project'
  const expected = { '.gitkeep': '', 'index.ts': PROJECT_INDEX }
  const path = join(root, dir)
  const entries = existsSync(path) ? readdirSync(path, { withFileTypes: true }) : []
  const changed = new Set(
    entries
      .filter((entry) => !entry.isFile() || !Object.hasOwn(expected, entry.name))
      .map((entry) => entry.name),
  )
  for (const [file, contents] of Object.entries(expected)) {
    const entry = entries.find((entry) => entry.name === file)
    if (!entry?.isFile() || readFileSync(join(path, file), 'utf8') !== contents) changed.add(file)
  }
  return [...changed].sort().map((file) => ({
    file: `${dir}/${file}`,
    line: 1,
    column: 1,
    rule: 'project-directory',
    value:
      '模板的项目组件目录只能保留空 .gitkeep 与固定的 index.ts 占位内容；项目组件由衍生项目维护',
  }))
}

export function checkUi(root = ROOT) {
  const allowances = [
    ...readAllowList(root, 'check-ui.allow.json'),
    ...readAllowList(root, 'check-ui.allow.local.json', true),
  ]
  const apps = join(root, 'apps')
  const files = existsSync(apps)
    ? readdirSync(apps, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => sourceFiles(join(apps, entry.name, 'src')))
    : []
  files.push(...sourceFiles(join(root, 'packages/ui/src/project')))
  const findings = scanSources(
    Object.fromEntries(files.map((file) => [file, readFileSync(file, 'utf8')])),
  ).map((finding) => ({ ...finding, file: relative(root, finding.file).split(sep).join('/') }))
  const violations = findings.filter((finding) => {
    const allowance = allowances.find(
      (entry) =>
        entry.file === finding.file &&
        entry.rule === finding.rule &&
        (entry.value === undefined || entry.value === finding.value) &&
        entry.remaining > 0,
    )
    if (!allowance) return true
    allowance.remaining--
    return false
  })
  return {
    files: files.length,
    findings,
    violations: [
      ...violations,
      ...componentLockViolations(root),
      ...projectDirectoryViolations(root),
    ],
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const uiPackage = JSON.parse(readFileSync(join(ROOT, 'packages/ui/package.json'), 'utf8')).name
  const result = checkUi()
  if (result.violations.length > 0) {
    console.error(`UI 规范检查失败（${result.violations.length} 处）：`)
    for (const { file, line, column, rule, value } of result.violations) {
      const message = RULES[rule]?.replace('共享组件包', uiPackage)
      console.error(
        `  - ${file}:${line}:${column} [${rule}] ${value}${message ? `：${message}` : ''}`,
      )
    }
    process.exitCode = 1
  } else {
    console.log(
      `UI 规范检查通过：${result.files} 个文件，已登记 ${result.findings.length} 处例外/待替换`,
    )
  }
}
