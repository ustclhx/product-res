import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SourceMapConsumer } from 'source-map'
import { assertNodeMaps, nodeMapTargets, prepareNodeMaps } from './sentry-node-maps.mjs'

const validMap = JSON.stringify({
  version: 3,
  sources: ['../../src/node/http.ts'],
  sourcesContent: ['export {}'],
  mappings: 'AAAA',
})

test('Node maps use matching release/dist, isolate upload secrets and remove public maps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfhost-c-wire-maps-'))
  const release = '0123456789abcdef0123456789abcdef01234567'
  try {
    for (const target of nodeMapTargets(root)) {
      await mkdir(target.directory, { recursive: true })
      await writeFile(join(target.directory, 'index.mjs.map'), validMap)
      await writeFile(
        join(target.directory, '../node-build.json'),
        JSON.stringify({ release, dist: target.dist }),
      )
    }
    const publicDirectory = join(root, 'apps/web/.output/public')
    await mkdir(publicDirectory, { recursive: true })
    await writeFile(join(publicDirectory, 'client.js.map'), '{}')
    await writeFile(join(publicDirectory, 'client.js'), 'safe asset')
    const calls = []
    const env = {
      PATH: process.env.PATH,
      SENTRY_AUTH_TOKEN: 'fixture-token',
      SENTRY_ORG: 'fixture',
      SENTRY_PROJECT: 'fixture',
    }
    const run = (args, environment) => calls.push({ args, environment })
    await prepareNodeMaps({ root, release, env, run })
    assert.equal(calls.length, 2)
    assert.ok(calls.every(({ environment }) => environment.SENTRY_AUTH_TOKEN === undefined))
    await assert.rejects(readFile(join(publicDirectory, 'client.js.map')), { code: 'ENOENT' })
    assert.equal(await readFile(join(publicDirectory, 'client.js'), 'utf8'), 'safe asset')
    calls.length = 0
    await prepareNodeMaps({ root, release, upload: true, env, run })
    assert.deepEqual(calls[0].args, ['releases', 'new', release])
    assert.deepEqual(calls.at(-1).args, ['releases', 'finalize', release])
    assert.ok(
      calls
        .filter(({ args }) => args[1] === 'inject')
        .every(({ environment }) => environment.SENTRY_AUTH_TOKEN === undefined),
    )
    const uploads = calls.filter(({ args }) => args[1] === 'upload')
    assert.equal(uploads.length, 2)
    for (const [index, { args, environment }] of uploads.entries()) {
      assert.ok(args.includes(index === 0 ? 'web-node' : 'jobs-node'))
      assert.ok(args.includes(release))
      assert.ok(args.at(-1).endsWith('/.output/server'))
      assert.ok(!args.join(' ').includes('/dist/'))
      assert.ok(!args.join(' ').includes('fixture-token'))
      assert.equal(environment.SENTRY_AUTH_TOKEN, env.SENTRY_AUTH_TOKEN)
    }
    await assert.rejects(prepareNodeMaps({ root, release: 'bad', env, run }), /full git SHA/)
    await assert.rejects(
      prepareNodeMaps({ root, release, upload: true, env: {}, run }),
      /SENTRY_AUTH_TOKEN/,
    )
    await assert.rejects(
      prepareNodeMaps({ root, release: '1'.repeat(40), env, run }),
      /metadata mismatch/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Node map guard rejects maps Sentry cannot resolve to readable TypeScript', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'selfhost-c-map-guard-'))
  const write = (map) => writeFile(join(directory, 'chunk.mjs.map'), JSON.stringify(map))
  const intermediate = '../../node_modules/.nitro/vite/services/ssr/assets/src-x.js'
  try {
    await mkdir(join(directory, 'node_modules/dep'), { recursive: true })
    // trace 的第三方 map 不参与校验。
    await writeFile(join(directory, 'node_modules/dep/index.js.map'), '{"sources":["a.ts"]}')
    await write(JSON.parse(validMap))
    await assertNodeMaps(directory)
    // Nitro 默认 sourcemapMinify 删除 sourcesContent。
    await write({ sources: ['../../src/node/http.ts'], mappings: 'AAAA' })
    await assert.rejects(assertNodeMaps(directory), /Missing sourcesContent/)
    // 来源全在 node_modules（含中间产物）时 Nitro 清空 mappings。
    await write({ sources: [intermediate], mappings: '' })
    await assert.rejects(assertNodeMaps(directory), /Empty source map mappings/)
    // 二次打包未串接 Vite service map，源码只停在中间 JS。
    await write({
      sources: [intermediate],
      sourcesContent: ['export {}\n//# sourceMappingURL=src-x.js.map'],
      mappings: 'AAAA',
    })
    await assert.rejects(assertNodeMaps(directory), /Unchained intermediate/)
    await write({ sources: ['../../src/a.js'], sourcesContent: [''], mappings: 'AAAA' })
    await assert.rejects(assertNodeMaps(directory), /No TypeScript sources/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const webServer = fileURLToPath(new URL('../apps/web/.output/server', import.meta.url))
const sentryTestMessage = 'Sentry verification: web worker test exception'

async function findChunk(directory, text) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const found = await findChunk(path, text)
      if (found) return found
    } else if (entry.name.endsWith('.mjs') && (await readFile(path, 'utf8')).includes(text))
      return path
  }
}

test('built web Node maps resolve the sentry-test throw site to TypeScript with sourcesContent', {
  skip: !existsSync(webServer) && 'run pnpm --filter @product-res/web build:node first',
}, async () => {
  await assertNodeMaps(webServer)
  const chunk = await findChunk(webServer, sentryTestMessage)
  assert.ok(chunk, 'sentry-test chunk not found')
  const code = await readFile(chunk, 'utf8')
  const before = code.slice(0, code.lastIndexOf('throw new Error', code.indexOf(sentryTestMessage)))
  const lines = before.split('\n')
  const map = JSON.parse(await readFile(`${chunk}.map`, 'utf8'))
  await SourceMapConsumer.with(map, null, (consumer) => {
    const position = consumer.originalPositionFor({
      line: lines.length,
      column: lines.at(-1).length,
    })
    assert.ok(position.source, 'throw site has no original position')
    assert.equal(
      resolve(dirname(chunk), position.source),
      fileURLToPath(new URL('../apps/web/src/server/sentry-test.ts', import.meta.url)),
    )
    const content = consumer.sourceContentFor(position.source, true)
    assert.ok(content, 'sentry-test.ts sourcesContent missing')
    assert.match(content, /export async function sentryTest\(/)
    assert.match(content.split('\n')[position.line - 1], /throw new Error\('Sentry verification/)
  })
})
