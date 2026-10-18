import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { createProject, verifyProject } from './create-project.mjs'

// 显式运行的端到端自检：真正安装与检查完整副本，避免日常边界测试反复安装依赖。
test('真实副本覆盖 Cloudflare 默认、selfhost 默认和 selfhost 全关组合', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'bootstrap-verify-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const sentinel = [
    'SELFHOST',
    'SENSITIVE',
    process.pid.toString(36),
    Date.now().toString(36),
  ].join('_')
  let selfhostSource
  for (const scenario of [
    { id: 'cf', label: 'Cloudflare 默认', locale: 'en' },
    { id: 'selfhost', label: 'selfhost 默认', target: 'selfhost', locale: 'zh' },
    {
      id: 'minimal',
      label: 'selfhost 全关，从已生成副本再次生成',
      target: 'selfhost',
      locale: 'zh',
      ai: '',
      'billing-enabled': 'false',
      'credits-enabled': 'false',
      marketing: 'false',
      i18n: 'false',
    },
  ]) {
    await t.test(`${scenario.label}：安装、类型、单元测试和 Node 构建通过`, async () => {
      const name = `validation-${scenario.id}-${process.pid.toString(36)}`
      const source = scenario.id === 'minimal' ? selfhostSource : undefined
      if (scenario.id === 'minimal') assert.ok(source, '全关组合必须从已生成的 selfhost 副本创建')
      const sourceName = source
        ? JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).name
        : manifest.name
      if (source) {
        // 哨兵只写临时副本，证明已初始化项目再次生成时不继承真值与运行状态。
        for (const path of [
          'deploy/selfhost/secrets/auth_secret',
          'deploy/selfhost/certs/server/private',
          'deploy/selfhost/ownership/executor.json',
          'deploy/selfhost/backups/base.tar',
          'deploy/selfhost/release-state/current',
          '.env.local',
        ]) {
          await mkdir(dirname(join(source, path)), { recursive: true })
          await writeFile(join(source, path), sentinel)
        }
      }
      const result = await createProject(
        {
          ...scenario,
          name,
          domain: `${name}.example`,
          'image-namespace': `ghcr.io/validation-owner/${name}`,
          output: join(temp, name),
        },
        source,
      )
      if (scenario.id === 'selfhost') selfhostSource = result.target
      let count = 0
      async function inspect(folder) {
        for (const entry of await readdir(folder, { withFileTypes: true })) {
          const path = join(folder, entry.name)
          const projectPath = relative(result.target, path)
          assert.ok(!projectPath.includes(sourceName), `原名称仍存在于路径：${path}`)
          if (entry.isDirectory()) {
            assert.ok(
              ![
                '.git',
                'node_modules',
                '.wrangler',
                'dist',
                '.turbo',
                'coverage',
                '.output',
                '.content-collections',
                'project.inlang',
                'paraglide',
                'image-artifacts',
                'image-set',
                'secrets',
                'certs',
                '.data',
                'job-owners',
              ].includes(entry.name),
              `排除目录仍存在：${path}`,
            )
            if (projectPath.startsWith('deploy/selfhost/'))
              assert.ok(
                ![
                  'ownership',
                  '.ownership',
                  'owners',
                  'backups',
                  'backup-data',
                  'releases',
                  'release-state',
                  'state',
                  '.state',
                ].includes(entry.name),
                `selfhost 运行目录仍存在：${path}`,
              )
            await inspect(path)
          } else {
            assert.ok(!entry.isSymbolicLink())
            const content = await readFile(path)
            if (!content.includes(0)) {
              assert.ok(!content.toString().includes(sourceName), `原名称仍存在：${path}`)
              assert.ok(!content.toString().includes(sentinel), `真值仍存在：${path}`)
            }
            count++
          }
        }
      }
      await inspect(result.target)
      console.log(`已逐文件检查 ${count} 个文件，原名称、真值与排除目录均不存在`)
      if (scenario.target === 'selfhost') {
        assert.match(
          await readFile(join(result.target, 'deploy/selfhost/.env.example'), 'utf8'),
          new RegExp(`^IMAGE_NAMESPACE=ghcr.io/validation-owner/${name}$`, 'm'),
        )
        assert.match(
          await readFile(join(result.target, '.github/workflows/selfhost-publish.yml'), 'utf8'),
          new RegExp(`default: ghcr.io/validation-owner/${name}`),
        )
      }
      if (scenario.id === 'minimal') {
        assert.match(
          result.report,
          /billing=false \/ credits=false \/ marketing=false \/ i18n=false/,
        )
        assert.doesNotMatch(result.report, /billing:seed|STRIPE_SECRET|PAYPAL_CLIENT/)
      }
      verifyProject(result.target, { nodeBuild: true })
    })
  }
})
