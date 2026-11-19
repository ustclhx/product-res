#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
export const COMPONENT_LOCK = 'packages/ui/components.lock.json'
export const CUSTOMIZATION_ORDER =
  '请按 token → ui 配置 → project 包装 → 复制到 project 并登记 docs/design/forks.md 的顺序定制；复制后如需保留 arbitrary-class 等例外，请在 scripts/check-ui.allow.local.json 按文件登记规则与原因'

export function componentHashes(root = ROOT) {
  const ui = join(root, 'packages/ui')
  function walk(dir) {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name.startsWith('.')) return []
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return walk(path)
      return entry.isFile() && /\.(?:ts|tsx|css)$/.test(entry.name) ? [path] : []
    })
  }
  const tracked = spawnSync('git', ['ls-files', '-z', '--', 'packages/ui/src/components'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const files =
    tracked.status === 0
      ? tracked.stdout
          .split('\0')
          .filter(Boolean)
          .map((file) => join(root, file))
          .filter(existsSync)
      : walk(join(ui, 'src/components'))
  return Object.fromEntries(
    files
      .map((file) => relative(ui, file).split(sep).join('/'))
      .sort()
      .map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(join(ui, file)))
          .digest('hex'),
      ]),
  )
}

export function componentLockViolations(root = ROOT) {
  const path = join(root, COMPONENT_LOCK)
  const actual = componentHashes(root)
  const expected = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  const changed = [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
    .sort()
    .filter((file) => expected[file] !== actual[file])
  if (!existsSync(path)) changed.push('components.lock.json')
  const message = existsSync(join(root, '.template-base.json'))
    ? `衍生项目不得修改模板组件或指纹清单。${CUSTOMIZATION_ORDER}`
    : '模板组件指纹清单已过期，请运行 pnpm ui:lock 并提交清单'
  return changed.map((file) => ({
    file: `packages/ui/${file}`,
    line: 1,
    column: 1,
    rule: 'component-lock',
    value: message,
  }))
}

export function writeComponentLock(root = ROOT) {
  if (existsSync(join(root, '.template-base.json'))) {
    throw new Error(`组件指纹清单由模板维护。${CUSTOMIZATION_ORDER}`)
  }
  const hashes = componentHashes(root)
  writeFileSync(join(root, COMPONENT_LOCK), `${JSON.stringify(hashes, null, 2)}\n`)
  return Object.keys(hashes).length
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(`已更新组件指纹清单：${writeComponentLock()} 个文件`)
}
