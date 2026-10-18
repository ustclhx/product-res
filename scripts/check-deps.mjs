#!/usr/bin/env node
// 依赖规则见 docs/02-project-structure.md；manifest 与源码均检查。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as ts from 'typescript/unstable/ast'
import { createVirtualFileSystem } from 'typescript/unstable/fs'
import { API } from 'typescript/unstable/sync'

const ROOT = resolve(import.meta.dirname, '..')
const SCOPE = '@product-res/'
const UI_PACKAGE = '@product-res/ui'
const REACT_PACKAGES = new Set([
  'react',
  'react-dom',
  '@types/react',
  '@types/react-dom',
  'react-email',
  UI_PACKAGE,
])
const REACT_SCOPES = ['@react-email/']
const REACT_EXCEPTIONS = {
  '@product-res/email': (dep) => dep !== UI_PACKAGE,
}
const LAYERS = {
  '@product-res/shared': [],
  '@product-res/config': ['@product-res/shared'],
  '@product-res/db': ['@product-res/shared', '@product-res/config'],
  '@product-res/platform': ['@product-res/shared', '@product-res/config', '@product-res/db'],
}
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const BUILD_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.wrangler',
  '.output',
  '.turbo',
  '.git',
])

function readWorkspace(root, dir) {
  const base = join(root, dir)
  if (!existsSync(base)) return []
  return readdirSync(base)
    .map((name) => join(base, name))
    .filter((path) => existsSync(join(path, 'package.json')))
    .map((path) => ({
      path,
      manifest: JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')),
    }))
}

export function sourceFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return BUILD_DIRS.has(name) ? [] : sourceFiles(path)
    return /\.(m|c)?[jt]sx?$/.test(name) ? [path] : []
  })
}

function staticString(node) {
  if (!node) return null
  if (ts.isStringLiteral(node) || node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral)
    return node.text
  if (ts.isParenthesizedExpression(node)) return staticString(node.expression)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left)
    const right = staticString(node.right)
    return left !== null && right !== null ? left + right : null
  }
  return null
}

// AST 忽略注释/普通字符串，保留 type import，且支持空白、转义和 import() 第二参数。
function importsOfSource(source) {
  const imports = []
  function visit(node) {
    let specifierNode
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifierNode = node.moduleSpecifier
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      specifierNode = node.moduleReference.expression
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifierNode = node.argument.literal
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      specifierNode = node.arguments[0]
    }
    const specifier = staticString(specifierNode)
    if (specifier !== null) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
      imports.push({ specifier, line: line + 1 })
    }
    node.forEachChild(visit)
  }
  visit(source)
  return imports
}

function packageNameOf(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
    return null
  }
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

// TS 7 使用 native parser API；虚拟项目只解析传入源码，不加载库或解析依赖。
function parseImports(files) {
  const config = '/check-deps/tsconfig.json'
  const virtual = {
    [config]: JSON.stringify({
      compilerOptions: { noLib: true, noResolve: true, allowJs: true },
      files: Object.keys(files),
    }),
    ...files,
  }
  const api = new API({ cwd: '/check-deps', fs: createVirtualFileSystem(virtual) })
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] })
    try {
      const program = snapshot.getProject(config).program
      return new Map(
        Object.keys(files).map((file) => [file, importsOfSource(program.getSourceFile(file))]),
      )
    } finally {
      snapshot.dispose()
    }
  } finally {
    api.close()
  }
}

export function importsOf(text, file = 'source.ts') {
  const path = resolve('/check-deps', file)
  return parseImports({ [path]: text }).get(path)
}

export function cloudflareAllowed(file, specifier, rules) {
  if (
    file.startsWith('packages/platform/src/cloudflare/') &&
    ['cloudflare:workers', 'cloudflare:workflows'].includes(specifier)
  )
    return true
  if (specifier === 'cloudflare:workers') {
    if (rules.compositionEntries.includes(file)) return true
  }
  return rules.targetFixtures[file]?.includes(specifier) === true
}

function platformTargetOf(root, file, specifier) {
  const named = /^@product-res\/platform\/(cloudflare|node)(?:\/|$)/.exec(specifier)
  if (named) return named[1]
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null
  const target = relative(root, resolve(join(file, '..'), specifier))
    .split(sep)
    .join('/')
  return (
    /^packages\/platform\/src\/(cloudflare|node)(?:\/|(?:\.[cm]?[jt]sx?)?$)/.exec(target)?.[1] ??
    null
  )
}

function platformTargetAllowed(file, target, rules) {
  if (file.startsWith(`packages/platform/src/${target}/`)) return true
  const entries =
    target === 'cloudflare' ? rules.compositionEntries : (rules.nodeCompositionEntries ?? [])
  if (entries.includes(file)) return true
  if (rules.targetAdapterFixtures?.[file]?.includes(target)) return true
  return (
    target === 'cloudflare' &&
    rules.targetFixtures[file]?.some((specifier) => specifier.startsWith('cloudflare:')) === true
  )
}

export function checkWorkspace(
  root = ROOT,
  rules = JSON.parse(readFileSync(join(ROOT, 'scripts/check-deps.rules.json'), 'utf8')),
) {
  const apps = readWorkspace(root, 'apps')
  const packages = readWorkspace(root, 'packages')
  const appNames = new Set(apps.map((a) => a.manifest.name))
  const violations = []

  function checkDependency(pkgName, dep, where) {
    if (appNames.has(dep)) {
      violations.push(`${pkgName} → ${dep}（${where}）：packages 不得依赖 apps`)
    }
    const isReact = REACT_PACKAGES.has(dep) || REACT_SCOPES.some((scope) => dep.startsWith(scope))
    if (isReact && pkgName !== UI_PACKAGE && REACT_EXCEPTIONS[pkgName]?.(dep) !== true) {
      violations.push(
        `${pkgName} → ${dep}（${where}）：React 仅允许 ui，email 仅允许 React / React Email，不能依赖 ui`,
      )
    }
    const allowed = LAYERS[pkgName]
    if (allowed && dep.startsWith(SCOPE) && dep !== pkgName && !allowed.includes(dep)) {
      const rule = allowed.length > 0 ? `只允许依赖 ${allowed.join('、')}` : '不得依赖其他内部包'
      violations.push(`${pkgName} → ${dep}（${where}）：${pkgName} ${rule}`)
    }
  }

  for (const { manifest } of packages) {
    for (const field of DEP_FIELDS) {
      for (const dep of Object.keys(manifest[field] ?? {})) {
        checkDependency(manifest.name, dep, `package.json ${field}`)
      }
    }
  }
  const files = Object.fromEntries(
    [...packages, ...apps].flatMap(({ path }) =>
      sourceFiles(path).map((file) => [file, readFileSync(file, 'utf8')]),
    ),
  )
  const parsed = parseImports(files)
  for (const { path, manifest } of [...packages, ...apps]) {
    const isPackage = packages.some((pkg) => pkg.path === path)
    for (const file of sourceFiles(path)) {
      const rel = relative(root, file).split(sep).join('/')
      for (const { specifier, line } of parsed.get(file)) {
        const where = `${rel}:${line}`
        if (specifier.startsWith('cloudflare:')) {
          if (cloudflareAllowed(rel, specifier, rules)) continue
          violations.push(
            `${where} → ${specifier}：仅允许平台 Cloudflare 适配器、显式 composition entry 与目标测试夹具`,
          )
          continue
        }
        const platformTarget = platformTargetOf(root, file, specifier)
        if (platformTarget && !platformTargetAllowed(rel, platformTarget, rules)) {
          violations.push(
            `${where} → ${specifier}：业务仅可依赖 platform 中立入口；${platformTarget} 适配器仅允许对应目标目录、显式 composition entry 与目标测试夹具`,
          )
        }
        // 既有包依赖规则只约束生产 src；测试的 React/应用夹具不属于业务依赖。
        if (!isPackage || !file.startsWith(join(path, 'src') + sep)) continue
        if (specifier.startsWith('.')) {
          const target = resolve(join(file, '..'), specifier)
          if (target.startsWith(join(root, 'apps') + sep)) {
            violations.push(
              `${manifest.name} → ${specifier}（${where}）：packages 不得引用 apps 下的文件`,
            )
          } else {
            const targetPackage = packages.find(
              (pkg) => target === pkg.path || target.startsWith(pkg.path + sep),
            )
            if (targetPackage && targetPackage.path !== path) {
              checkDependency(manifest.name, targetPackage.manifest.name, where)
            }
          }
          continue
        }
        const dep = packageNameOf(specifier)
        if (dep) checkDependency(manifest.name, dep, where)
      }
    }
  }
  return { violations, packages: packages.length, apps: apps.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = checkWorkspace()
  if (result.violations.length > 0) {
    console.error(`依赖方向检查失败（${result.violations.length} 处）：`)
    for (const violation of result.violations) console.error(`  - ${violation}`)
    process.exitCode = 1
  } else {
    console.log(`依赖方向检查通过：${result.packages} 个包，${result.apps} 个应用`)
  }
}
