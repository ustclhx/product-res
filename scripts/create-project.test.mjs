import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { createProject, projectOptions } from './create-project.mjs'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bootstrap-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const source = join(dir, 'source')
  async function file(path, content) {
    await mkdir(dirname(join(source, path)), { recursive: true })
    await writeFile(join(source, path), content)
  }
  await file('package.json', JSON.stringify({ name: 'fixture-template' }))
  await file('packages/config/package.json', JSON.stringify({ name: '@fixture/config' }))
  await file(
    'template.config.ts',
    `export default defineTemplateConfig({
    app: { name: 'FixtureApp', url: 'https://fixture.example', supportEmail: 'support@fixture.example' },
    i18n: { locales: ['en', 'zh'], defaultLocale: 'en' },
    tenancy: { multiTenant: false }, auth: { oauth: ['google'], turnstile: true },
    billing: { providers: ['stripe'] }, ai: { text: { enabled: true, thinking: { default: 'off', userToggle: false }, reasoning: { display: false }, failedReplyRefund: 'no-visible-output' }, image: true, video: true, mediaProviders: ['fal', 'workers-ai'] },
    features: { blog: true },
  })`,
  )
  for (const app of ['web', 'jobs']) {
    await file(`apps/${app}/package.json`, JSON.stringify({ name: `@fixture/${app}` }))
    await file(
      `apps/${app}/wrangler.jsonc`,
      JSON.stringify({
        name: app,
        ai: { binding: 'AI' },
        r2_buckets: [{ binding: 'FILES', bucket_name: 'files' }],
        vars: { R2_FILES_BUCKET: 'files', PAYMENT_MODE: 'test' },
        hyperdrive: [{ binding: 'HYPERDRIVE', id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
        workflows: [{ name: 'ai-media', script_name: 'jobs' }],
        queues: { producers: [{ queue: 'email' }] },
        env: {
          staging: {
            name: `${app}-staging`,
            ai: { binding: 'AI' },
            r2_buckets: [{ binding: 'FILES', bucket_name: 'files-staging' }],
            vars: {
              APP_URL: 'https://old.workers.dev',
              PAYMENT_MODE: 'test',
              R2_FILES_BUCKET: 'files-staging',
              R2_ACCOUNT_ID: 'template-account',
              AI_GATEWAY_ACCOUNT_ID: 'template-account',
              AI_GATEWAY_ID: 'template-gateway',
            },
          },
          production: {
            name: `${app}-production`,
            routes: [{ pattern: 'app.template.example', custom_domain: true }],
            r2_buckets: [{ binding: 'FILES', bucket_name: 'files-production' }],
            hyperdrive: [{ binding: 'HYPERDRIVE', id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }],
            queues: { producers: [{ queue: 'email-production' }] },
            vars: {
              APP_URL: 'https://app.template.example',
              TURNSTILE_SITE_KEY: '0x4AAAAAAATemplateSiteKey',
              R2_FILES_BUCKET: 'files-production',
              R2_ACCOUNT_ID: 'template-account',
            },
          },
        },
      }),
    )
  }
  await file(
    'apps/jobs/src/index.ts',
    "const EMAIL_QUEUES = new Set(['email', 'email-staging'])\nconst EVENTS_QUEUES = new Set(['events', 'events-staging'])",
  )
  await file(
    'apps/jobs/test/queues.test.ts',
    "const queues = ['email', 'events-staging']; const lifecycle = ['queue.register:email']",
  )
  await file('apps/jobs/src/handlers.ts', "const queues = ['email', 'events-staging']")
  await file('apps/jobs/src/node/runtime.ts', "queues.register('email', consume)")
  await file('apps/web/src/node/runtime.ts', "createNodeQueueProducer(db, 'events')")
  await file(
    '.github/workflows/deploy-staging.yml',
    'env:\n  STAGING_URL: https://old.workers.dev\n',
  )
  await file(
    'scripts/staging/files-cors.json',
    '{"origins":["https://web-staging.old.workers.dev"]}',
  )
  return {
    dir,
    source,
    file,
    input: { name: 'acme', domain: 'acme.example', output: join(dir, 'acme') },
  }
}

async function files(path) {
  const entries = await readdir(path, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)],
      ),
    )
  ).flat()
}

test('生成副本改名与配置，排除各级密钥、链接和产物', async (t) => {
  const f = await fixture(t)
  for (const path of [
    '.git/config',
    '.dev.vars',
    '.dev.vars.staging',
    '.env.local',
    '.env.worktree',
    'image-artifacts/web.tar',
    'image-set/image-set.json',
    'secrets/auth_secret',
    'certs/server/private',
    '.data/job-owners/executor.json',
    'apps/jobs/.data/job-owners/executor.json',
    'apps/jobs/job-owners/executor.json',
    'apps/web/.dev.vars',
    'apps/jobs/.env.production',
    'node_modules/secret',
    '.wrangler/state/data',
    'apps/web/dist/out',
    '.turbo/cache',
    'coverage/out',
    'openspec/changes/pending/tasks.md',
    'release-bundle/release.json',
    'deploy/selfhost/release/__pycache__/bundle.cpython-312.pyc',
    'selfhost-release-fixture.tar.gz',
    'scripts/probes/x/results/config.json',
  ]) {
    await f.file(path, 'SENSITIVE_SENTINEL')
    await chmod(join(f.source, path), 0o000)
  }
  await f.file(
    'docs/fixture-template.md',
    'fixture-template FixtureApp @fixture/config fixture_dev',
  )
  await f.file('assets/icon.bin', Buffer.from([255, 216, 255]))
  await f.file('infra/.env.example', 'PASSWORD=\n')
  const external = join(f.dir, 'secret.txt')
  await writeFile(external, 'SENSITIVE_SENTINEL')
  await symlink(external, join(f.source, 'linked-secret'))
  const result = await createProject(
    {
      ...f.input,
      locale: 'zh',
      ai: 'text',
      features: 'waitlist,newsletter',
      billing: '',
      oauth: '',
      turnstile: 'false',
    },
    f.source,
  )
  const generated = await files(result.target)
  for (const path of generated) {
    assert.doesNotMatch(path, /fixture-template/)
    const content = await readFile(path)
    if (!content.includes(0)) {
      assert.doesNotMatch(
        content.toString(),
        /fixture-template|FixtureApp|@fixture\/|SENSITIVE_SENTINEL/,
      )
    }
  }
  assert.deepEqual(
    await readFile(join(result.target, 'assets/icon.bin')),
    Buffer.from([255, 216, 255]),
  )
  const config = await readFile(join(result.target, 'template.config.ts'), 'utf8')
  assert.match(config, /defaultLocale: 'zh'/)
  assert.match(config, /image: false/)
  assert.match(config, /"waitlist":true/)
  const wrangler = JSON.parse(
    await readFile(join(result.target, 'apps/web/wrangler.jsonc'), 'utf8'),
  )
  assert.equal(wrangler.name, 'acme-web')
  assert.equal(wrangler.hyperdrive[0].id, '00000000000000000000000000000000')
  assert.equal(wrangler.env.staging.vars.APP_URL, 'https://acme.example')
  assert.equal(wrangler.vars.PAYMENT_MODE, 'test')
  assert.equal(wrangler.env.staging.vars.PAYMENT_MODE, 'test')
  // 生成副本可带 production 环境块，但不得预置支付模式（payment-mode：缺省即关闭支付，live 需另行配置）
  assert.equal(wrangler.env.production.vars.PAYMENT_MODE, undefined)
  assert.equal(wrangler.workflows, undefined)
  assert.equal(wrangler.ai, undefined)
  assert.equal(wrangler.env.staging.ai, undefined)
  for (const [env, bucket] of [
    [wrangler, 'acme-files'],
    [wrangler.env.staging, 'acme-files-staging'],
  ]) {
    assert.equal(env.r2_buckets[0].bucket_name, bucket)
    assert.equal(env.vars.R2_FILES_BUCKET, bucket)
  }
  for (const key of ['R2_ACCOUNT_ID', 'AI_GATEWAY_ACCOUNT_ID', 'AI_GATEWAY_ID']) {
    assert.equal(wrangler.env.staging.vars[key], '')
  }
  assert.match(result.report, /R2：FILES 私有桶 acme-files/)
  assert.match(result.report, /SENTRY_DSN/)
  assert.match(result.report, /SENTRY_AUTH_TOKEN/)
  assert.match(result.report, /RL_API/)
  assert.match(result.report, /BOOTSTRAP_ADMIN_EMAILS（可选，仅 web/)
  assert.match(result.report, /已验证且未封禁才提升/)
  assert.match(result.report, /移除名单不会自动撤销/)
  assert.match(result.report, /admin\/billing\/plans/)
  assert.match(
    await readFile(join(result.target, 'apps/web/.dev.vars.example'), 'utf8'),
    /^BOOTSTRAP_ADMIN_EMAILS=$/m,
  )
  assert.doesNotMatch(result.report, /R2_SECRET_ACCESS_KEY/)
  const worker = await readFile(join(result.target, 'apps/jobs/src/index.ts'), 'utf8')
  assert.match(worker, /new Set\(\['acme-email', 'acme-email-staging'\]\)/)
  assert.match(worker, /new Set\(\['acme-events', 'acme-events-staging'\]\)/)
  const queueFixtures = await readFile(join(result.target, 'apps/jobs/test/queues.test.ts'), 'utf8')
  assert.match(queueFixtures, /\['acme-email', 'acme-events-staging'\]/)
  assert.match(queueFixtures, /\['queue.register:acme-email'\]/)
  assert.match(
    await readFile(join(result.target, 'apps/jobs/src/handlers.ts'), 'utf8'),
    /\['acme-email', 'acme-events-staging'\]/,
  )
  assert.match(
    await readFile(join(result.target, 'apps/jobs/src/node/runtime.ts'), 'utf8'),
    /queues.register\('acme-email'/,
  )
  assert.match(
    await readFile(join(result.target, 'apps/web/src/node/runtime.ts'), 'utf8'),
    /createNodeQueueProducer\(db, 'acme-events'\)/,
  )
  const ci = await readFile(join(result.target, '.github/workflows/deploy-staging.yml'), 'utf8')
  assert.match(ci, /STAGING_URL: https:\/\/configure-staging-url\.invalid/)
  assert.doesNotMatch(ci, /old\.workers\.dev/)
  assert.equal(
    JSON.parse(await readFile(join(result.target, 'scripts/staging/files-cors.json'), 'utf8'))
      .origins[0],
    'https://acme.example',
  )
  assert.doesNotMatch(result.report, /FAL_KEY|Workflow：|STRIPE_SECRET|GOOGLE_CLIENT/)
  const example = await readFile(join(result.target, '.dev.vars.example'), 'utf8')
  for (const line of example.split('\n').filter((line) => line && !line.startsWith('#'))) {
    if (line.startsWith('APP_URL=')) assert.equal(line, 'APP_URL=https://acme.example')
    else if (line.startsWith('PAYMENT_MODE=')) assert.equal(line, 'PAYMENT_MODE=test')
    else assert.match(line, /^[A-Z_]+=$/)
  }
  assert.match(example, /SENTRY_DSN=\n/)
  assert.match(result.report, /PAYMENT_MODE/)
  assert.match(result.report, /营销页面已启用，\/ 为营销首页/)
  assert.match(result.report, /多语言已启用，默认语言 zh/)
  assert.match(example, /^PAYMENT_MODE=test$/m)
  assert.doesNotMatch(
    example,
    /SENTRY_AUTH_TOKEN|SENTRY_ORG|SENTRY_PROJECT|STAGING_MIGRATION_DATABASE_URL/,
  )
  // 生成的模板也可以继续作为源，不依赖未加引号的对象键。
  await createProject({ ...f.input, name: 'next', output: join(f.dir, 'next') }, result.target)
})

test('媒体功能与支付开启时，清单和 Worker 引用同步生成', async (t) => {
  const f = await fixture(t)
  const result = await createProject(f.input, f.source)
  const wrangler = JSON.parse(
    await readFile(join(result.target, 'apps/web/wrangler.jsonc'), 'utf8'),
  )
  assert.equal(wrangler.workflows[0].name, 'acme-ai-media')
  assert.equal(wrangler.workflows[0].script_name, 'acme-jobs')
  assert.match(result.report, /FAL_KEY/)
  assert.match(result.report, /R2_SECRET_ACCESS_KEY/)
  assert.match(result.report, /STRIPE_WEBHOOK_SECRET/)
  assert.doesNotMatch(result.report, /PAYPAL_ENV/)
  assert.match(result.report, /GOOGLE_CLIENT_SECRET/)
})

test('拒绝覆盖、源树递归复制、非法名称和无效功能输入', async (t) => {
  const f = await fixture(t)
  await assert.rejects(createProject({ ...f.input, output: f.source }, f.source), /模板目录内/)
  await assert.rejects(
    createProject({ ...f.input, output: join(f.source, 'child') }, f.source),
    /模板目录内/,
  )
  await assert.rejects(
    createProject({ ...f.input, output: join(f.source, '..hidden') }, f.source),
    /模板目录内/,
  )
  assert.equal(
    projectOptions({ ...f.input, output: undefined }).output,
    resolve('..', f.input.name),
  )
  await mkdir(f.input.output)
  await assert.rejects(createProject(f.input, f.source), /目标已存在/)
  assert.throws(() => projectOptions({ ...f.input, name: '../escape' }), /名称/)
  assert.throws(() => projectOptions({ ...f.input, domain: 'acme.example/path' }), /域名/)
  assert.throws(() => projectOptions({ ...f.input, features: 'unknown' }), /features/)
  assert.throws(
    () => projectOptions({ ...f.input, 'media-providers': 'unknown' }),
    /media-providers/,
  )
  assert.throws(
    () => projectOptions({ ...f.input, 'media-providers': 'fal,fal' }),
    /media-providers/,
  )
  const result = spawnSync(process.execPath, ['scripts/create-project', '--name', 'acme'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    input: '',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /非交互模式/)
})

for (const providers of ['fal', 'workers-ai', '']) {
  test(`媒体服务商 ${providers || 'empty'} 的配置、密钥和所有环境绑定一致`, async (t) => {
    const f = await fixture(t)
    const result = await createProject({ ...f.input, 'media-providers': providers }, f.source)
    const config = await readFile(join(result.target, 'template.config.ts'), 'utf8')
    const list = providers ? providers.split(',') : []
    assert.ok(config.includes(`mediaProviders: ${JSON.stringify(list)}`))
    const example = await readFile(join(result.target, '.dev.vars.example'), 'utf8')
    assert.equal(example.includes('FAL_KEY='), list.includes('fal'))
    assert.equal(example.includes('MEDIA_WEBHOOK_SECRET='), list.includes('fal'))
    assert.equal(result.report.includes('fal.ai 账号'), list.includes('fal'))
    assert.equal(result.report.includes('Workers AI：'), list.includes('workers-ai'))
    assert.doesNotMatch(example, /(?:^|\n)AI=/)
    for (const app of ['web', 'jobs']) {
      const wrangler = JSON.parse(
        await readFile(join(result.target, 'apps', app, 'wrangler.jsonc'), 'utf8'),
      )
      for (const env of [wrangler, wrangler.env.staging]) {
        assert.deepEqual(env.ai, list.includes('workers-ai') ? { binding: 'AI' } : undefined)
      }
    }
  })
}

test('文件桶签名白名单与生成项目的桶名一致，备份桶名不受影响', async (t) => {
  const f = await fixture(t)
  await f.file(
    'packages/storage/src/cloudflare/presign.ts',
    "if (!['files', 'files-staging', 'files-production'].includes(bucket)) throw new Error('no')\n",
  )
  await f.file(
    'packages/storage/test/presign.unit.test.ts',
    "const env = { R2_FILES_BUCKET: 'files-staging' }\nexpect(path).toBe(`/files-staging/${key}`)\nconst denied = 'product-res-production-backups'\n",
  )
  const result = await createProject(f.input, f.source)
  const source = await readFile(
    join(result.target, 'packages/storage/src/cloudflare/presign.ts'),
    'utf8',
  )
  assert.match(source, /\['acme-files', 'acme-files-staging', 'acme-files-production'\]/)
  const spec = await readFile(
    join(result.target, 'packages/storage/test/presign.unit.test.ts'),
    'utf8',
  )
  assert.match(spec, /R2_FILES_BUCKET: 'acme-files-staging'/)
  assert.match(spec, /`\/acme-files-staging\/\$\{key\}`/)
  assert.match(spec, /'product-res-production-backups'/)
})

test('模板 production 环境改名、清空 ID 并替换自定义域名', async (t) => {
  const f = await fixture(t)
  const result = await createProject(f.input, f.source)
  const name = JSON.parse(
    await readFile(join(result.target, 'apps/web/wrangler.jsonc'), 'utf8'),
  ).name.replace(/-web$/, '')
  for (const app of ['web', 'jobs']) {
    const production = JSON.parse(
      await readFile(join(result.target, 'apps', app, 'wrangler.jsonc'), 'utf8'),
    ).env.production
    assert.equal(production.name, `${name}-${app}-production`)
    assert.equal(production.r2_buckets[0].bucket_name, `${name}-files-production`)
    assert.equal(production.vars.R2_FILES_BUCKET, `${name}-files-production`)
    assert.equal(production.queues.producers[0].queue, `${name}-email-production`)
    assert.equal(production.hyperdrive[0].id, '0'.repeat(32))
    assert.equal(production.vars.R2_ACCOUNT_ID, '')
    assert.deepEqual(production.routes, [
      { pattern: 'configure-production-domain.invalid', custom_domain: true },
    ])
    assert.notEqual(production.vars.APP_URL, 'https://app.template.example')
    assert.equal(production.vars.TURNSTILE_SITE_KEY, '')
  }
})

// 新名称含源 scope 前缀时，插入的资源名也不能再经过全局替换。
test('项目名包含旧 scope 前缀时资源只改名一次', async (t) => {
  const f = await fixture(t)
  const result = await createProject({ ...f.input, name: 'fixture-smoke' }, f.source)
  const config = JSON.parse(await readFile(join(result.target, 'apps/web/wrangler.jsonc'), 'utf8'))
  assert.equal(config.name, 'fixture-smoke-web')
  assert.equal(config.r2_buckets[0].bucket_name, 'fixture-smoke-files')
  assert.equal(config.queues.producers[0].queue, 'fixture-smoke-email')
  const worker = await readFile(join(result.target, 'apps/jobs/src/index.ts'), 'utf8')
  assert.match(worker, /'fixture-smoke-email-staging'/)
  assert.doesNotMatch(worker, /fixture-smoke-smoke/)
})

test('文本对象开关按 ai 列表裁剪并保留 reasoning 策略', async (t) => {
  for (const ai of ['', 'text']) {
    const f = await fixture(t)
    const result = await createProject({ ...f.input, ai }, f.source)
    const config = await readFile(join(result.target, 'template.config.ts'), 'utf8')
    assert.match(config, new RegExp(`text: \\{ enabled: ${ai === 'text'}`))
    assert.match(config, /thinking: \{ default: 'off', userToggle: false \}/)
    assert.match(config, /failedReplyRefund: 'no-visible-output'/)
  }
})

test('部署目标默认为 Cloudflare，拒绝旧路径并提示 output，参数依赖明确', async (t) => {
  const f = await fixture(t)
  assert.equal(projectOptions(f.input).target, 'cloudflare')
  assert.throws(() => projectOptions({ ...f.input, target: '../old' }), /--output/)
  assert.throws(() => projectOptions({ ...f.input, target: 'unknown' }), /cloudflare 或 selfhost/)
  assert.throws(
    () => projectOptions({ ...f.input, 'image-namespace': 'registry.example/team/project' }),
    /当前发布 CI/,
  )
  assert.throws(
    () => projectOptions({ ...f.input, 'image-namespace': 'ghcr.io/Owner/project' }),
    /小写/,
  )
  assert.throws(() => projectOptions({ ...f.input, 'billing-enabled': 'false' }), /关闭 AI/)
  assert.throws(
    () => projectOptions({ ...f.input, 'credits-enabled': 'false' }),
    /必须启用 credits/,
  )
  assert.equal(
    projectOptions({ ...f.input, ai: '', 'billing-enabled': 'false' }).creditsEnabled,
    true,
  )
})

test('selfhost 继承发布和运维材料，排除真值，并再次生成 namespace', async (t) => {
  const f = await fixture(t)
  await f.file(
    'deploy/selfhost/.env.example',
    'COMPOSE_PROJECT_NAME=fixture-selfhost\nIMAGE_NAMESPACE=ghcr.io/old/fixture\nWEB_IMAGE=fixture-selfhost/web:old\nAPP_URL=https://old.example\nAPP_DOMAIN=old.example\n',
  )
  await f.file('deploy/selfhost/secrets.example', '# 每个 secret 一个文件\n')
  for (const name of ['deploy.sh', 'init-server.sh', 'restore.sh', 'restore-drill.sh']) {
    await f.file(`deploy/selfhost/${name}`, '#!/bin/sh\n# owner 的交付脚本\n')
  }
  await f.file(
    'deploy/selfhost/compose.yaml',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose 插值必须保留字面量。
    'name: ${COMPOSE_PROJECT_NAME:-fixture-selfhost}\nx-app-env:\n  GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID:?required}\n  GOOGLE_CLIENT_SECRET_FILE: /run/secrets/google_client_secret\n  TURNSTILE_SECRET_KEY_FILE: /run/secrets/turnstile_secret\nx-app-secrets:\n  - google_client_secret\n  - turnstile_secret\nservices:\n  web:\n    image: ${WEB_IMAGE}\nsecrets:\n  google_client_secret: {file: secrets/google_client_secret}\n  turnstile_secret: {file: secrets/turnstile_secret}\n',
  )
  await f.file(
    '.github/workflows/selfhost-publish.yml',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 保留 GitHub Actions 运行时输入。
    'on:\n  workflow_dispatch:\n    inputs:\n      namespace:\n        required: true\n        type: string\nenv:\n  IMAGE_NAMESPACE: ${{ inputs.namespace }}\n',
  )
  await f.file('.github/workflows/selfhost-images.yml', 'permissions: { contents: read }\n')
  await f.file(
    'deploy/selfhost/images/catalog.json',
    JSON.stringify({ pendingServices: ['backup'], services: [{ name: 'web' }] }),
  )
  await f.file(
    'template.config.ts',
    (await readFile(join(f.source, 'template.config.ts'), 'utf8'))
      .replace(
        "thinking: { default: 'off', userToggle: false }",
        "thinking: { default: 'on', userToggle: true }",
      )
      .replace('reasoning: { display: false }', 'reasoning: { display: true }')
      .replace("failedReplyRefund: 'no-visible-output'", "failedReplyRefund: 'all'"),
  )
  for (const path of [
    'secrets/auth_secret',
    'secrets/app_database_url',
    'certs/caddy/private',
    'ownership/executor.json',
    'backups/base.tar',
    'releases/current/manifest.json',
    'release-state/previous',
    'state/backup.json',
  ]) {
    await f.file(`deploy/selfhost/${path}`, 'SELFHOST_SENSITIVE_SENTINEL')
  }
  await f.file('deploy/selfhost/id_ed25519', 'SELFHOST_SENSITIVE_SENTINEL')
  const input = {
    ...f.input,
    target: 'selfhost',
    ai: '',
    'billing-enabled': 'false',
    'credits-enabled': 'false',
    marketing: 'false',
    i18n: 'false',
    oauth: '',
    turnstile: 'false',
  }
  const result = await createProject(input, f.source)
  assert.ok(!(await files(result.target)).some((path) => path.endsWith('deploy-staging.yml')))
  assert.doesNotMatch(
    result.report,
    /BLOCKED|STRIPE_SECRET|PAYPAL_CLIENT|billing:seed|admin\/billing\/plans|CLOUDFLARE_API_TOKEN/,
  )
  assert.match(result.report, /billing=false \/ credits=false \/ marketing=false \/ i18n=false/)
  assert.match(
    result.report,
    /外部应用 S3\/R2：.*compose\.s3\.yaml.*release bundle.*_FILE.*配置缺口/,
  )
  assert.match(result.report, /待交付：deploy\/selfhost\/compose\.s3\.yaml/)
  assert.match(result.report, /独立凭据恢复副本目标（允许不同供应商\/账号）/)
  assert.match(
    result.report,
    /同一 R2 账号方案.*独立桶与桶级独立 token.*供应商独立性.*账号级共同故障/,
  )
  assert.match(result.report, /副本 token 无主桶权限/)
  assert.doesNotMatch(result.report, /第二供应商独立凭据/)
  assert.match(
    result.report,
    /BACKUP_REPLICA_MAX_AGE_SECONDS.*大于 BACKUP_REPLICA_INTERVAL_SECONDS.*间隔 3 倍.*完整同步.*余量.*300\/3600.*显式旧值/,
  )
  assert.match(result.report, /营销页面关闭，\/ 重定向至 \/app/)
  assert.match(result.report, /仅编译所选默认语言 en/)
  assert.match(result.report, /其他语言前缀返回 404/)
  assert.match(result.report, /不显示语言控件，忽略账号语言、cookie 与 Accept-Language/)
  assert.doesNotMatch(
    await readFile(join(result.target, 'deploy/selfhost/compose.yaml'), 'utf8'),
    /GOOGLE_CLIENT|TURNSTILE_|google_client_secret|turnstile_secret/,
  )
  const config = await readFile(join(result.target, 'template.config.ts'), 'utf8')
  for (const section of ['billing', 'credits', 'marketing', 'i18n'])
    assert.match(config, new RegExp(`${section}:\\s*\\{ enabled: false`))
  assert.match(
    config,
    /text: \{ enabled: false, thinking: \{ default: 'on', userToggle: true \}, reasoning: \{ display: true \}, failedReplyRefund: 'all' \}/,
  )
  assert.match(
    await readFile(join(result.target, 'deploy/selfhost/.env.example'), 'utf8'),
    /WEB_IMAGE=ghcr.io\/configure-owner\/acme\/web:<full-40-character-sha>/,
  )
  assert.match(
    await readFile(join(result.target, '.github/workflows/selfhost-publish.yml'), 'utf8'),
    /default: ghcr.io\/configure-owner\/acme/,
  )
  for (const path of await files(result.target))
    assert.doesNotMatch((await readFile(path)).toString(), /SELFHOST_SENSITIVE_SENTINEL/)
  const next = await createProject(
    {
      ...input,
      name: 'second',
      output: join(f.dir, 'second'),
      'image-namespace': 'ghcr.io/second-owner/second',
    },
    result.target,
  )
  assert.match(
    await readFile(join(next.target, 'deploy/selfhost/.env.example'), 'utf8'),
    /WEB_IMAGE=ghcr.io\/second-owner\/second\/web:/,
  )
  assert.match(
    await readFile(join(next.target, '.github/workflows/selfhost-publish.yml'), 'utf8'),
    /default: ghcr.io\/second-owner\/second/,
  )
  assert.match(next.report, /second-selfhost|second-owner\/second/)
})
