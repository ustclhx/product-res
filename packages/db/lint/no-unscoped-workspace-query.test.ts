import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '../src/schema/index.ts'
import { workspaceColumnOf } from '../src/scoped.ts'

// tasks.md 4.3：禁止绕过 scoped() 的 lint 规则（Biome GritQL 插件）。
// 1. 插件中的表清单与 schema 一致（新增空间表时忘记补上会失败）；
// 2. 用根目录 biome.json 的插件配置（含 includes）检查夹具：违规代码被拦下，scoped 写法不被误报。

const root = resolve(import.meta.dirname, '../../..')
const pluginPath = resolve(import.meta.dirname, 'no-unscoped-workspace-query.grit')
const fixtures = resolve(import.meta.dirname, 'fixtures')
const biomeBin = createRequire(join(root, 'package.json')).resolve('@biomejs/biome/bin/biome')

type Diagnostic = { category: string; location: { path: string; start: { line: number } } }

function workspaceTablesInSchema(): string[] {
  return Object.entries(schema)
    .filter(([, value]) => is(value, PgTable) && workspaceColumnOf(value) !== undefined)
    .map(([name]) => name)
    .sort()
}

function workspaceTablesInPlugin(): string[] {
  const source = readFileSync(pluginPath, 'utf8')
  const body = /pattern workspace_table\(\) \{\s*or \{([^}]*)\}/.exec(source)?.[1]
  if (!body) throw new Error('workspace_table() pattern not found in plugin')
  return [...body.matchAll(/`(\w+)`/g)].map((m) => m[1] as string).sort()
}

describe('no-unscoped-workspace-query 插件', () => {
  it('表清单覆盖 schema 中所有带空间列的表', () => {
    const tables = workspaceTablesInSchema()
    expect(tables).toEqual(expect.arrayContaining(['auditLog', 'invitation', 'member']))
    expect(workspaceTablesInPlugin()).toEqual(tables)
  })

  describe('按根目录 biome.json 的插件配置检查夹具', () => {
    let dir: string

    /** 夹具放到临时目录的 relPath 下，用与根配置相同的插件设置运行 Biome，返回插件诊断。 */
    function lint(fixture: string, relPath: string): Diagnostic[] {
      const target = join(dir, relPath)
      mkdirSync(join(target, '..'), { recursive: true })
      cpSync(join(fixtures, fixture), target)
      let output: string
      try {
        output = execFileSync(process.execPath, [biomeBin, 'lint', '--reporter=json', relPath], {
          cwd: dir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        // 有错误级诊断时 Biome 以非零码退出，JSON 仍在 stdout
        output = (error as { stdout: string }).stdout
      }
      const report = JSON.parse(output) as { diagnostics: Diagnostic[] }
      return report.diagnostics.filter((d) => d.category === 'plugin')
    }

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'product-res-lint-'))
      const config = JSON.parse(readFileSync(join(root, 'biome.json'), 'utf8'))
      const plugin = config.plugins.find((p: { path: string }) => p.path.endsWith('.grit'))
      writeFileSync(
        join(dir, 'biome.json'),
        JSON.stringify({
          root: true,
          vcs: { enabled: false },
          linter: config.linter,
          plugins: [{ ...plugin, path: pluginPath }],
        }),
      )
    })

    afterAll(() => rmSync(dir, { recursive: true, force: true }))

    it('features 中的违规写法全部被拦下，豁免注释生效', () => {
      const expected = readFileSync(join(fixtures, 'violations.ts'), 'utf8')
        .split('\n')
        .flatMap((line, i) => (line.includes('// expect-lint') ? [i + 1] : []))
      expect(expected.length).toBeGreaterThanOrEqual(7)
      const lines = lint('violations.ts', 'apps/web/src/features/tasks/server.ts').map(
        (d) => d.location.start.line,
      )
      expect(lines).toEqual(expected)
    })

    it('jobs 的业务代码同样受检查，测试文件与其他目录不受检查', () => {
      expect(lint('violations.ts', 'apps/jobs/src/cron/sweep.ts').length).toBeGreaterThan(0)
      expect(lint('violations.ts', 'apps/jobs/src/cron/sweep.test.ts')).toEqual([])
      expect(lint('violations.ts', 'packages/credits/src/hold.ts')).toEqual([])
    })

    it('通过 scoped() 的写法不被误报', () => {
      expect(lint('scoped-usage.ts', 'apps/web/src/features/tasks/ok.ts')).toEqual([])
    })
  })
})
