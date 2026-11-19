import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

const ROOT = resolve(import.meta.dirname, '..')
const read = (path) => readFileSync(join(ROOT, path), 'utf8')
// 项目级技能；OpenSpec 技能保留各 agent 的调用语法差异，不纳入逐字节一致要求
const skillsIn = (dir) =>
  readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('openspec-'))
    .map((entry) => entry.name)
    .sort()
const SKILLS = skillsIn('.agents/skills')
const skill = (name) => read(`.agents/skills/${name}/SKILL.md`)
// 生成副本（有 .template-base.json）不含 template-only 块与模板维护资料
const derived = existsSync(join(ROOT, '.template-base.json'))
// 项目自有的设计目录按需创建，技能照常写完整路径，不做存在性检查
const ON_DEMAND = /^docs\/design\//

test('两处目录的技能集合相同、逐字节一致，且有 name 与 description', () => {
  assert.deepEqual(skillsIn('.claude/skills'), SKILLS)
  assert.ok(SKILLS.includes('ui-design'))
  for (const name of SKILLS) {
    const codex = readFileSync(join(ROOT, '.agents/skills', name, 'SKILL.md'))
    const claude = readFileSync(join(ROOT, '.claude/skills', name, 'SKILL.md'))
    assert.ok(codex.equals(claude), `${name} 两处内容不一致`)
    const front = codex.toString('utf8').match(/^---\n([\s\S]*?)\n---\n/)
    assert.ok(front, `${name} 缺少 frontmatter`)
    assert.match(front[1], new RegExp(`^name: ${name}$`, 'm'))
    assert.match(front[1], /^description: \S/m)
  }
})

test('技能引用的文档与相对链接在仓库中存在', () => {
  for (const name of SKILLS) {
    const text = skill(name)
    for (const [path] of text.matchAll(/(?<![\w/.-])docs\/[\w./-]+\.md/g)) {
      if (ON_DEMAND.test(path)) continue
      if (derived && path.startsWith('docs/design-system/')) continue
      assert.ok(existsSync(join(ROOT, path)), `${name} 引用不存在的文档：${path}`)
    }
    const dir = join(ROOT, '.agents/skills', name)
    for (const [, link] of text.matchAll(/\]\((\.{1,2}\/[^)#\s]+)/g)) {
      assert.ok(existsSync(resolve(dir, link)), `${name} 链接不存在：${link}`)
    }
  }
})

test('维护说明的一致性核对命令覆盖全部技能', { skip: derived }, () => {
  const doc = read('docs/create-project.md')
  const loop = doc.match(/for skill in ([^;]+); do/)
  assert.ok(loop, 'docs/create-project.md 缺少核对命令')
  assert.deepEqual(loop[1].trim().split(/\s+/).sort(), SKILLS)
  for (const name of SKILLS) assert.match(doc, new RegExp(`\\[${name}\\]\\(`))
})

test('页面技能第 1 步检查原型索引，缺失时转入 ui-design', () => {
  for (const name of ['new-page', 'new-static-page', 'ui-design']) {
    const first = skill(name).split(/\n## 2\./)[0]
    assert.match(first, /\n## 1\. (检查设计稿|判断是否需要设计稿)/, `${name} 第 1 步标题`)
    assert.match(first, /docs\/design\/prototypes\/README\.md/, `${name} 缺少项目原型索引`)
    assert.match(first, /docs\/design-system\/prototypes\/README\.md/, `${name} 缺少模板原型索引`)
    if (name !== 'ui-design') assert.match(first, /转入 `ui-design`/)
  }
})

test('add-ui-design-system 已归档，文档与技能不再写「将由 tasks N.M」', () => {
  if (derived) return
  const sources = [
    'docs/design-system.md',
    ...SKILLS.map((name) => `.agents/skills/${name}/SKILL.md`),
  ]
  for (const path of sources) {
    assert.doesNotMatch(read(path), /将由 tasks [\d.]/, `${path} 仍引用未来任务，请改为现成路径`)
  }
})

test('设计规范文档以仓库为唯一来源、不登记 Artifact 链接，相对链接存在', () => {
  const doc = read('docs/design-system.md')
  assert.match(doc, /唯一规范来源是本仓库/)
  // Artifact 按账号私有，规范文档不登记镜像链接（原型索引中的画布链接只是确认记录）
  assert.doesNotMatch(doc, /claude\.ai\/artifact\//)
  for (const [, link] of doc.matchAll(/\]\((\.{1,2}\/[^)#\s]+)/g)) {
    assert.ok(existsSync(resolve(ROOT, 'docs', link)), `docs/design-system.md 链接不存在：${link}`)
  }
})
