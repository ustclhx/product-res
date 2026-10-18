#!/usr/bin/env node
// 单实例检查：下列包在整个 monorepo 中只能解析为一个实例（pnpm-lock.yaml 的 snapshots 中只有一条）。
//
// 背景：pnpm 会为「同一版本 + 不同的已解析 peer 依赖组合」各建一个实例。drizzle-orm 声明了大量可选 peer
// （kysely、postgres、@cloudflare/workers-types 等），只要某个依赖方能看到额外的 peer（例如 better-auth
// 带入 kysely），就会多出一个实例；增量 `pnpm add` 不会重新解析已有依赖方，旧实例因此保留下来。
// 两个实例的类（含私有字段）在 TypeScript 中互不兼容，运行时 instanceof 也会失效。
// 修复方式：`pnpm dedupe`（CI 另跑 `pnpm dedupe --check`）。用法：node scripts/check-singletons.mjs [lockfile]

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SINGLETONS = ['drizzle-orm', 'react', 'react-dom']

const lockfile = resolve(process.argv[2] ?? resolve(import.meta.dirname, '..', 'pnpm-lock.yaml'))
const lines = readFileSync(lockfile, 'utf8').split('\n')

// 取 snapshots: 段内的顶层键（两个空格缩进），形如 `  drizzle-orm@0.45.3(peer@x)(peer@y):`
// pnpm 12 的 lockfile 是多文档 YAML：第一个文档描述 pnpm 自身的环境，`---` 之后才是项目依赖，因此取最后一个 snapshots 段。
const start = lines.lastIndexOf('snapshots:')
if (start < 0) {
  console.error(`单实例检查失败：${lockfile} 中没有 snapshots 段`)
  process.exit(1)
}
const keys = []
for (const line of lines.slice(start + 1)) {
  if (/^\S/.test(line)) break
  const m = /^ {2}'?([^\s'][^']*?)'?:/.exec(line)
  if (m) keys.push(m[1])
}

const violations = []
for (const name of SINGLETONS) {
  const instances = keys.filter(
    (k) => k.startsWith(`${name}@`) && /^\d/.test(k.slice(name.length + 1)),
  )
  if (instances.length > 1) violations.push({ name, instances })
}

if (violations.length > 0) {
  console.error('单实例检查失败：以下包解析出了多个实例（运行 pnpm dedupe 后重试）：')
  for (const { name, instances } of violations) {
    console.error(`  - ${name}（${instances.length} 个）`)
    for (const i of instances) console.error(`      ${i}`)
  }
  process.exit(1)
}
console.log(`单实例检查通过：${SINGLETONS.join('、')} 各只有一个实例`)
