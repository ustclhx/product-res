#!/usr/bin/env node
// Production credit mutations belong to packages/credits. No inline suppressions.
// Usage: node scripts/check-credit-writes.mjs [repository-root]
// Uses the installed TypeScript 7 AST API, not a source-text regex scan.
// Static boundary: follows imported names, namespaces, destructuring and local initializer aliases;
// does not follow function arguments/returns, mutable assignments, reflection, or computed names.
// SQL checks literal text (including comments/quoted identifiers and known table interpolation).
// Dynamically assembled SQL/table names, SQL returned by functions and SQL loaded from external
// files are outside this check: production callers must use packages/credits for those writes too.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ast from 'typescript/unstable/ast'
import { API, SymbolFlags } from 'typescript/unstable/async'

const tables = new Map([
  ['creditGrant', 'credit_grant'],
  ['creditHold', 'credit_hold'],
  ['creditHoldAllocation', 'credit_hold_allocation'],
  ['creditLedger', 'credit_ledger'],
  ['creditDebt', 'credit_debt'],
])
const mutations = new Set(['insert', 'update', 'delete', 'updateById', 'deleteById'])

export function isExcluded(path) {
  return (
    path.startsWith('packages/credits/') ||
    /\.test\.ts$/.test(path) ||
    /(^|\/)(fixtures|__fixtures__)\//.test(path) ||
    path.startsWith('packages/db/src/schema/') ||
    path.startsWith('packages/db/migrations/')
  )
}

// SQL tokenization ignores values/comments, preserving quoted identifiers. The regex below
// operates on SQL tokens extracted from AST literals, never on TypeScript source text.
function sqlWrites(text) {
  const tokens =
    text.match(
      /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|[a-z_][a-z_0-9]*|[.,;]/gi,
    ) ?? []
  const clean = tokens
    .filter((t) => !t.startsWith('--') && !t.startsWith('/*') && !t.startsWith("'"))
    .map((t) => t.replace(/^"|"$/g, '').toLowerCase())
  const found = new Set()
  for (let i = 0; i < clean.length; i++) {
    let j = i + 1
    if (clean[i] === 'insert' && clean[j] === 'into') j++
    else if (clean[i] === 'delete' && clean[j] === 'from') j++
    else if (clean[i] === 'truncate') {
      if (clean[j] === 'table') j++
    } else if (clean[i] !== 'update') continue
    if (clean[j] === 'only') j++
    do {
      while (clean[j + 1] === '.') j += 2
      if (/^credit_[a-z_0-9]+$/.test(clean[j] ?? '')) found.add(clean[j])
      j++
      if (clean[i] !== 'truncate' || clean[j] !== ',') break
      j++
    } while (j < clean.length)
  }
  return [...found]
}

export async function checkCreditWrites(root, paths) {
  const files = paths.filter((p) => !isExcluded(p) && /\.(?:[cm]?[jt]sx?|sql)$/.test(p))
  const configPath = resolve(root, '__credit_write_check__.json')
  const config = JSON.stringify({
    compilerOptions: {
      allowJs: true,
      noEmit: true,
      noLib: true,
      module: 'nodenext',
      moduleResolution: 'nodenext',
      jsx: 'preserve',
    },
    files: files.filter((p) => !p.endsWith('.sql')).map((p) => resolve(root, p)),
  })
  if (!files.length) return []
  // 异步 API 关闭 stdin 让子进程正常 EOF 退出；同步 API 的 SIGTERM 会偶发输出 context canceled。
  const api = new API({
    cwd: root,
    fs: {
      readFile: (p) => (p === configPath ? config : undefined),
      fileExists: (p) => (p === configPath ? true : undefined),
    },
  })
  const diagnostics = []
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [configPath] })
    const project = snapshot.getProject(configPath)
    if (!project) throw new Error('Credit checker could not load its TypeScript project')
    const checker = project.checker
    const symbol = (node) => checker.getSymbolAtLocation(node)
    for (const path of files) {
      const report = (start, message, text) => {
        const prefix = text.slice(0, start)
        diagnostics.push({ path, line: prefix.split('\n').length, message })
      }
      if (path.endsWith('.sql')) {
        for (const table of sqlWrites(readFileSync(resolve(root, path), 'utf8')))
          report(0, `Raw SQL write to ${table}`, '')
        continue
      }
      const source = await project.program.getSourceFile(resolve(root, path))
      if (!source) throw new Error(`Credit checker could not parse ${path}`)
      const bindings = new Map()
      const visit = async (node, fn) => {
        await fn(node)
        const children = []
        node.forEachChild((child) => {
          children.push(child)
        })
        for (const child of children) await visit(child, fn)
      }
      await visit(source, async (node) => {
        if (ast.isImportSpecifier(node)) {
          const name = (node.propertyName ?? node.name).text
          if (tables.has(name)) bindings.set((await symbol(node.name))?.id, name)
        }
        if (ast.isVariableDeclaration(node) && node.initializer) {
          if (ast.isIdentifier(node.name))
            bindings.set((await symbol(node.name))?.id, node.initializer)
          else if (ast.isObjectBindingPattern(node.name)) {
            for (const element of node.name.elements) {
              const name = (element.propertyName ?? element.name).text
              if (tables.has(name)) bindings.set((await symbol(element.name))?.id, name)
            }
          }
        }
      })
      const tableOf = async (node, seen = new Set()) => {
        if (!node) return undefined
        if (
          ast.isParenthesizedExpression(node) ||
          ast.isAsExpression(node) ||
          ast.isNonNullExpression(node) ||
          ast.isSatisfiesExpression(node)
        )
          return tableOf(node.expression, seen)
        if (ast.isPropertyAccessExpression(node) && tables.has(node.name.text))
          return node.name.text
        if (
          ast.isElementAccessExpression(node) &&
          ast.isStringLiteral(node.argumentExpression) &&
          tables.has(node.argumentExpression.text)
        )
          return node.argumentExpression.text
        const s = await symbol(node)
        if (s && !seen.has(s.id)) {
          seen.add(s.id)
          const binding = bindings.get(s.id)
          if (typeof binding === 'string') return binding
          if (binding) return tableOf(binding, seen)
          const target = s.flags & SymbolFlags.Alias ? await checker.getAliasedSymbol(s) : s
          if (tables.has(target.name)) return target.name
        }
        if (!s && ast.isIdentifier(node) && tables.has(node.text)) return node.text
        return undefined
      }
      await visit(source, async (node) => {
        if (ast.isCallExpression(node)) {
          const callee = node.expression
          const method = ast.isPropertyAccessExpression(callee)
            ? callee.name.text
            : ast.isElementAccessExpression(callee) &&
                ast.isStringLiteral(callee.argumentExpression)
              ? callee.argumentExpression.text
              : undefined
          const table = mutations.has(method)
            ? ((await tableOf(node.arguments[0])) ?? (await tableOf(callee.expression)))
            : undefined
          if (table)
            report(
              node.getStart(source),
              `Credit write to ${table}: use packages/credits`,
              source.text,
            )
        }
        let sql
        if (ast.isStringLiteral(node) || ast.isNoSubstitutionTemplateLiteral(node)) sql = node.text
        if (ast.isTemplateExpression(node)) {
          sql = node.head.text
          for (const span of node.templateSpans)
            sql += (tables.get(await tableOf(span.expression)) ?? '__dynamic__') + span.literal.text
        }
        if (sql !== undefined)
          for (const table of sqlWrites(sql))
            report(
              node.getStart(source),
              `Raw SQL write to ${table}: use packages/credits`,
              source.text,
            )
      })
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
  const diagnostics = await checkCreditWrites(root, paths)
  for (const d of diagnostics) console.error(`${d.path}:${d.line}: ${d.message}`)
  if (diagnostics.length) process.exitCode = 1
  else
    console.log(
      `Credit write check passed (${paths.filter((p) => !isExcluded(p) && /\.(?:[cm]?[jt]sx?|sql)$/.test(p)).length} production files)`,
    )
}
