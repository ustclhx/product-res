import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { submitIndexNow } from '../production/submit-indexnow.mjs'
import { checkSecrets, secretRequirements } from './check-secrets.mjs'
import { checkSiteIsolation, expectedFromWrangler } from './check-site-isolation.mjs'
import { waitHealthy } from './wait-healthy.mjs'

test('secret check reports the actual staging payment gaps without printing present secrets', async () => {
  const lines = []
  const missing = {
    web: ['PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID'],
    jobs: secretRequirements.jobs.required,
  }
  const code = await checkSecrets({
    list: async (worker) =>
      [...secretRequirements[worker].required, ...secretRequirements[worker].optional]
        .filter((name) => !missing[worker].includes(name))
        .map((name) => ({ name, type: 'secret_text', value: 'must-not-print' })),
    write: (line) => lines.push(line),
  })
  assert.equal(code, 1)
  assert.deepEqual(lines, [
    'web required: PAYPAL_CLIENT_SECRET',
    'web required: PAYPAL_WEBHOOK_ID',
    'jobs required: STRIPE_SECRET_KEY',
    'jobs required: STRIPE_WEBHOOK_SECRET',
    'jobs required: PAYPAL_CLIENT_ID',
    'jobs required: PAYPAL_CLIENT_SECRET',
    'jobs required: PAYPAL_WEBHOOK_ID',
  ])
})

test('optional secrets do not block an otherwise configured staging environment', async () => {
  const lines = []
  const code = await checkSecrets({
    list: async (worker) => secretRequirements[worker].required.map((name) => ({ name })),
    write: (line) => lines.push(line),
  })
  assert.equal(code, 0)
  assert.deepEqual(lines, [
    'web optional: RESEND_API_KEY',
    'web optional: AI_GATEWAY_TOKEN',
    'web optional: SENTRY_DSN',
    'web optional: R2_ACCESS_KEY_ID',
    'web optional: R2_SECRET_ACCESS_KEY',
    'web optional: INDEXNOW_KEY',
    'jobs optional: RESEND_API_KEY',
    'jobs optional: AI_GATEWAY_TOKEN',
    'jobs optional: SENTRY_DSN',
  ])
})

test('secret list failure and invalid output fail closed without exposing CLI output', async () => {
  const errors = []
  const code = await checkSecrets({
    list: async (worker) => {
      if (worker === 'web') throw new Error('private CLI authentication output')
      return { raw: 'private malformed output' }
    },
    write: () => assert.fail('Failed secret listing must not invent missing secrets'),
    error: (line) => errors.push(line),
  })
  assert.equal(code, 1)
  assert.deepEqual(errors, ['web: secret list failed', 'jobs: secret list failed'])
})

async function mockHealth(t, handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}/api/health`
}

test('health waits through an old version, database downtime and non-200 before succeeding', async (t) => {
  const responses = [
    [200, { version: 'old-sha', db: { status: 'up' } }],
    [200, { version: 'new-sha', db: { status: 'down' }, private: 'connection-string' }],
    [503, { version: 'new-sha', db: { status: 'up' } }],
    [200, { version: 'new-sha', db: { status: 'up' } }],
  ]
  let requests = 0
  const url = await mockHealth(t, (_request, response) => {
    const [status, body] = responses[requests++]
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  const lines = []
  assert.equal(
    await waitHealthy(url, 'new-sha', {
      intervalMs: 200,
      // CI 冷启动时首个 fetch 可能超过 200ms：请求被中止而 mock 已消费第一条响应，日志多出 null 行（#212）。
      // 本用例验证的是响应序列的处理，单次请求时限与间隔分开设置
      requestTimeoutMs: 2_000,
      timeoutMs: 5_000,
      write: (line) => lines.push(line),
    }),
    0,
  )
  assert.equal(requests, 4)
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      { status: 200, version: 'old-sha' },
      { status: 200, version: 'new-sha' },
      { status: 503, version: 'new-sha' },
    ],
  )
})

test('wrong deployed version times out and emits only status and version', async (t) => {
  const url = await mockHealth(t, (_request, response) => {
    response.end(JSON.stringify({ version: 'old-sha', db: { status: 'up' }, secret: 'private' }))
  })
  const lines = []
  const started = performance.now()
  assert.equal(
    await waitHealthy(url, 'new-sha', {
      intervalMs: 20,
      timeoutMs: 100,
      write: (line) => lines.push(line),
    }),
    1,
  )
  assert.ok(performance.now() - started >= 90)
  assert.ok(lines.length >= 2)
  assert.ok(lines.filter((line) => line === '{"status":200,"version":"old-sha"}').length >= 2)
  // 总时限附近的最后一轮可在取得响应前中止，同样只能记录两个允许字段。
  assert.ok(
    lines.every(
      (line) =>
        line === '{"status":200,"version":"old-sha"}' || line === '{"status":null,"version":null}',
    ),
  )
})

test('invalid response and hanging requests stay bounded and do not reveal response or URL', async (t) => {
  let requests = 0
  const url = await mockHealth(t, (_request, response) => {
    if (requests++ === 0) response.end('private invalid response body')
  })
  const lines = []
  const started = performance.now()
  assert.equal(
    await waitHealthy(url, 'new-sha', {
      intervalMs: 30,
      timeoutMs: 130,
      write: (line) => lines.push(line),
    }),
    1,
  )
  assert.ok(performance.now() - started < 500)
  assert.ok(requests >= 2)
  assert.deepEqual(JSON.parse(lines[0]), { status: 200, version: null })
  assert.ok(lines.slice(1).every((line) => line === '{"status":null,"version":null}'))
})

const SITE = 'https://own.example'
const page = (head) => `<!doctype html><html><head>${head}</head><body></body></html>`
const goodHead = `<link rel="canonical" href="${SITE}/"/><link rel="alternate" hreflang="zh" href="${SITE}/zh"/><meta property="og:url" content="${SITE}/"/><link rel="icon" href="/favicon.ico"/>`

function siteFixture(overrides = {}) {
  const routes = {
    '/sitemap.xml': [
      200,
      `<urlset><url><loc>${SITE}/</loc><xhtml:link rel="alternate" hreflang="zh" href="${SITE}/zh"/></url></urlset>`,
    ],
    '/robots.txt': [200, `User-agent: *\nSitemap: ${SITE}/sitemap.xml\n`],
    '/': [200, page(goodHead)],
    '/favicon.ico': [200, 'icon'],
    ...overrides,
  }
  return async (url) => {
    const [status, body] = routes[new URL(url).pathname] ?? [404, 'missing']
    return new Response(body, { status })
  }
}

async function isolationProblems(overrides, options = {}) {
  return checkSiteIsolation({
    baseUrl: SITE,
    appUrl: SITE,
    fetchImpl: siteFixture(overrides),
    write: () => {},
    ...options,
  })
}

test('site isolation passes when every public URL stays on the current environment', async () => {
  assert.deepEqual(await isolationProblems({}), [])
  const script = `<script defer src="https://plausible.example/js/script.manual.js" data-domain="own-staging"></script>`
  assert.deepEqual(
    await isolationProblems(
      { '/': [200, page(goodHead + script)] },
      { plausibleDomain: 'own-staging', plausibleHost: 'https://plausible.example' },
    ),
    [],
  )
})

test('site isolation rejects the staging cross-talk signals', async () => {
  const cases = [
    [
      'sitemap index pointing at a derived site',
      {
        '/sitemap.xml': [
          200,
          '<sitemapindex><sitemap><loc>https://arcanumber.com/sitemap/en.xml</loc></sitemap></sitemapindex>',
        ],
      },
      /arcanumber\.com/,
    ],
    [
      'child sitemap returning 404',
      {
        '/sitemap.xml': [
          200,
          `<sitemapindex><sitemap><loc>${SITE}/sitemap/en.xml</loc></sitemap></sitemapindex>`,
        ],
      },
      /sitemap\/en\.xml: status 404/,
    ],
    [
      'hreflang on another host',
      {
        '/sitemap.xml': [
          200,
          `<urlset><url><loc>${SITE}/</loc><xhtml:link href="https://other.example/zh"/></url></urlset>`,
        ],
      },
      /other\.example/,
    ],
    [
      'robots on another host',
      { '/robots.txt': [200, 'Sitemap: https://other.example/sitemap.xml'] },
      /robots\.txt: https:\/\/other/,
    ],
    [
      'canonical on another host',
      { '/': [200, page('<link rel="canonical" href="https://other.example/"/>')] },
      /other\.example/,
    ],
    ['canonical missing', { '/': [200, page('')] }, /canonical missing/],
    ['favicon 404', { '/favicon.ico': [404, ''] }, /favicon\.ico: status 404/],
    [
      'icon on another host',
      { '/': [200, page(`${goodHead}<link rel="icon" href="https://other.example/i.png"/>`)] },
      /other\.example/,
    ],
    [
      'analytics script without a configured site',
      {
        '/': [
          200,
          page(
            `${goodHead}<script defer src="https://plausible.example/js/script.manual.js" data-domain="prod"></script>`,
          ),
        ],
      },
      /no Plausible site/,
    ],
  ]
  for (const [name, overrides, pattern] of cases) {
    const problems = await isolationProblems(overrides)
    assert.ok(
      problems.some((line) => pattern.test(line)),
      `${name}: ${problems.join('; ')}`,
    )
  }
})

test('site isolation requires this environment Plausible site and host', async () => {
  const options = { plausibleDomain: 'own-staging', plausibleHost: 'https://plausible.example' }
  assert.match((await isolationProblems({}, options))[0], /expected one Plausible script/)
  const wrongSite = `<script src="https://plausible.example/js/script.manual.js" data-domain="own"></script>`
  assert.match(
    (await isolationProblems({ '/': [200, page(goodHead + wrongSite)] }, options))[0],
    /Plausible site own is not own-staging/,
  )
  const wrongHost = `<script src="https://evil.example/js/script.manual.js" data-domain="own-staging"></script>`
  assert.match(
    (await isolationProblems({ '/': [200, page(goodHead + wrongHost)] }, options))[0],
    /is not on https:\/\/plausible\.example/,
  )
  assert.match(
    (await isolationProblems({}, { baseUrl: 'https://wrong.example' }))[0],
    /differs from APP_URL/,
  )
})

test('multi-site pages: expected site follows the checked host through the inline map', async () => {
  // SITE 的主机名是 own.example：映射里它对应 own，另一个站 other.example 对应 other。
  const options = {
    plausibleDomain: '',
    plausibleHost: 'https://plausible.example',
    plausibleSites: 'own.example=own,other.example=other',
  }
  const inline = (config) =>
    `<script type="application/json" id="product-res-plausible" nonce="n">${JSON.stringify(config)}</script>`
  const good = {
    sites: { 'own.example': 'own', 'other.example': 'other' },
    fallback: '',
    scriptUrl: 'https://plausible.example/js/script.manual.js',
  }
  assert.deepEqual(
    await isolationProblems({ '/': [200, page(goodHead + inline(good))] }, options),
    [],
  )
  const crossed = { ...good, sites: { 'own.example': 'other', 'other.example': 'other' } }
  assert.match(
    (await isolationProblems({ '/': [200, page(goodHead + inline(crossed))] }, options)).join(),
    /Plausible site for own\.example is other, not own/,
  )
  const wrongHost = { ...good, scriptUrl: 'https://evil.example/js/script.manual.js' }
  assert.match(
    (await isolationProblems({ '/': [200, page(goodHead + inline(wrongHost))] }, options)).join(),
    /is not on https:\/\/plausible\.example/,
  )
  assert.match((await isolationProblems({}, options)).join(), /config missing or invalid/)
  const script = `<script src="https://plausible.example/js/script.manual.js" data-domain="own"></script>`
  assert.match(
    (
      await isolationProblems({ '/': [200, page(goodHead + inline(good) + script)] }, options)
    ).join(),
    /expected no static Plausible script/,
  )
  // 被检查的域名未登记且无兜底时，页面既不能有脚本也不能有映射。
  const unmapped = { ...options, plausibleSites: 'other.example=other' }
  assert.deepEqual(await isolationProblems({}, unmapped), [])
  assert.match(
    (await isolationProblems({ '/': [200, page(goodHead + inline(good))] }, unmapped)).join(),
    /no Plausible site/,
  )
  // 未登记但有兜底：期望兜底 site。
  const fallback = { ...unmapped, plausibleDomain: 'own' }
  const withFallback = { ...good, sites: { 'other.example': 'other' }, fallback: 'own' }
  assert.deepEqual(
    await isolationProblems({ '/': [200, page(goodHead + inline(withFallback))] }, fallback),
    [],
  )
  assert.match(
    (await isolationProblems({}, { ...options, plausibleSites: 'bad' })).join(),
    /PLAUSIBLE_SITES/,
  )
})

test('IndexNow submits only this site URLs, skips without a key and never fails the release', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/sitemap.xml'))
      return new Response(
        `<urlset><url><loc>${SITE}/a</loc></url><url><loc>https://other.example/b</loc></url></urlset>`,
      )
    return new Response('', { status: 200 })
  }
  const lines = []
  const write = (line) => lines.push(line)
  assert.deepEqual(await submitIndexNow({ baseUrl: SITE, key: '', fetchImpl, write }), {
    status: 'skipped',
  })
  assert.equal(calls.length, 0)
  assert.deepEqual(await submitIndexNow({ baseUrl: SITE, key: 'k1', fetchImpl, write }), {
    status: 'submitted',
    count: 1,
  })
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    host: 'own.example',
    key: 'k1',
    keyLocation: `${SITE}/indexnow.txt`,
    urlList: [`${SITE}/a`],
  })
  assert.deepEqual(
    await submitIndexNow({
      baseUrl: SITE,
      key: 'secret-key',
      fetchImpl: async () => new Response('', { status: 500 }),
      write,
    }),
    { status: 'failed' },
  )
  assert.equal(lines.join('\n').includes('secret-key'), false)
})

test('IndexNow expands a sitemap index into page URLs of this site', async () => {
  const bodies = []
  const xml = {
    '/sitemap.xml': `<sitemapindex><sitemap><loc>${SITE}/sitemap/en.xml</loc></sitemap><sitemap><loc>${SITE}/sitemap/ko.xml</loc></sitemap><sitemap><loc>https://other.example/sitemap/en.xml</loc></sitemap></sitemapindex>`,
    '/sitemap/en.xml': `<urlset><url><loc>${SITE}/en</loc></url><url><loc>${SITE}/en/about</loc></url></urlset>`,
    '/sitemap/ko.xml': `<urlset><url><loc>${SITE}/ko</loc></url><url><loc>${SITE}/en</loc></url></urlset>`,
  }
  const fetchImpl = async (url, init) => {
    const { origin, pathname } = new URL(url)
    if (init?.method === 'POST') {
      bodies.push(JSON.parse(init.body))
      return new Response('', { status: 200 })
    }
    if (origin !== SITE) throw new Error(`fetched other site ${url}`)
    return new Response(xml[pathname])
  }
  assert.deepEqual(await submitIndexNow({ baseUrl: SITE, key: 'k1', fetchImpl, write: () => {} }), {
    status: 'submitted',
    count: 3,
  })
  assert.deepEqual(bodies[0].urlList, [`${SITE}/en`, `${SITE}/en/about`, `${SITE}/ko`])
})

test('site isolation handles a marketing-free project and network failures without crashing', async () => {
  const fetchImpl = siteFixture({
    '/sitemap.xml': [404, ''],
    '/robots.txt': [404, ''],
    '/': [404, ''],
    '/login': [200, page('')],
  })
  assert.deepEqual(await isolationProblems({}, { marketing: false, fetchImpl }), [])
  const problems = await checkSiteIsolation({
    baseUrl: SITE,
    appUrl: SITE,
    retryDelayMs: 0,
    write: () => {},
    fetchImpl: async () => {
      throw new Error('socket reset')
    },
  })
  assert.ok(problems.some((line) => /status 599/.test(line)))
})

test('gate expectations follow the template analytics switch, not just the env vars', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'site-isolation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'apps/web'), { recursive: true })
  await writeFile(
    join(root, 'apps/web/wrangler.jsonc'),
    JSON.stringify({
      env: {
        staging: {
          vars: {
            APP_URL: SITE,
            PLAUSIBLE_DOMAIN: 'a-staging',
            PLAUSIBLE_HOST: 'https://p.example',
          },
        },
      },
    }),
  )
  const expected = async (config) => {
    await writeFile(join(root, 'template.config.ts'), config)
    return expectedFromWrangler('staging', root).plausibleDomain
  }
  assert.equal(await expected("features: { analytics: 'plausible', blog: true }"), 'a-staging')
  assert.equal(await expected('features: {"analytics":"plausible","blog":true}'), 'a-staging')
  assert.equal(await expected('features: { blog: true }'), 'a-staging')
  assert.equal(await expected('features: {"analytics":false,"blog":true}'), '')
  assert.equal(await expected("features: { analytics: 'posthog' }"), '')
  assert.equal(expectedFromWrangler('staging', root).plausibleSites, '')
})
