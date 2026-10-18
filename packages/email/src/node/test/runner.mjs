import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureDirectory = dirname(fileURLToPath(import.meta.url))
const packageDirectory = resolve(fixtureDirectory, '../../..')
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'selfhost-c-smtp-'))
const containerName = `selfhost-c-smtp-${process.pid}-${Date.now()}`
const image = 'node:22.23.3-bookworm-slim'
let testProcess
let cleaned = false
let created = false
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error}`)
  return result.stdout.trim()
}
function cleanup() {
  if (cleaned) return
  cleaned = true
  if (created)
    spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore', timeout: 30_000 })
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
process.on('exit', cleanup)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    testProcess?.kill(signal)
    cleanup()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  })
}

try {
  // 私钥只在临时目录生成；测试进程独占额外 CA，不改变用户的信任配置。
  run('docker', ['image', 'inspect', image])
  for (const name of ['trusted-ca', 'untrusted-ca']) {
    run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${name}`,
      '-keyout',
      join(temporaryDirectory, `${name}.key`),
      '-out',
      join(temporaryDirectory, `${name}.crt`),
    ])
  }
  for (const name of ['localhost', 'mismatch', 'untrusted']) {
    const ca = name === 'untrusted' ? 'untrusted-ca' : 'trusted-ca'
    const san = name === 'mismatch' ? 'DNS:other.invalid' : 'DNS:localhost,IP:127.0.0.1'
    const extension = join(temporaryDirectory, `${name}.ext`)
    writeFileSync(extension, `subjectAltName=${san}\nextendedKeyUsage=serverAuth\n`)
    run('openssl', [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-subj',
      `/CN=${name}`,
      '-keyout',
      join(temporaryDirectory, `${name}.key`),
      '-out',
      join(temporaryDirectory, `${name}.csr`),
    ])
    run('openssl', [
      'x509',
      '-req',
      '-days',
      '1',
      '-in',
      join(temporaryDirectory, `${name}.csr`),
      '-CA',
      join(temporaryDirectory, `${ca}.crt`),
      '-CAkey',
      join(temporaryDirectory, `${ca}.key`),
      '-CAcreateserial',
      '-extfile',
      extension,
      '-out',
      join(temporaryDirectory, `${name}.crt`),
    ])
  }
  const ports = [8080, 2525, 2465, 2587, 2588, 2466, 2467, 2589, 2590]
  run('docker', [
    'create',
    '--rm',
    '--pull=never',
    '--name',
    containerName,
    '--network',
    'bridge',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    ...ports.flatMap((port) => ['-p', `127.0.0.1::${port}`]),
    '--mount',
    `type=bind,src=${fixtureDirectory},dst=/fixture,readonly`,
    '--mount',
    `type=bind,src=${temporaryDirectory},dst=/certs,readonly`,
    image,
    'node',
    '/fixture/smtp-fixture.mjs',
  ])
  created = true
  run('docker', ['start', containerName])
  const bindings = JSON.parse(
    run('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', containerName]),
  )
  const mapped = Object.fromEntries(
    ports.map((port) => [port, bindings[`${port}/tcp`][0].HostPort]),
  )
  const control = `http://127.0.0.1:${mapped[8080]}`
  let ready = false
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(control, { signal: AbortSignal.timeout(1000) })
      if (response.ok) {
        ready = true
        break
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!ready) throw new Error('SMTP fixture did not become ready')
  const exitCode = await new Promise((resolve, reject) => {
    testProcess = spawn(
      'pnpm',
      ['exec', 'vitest', 'run', '--config', 'src/node/test/vitest.config.ts'],
      {
        cwd: packageDirectory,
        stdio: 'inherit',
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: join(temporaryDirectory, 'trusted-ca.crt'),
          SMTP_FIXTURE_CONTROL: control,
          SMTP_FIXTURE_PORTS: JSON.stringify(mapped),
        },
      },
    )
    testProcess.on('error', reject)
    testProcess.on('exit', (code) => resolve(code ?? 1))
  })
  process.exitCode = exitCode
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  cleanup()
}
