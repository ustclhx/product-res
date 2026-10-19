import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const composeFile = join(root, 'deploy/selfhost/compose.yaml')
const proxyFile = join(root, 'deploy/selfhost/compose.proxy.yaml')
const tunnelFile = join(root, 'deploy/selfhost/compose.tunnel.yaml')
// 与 catalog 的 app Dockerfile 共用基础 manifest，冷缓存 CI 也不能依赖浮动标签。
const nodeImage = readFileSync(join(root, 'deploy/selfhost/app.Dockerfile'), 'utf8').match(
  /^FROM (node:\S+@sha256:[a-f0-9]{64})\s/m,
)?.[1]
assert(nodeImage, 'Missing pinned Node base in the app Dockerfile')
const args = process.argv.slice(2)
const event = (name, details = {}) => console.info(JSON.stringify({ event: name, ...details }))

// 最终渲染门也可检查 Dokploy Preview Compose；不输出 secret 路径或环境变量。
function checkConfig(config, external) {
  assert(config.services.web, 'Missing web service')
  for (const [name, service] of Object.entries(config.services)) {
    assert(service.image && !service.build, `${name}: prebuilt image required`)
    assert(/^[1-9]\d*(?::[1-9]\d*)?$/.test(service.user), `${name}: non-root UID required`)
    if (external || name !== 'caddy') assert(!service.ports?.length, `${name}: host port forbidden`)
    if (name !== 'web' && name !== 'caddy') {
      assert.deepEqual(Object.keys(service.networks), ['data'], `${name}: ingress access forbidden`)
    }
  }
  for (const name of ['web', 'jobs']) {
    assert.equal(
      config.services[name].depends_on.migrate.condition,
      'service_completed_successfully',
    )
    const secrets = config.services[name].secrets.map((secret) => secret.source)
    assert(!secrets.some((secret) => /migrator|postgres_password|readonly|backup/.test(secret)))
  }
  assert.deepEqual(Object.keys(config.services.web.networks).sort(), ['data', 'ingress'])
  if (external) {
    assert(config.networks.ingress.external, 'Ingress must be external')
    assert(
      !config.networks.ingress.ipam?.config?.length,
      'External ingress must not inherit private IPAM',
    )
    assert(!config.services.web.networks.ingress.ipv4_address, 'Inherited web address')
    const cidrs = config.services.web.environment.TRUSTED_PROXY_CIDRS.split(',').map((s) =>
      s.trim(),
    )
    assert(cidrs.length > 0)
    for (const cidr of cidrs) {
      const [ip, prefix, extra] = cidr.split('/')
      assert(
        !extra && ((isIP(ip) === 4 && prefix === '32') || (isIP(ip) === 6 && prefix === '128')),
        'Trust exact proxy addresses only',
      )
    }
    assert(!config.services.caddy || config.services.caddy.profiles.includes('disabled-caddy'))
  } else {
    assert.deepEqual(config.services.caddy.ports.map((port) => String(port.published)).sort(), [
      '443',
      '80',
    ])
    assert.deepEqual(Object.keys(config.services.caddy.networks), ['ingress'])
  }
  event('selfhost.proxy.config', {
    mode: external ? 'external' : 'plain',
    build: false,
    dataPorts: false,
    nonRoot: true,
  })
}
// 隧道模式：cloudflared 是唯一入口，只接 ingress 固定地址；token 只经 file secret 交给它。
function checkTunnelConfig(config) {
  assert(!config.services.caddy, 'Tunnel mode must not enable the built-in proxy')
  const tunnel = config.services.cloudflared
  assert(tunnel, 'Missing cloudflared service')
  for (const [name, service] of Object.entries(config.services)) {
    assert(service.image && !service.build, `${name}: prebuilt image required`)
    assert(/^[1-9]\d*(?::[1-9]\d*)?$/.test(service.user), `${name}: non-root UID required`)
    assert(!service.ports?.length, `${name}: host port forbidden`)
    if (!['web', 'cloudflared'].includes(name))
      assert.deepEqual(Object.keys(service.networks), ['data'], `${name}: ingress access forbidden`)
    if (name !== 'cloudflared')
      assert(
        !(service.secrets ?? []).some((secret) => secret.source === 'cloudflared_tunnel_token'),
        `${name}: tunnel token must stay with cloudflared`,
      )
  }
  assert(!config.networks.ingress.external, 'Tunnel ingress is the private project network')
  assert.deepEqual(Object.keys(tunnel.networks), ['ingress'], 'cloudflared must not join data')
  const address = tunnel.networks.ingress?.ipv4_address
  assert(isIP(address) === 4, 'cloudflared requires a fixed IPv4 address')
  assert.equal(config.services.web.environment.TRUSTED_PROXY_CIDRS, `${address}/32`)
  assert.equal(config.services.web.networks.ingress.ipv4_address, '172.30.77.3')
  assert.notEqual(address, config.services.web.networks.ingress.ipv4_address)
  assert.deepEqual(
    (tunnel.secrets ?? []).map((secret) => secret.source),
    ['cloudflared_tunnel_token'],
  )
  assert(tunnel.command.includes('--token-file'), 'Tunnel token must be read from a file')
  assert(tunnel.command.includes('--no-autoupdate'), 'Tunnel binary must not self-update')
  assert(
    !tunnel.command.some((arg) => arg === '--token' || arg.startsWith('--token=')),
    'Tunnel token must not be passed in argv',
  )
  assert(
    !Object.keys(tunnel.environment ?? {}).some((key) => key.startsWith('TUNNEL_TOKEN')),
    'Tunnel token must not be passed in the environment',
  )
  assert.equal(tunnel.read_only, true)
  assert.deepEqual(tunnel.cap_drop, ['ALL'])
  assert(tunnel.security_opt.includes('no-new-privileges:true'))
  assert.equal(tunnel.restart, 'unless-stopped')
  event('selfhost.proxy.config', { mode: 'tunnel', build: false, hostPorts: false, nonRoot: true })
}
if (args.length) {
  assert(
    args.length === 2 &&
      ['--external-config', '--plain-config', '--tunnel-config'].includes(args[0]),
    'Usage: node test-proxy.mjs [--external-config|--plain-config|--tunnel-config final.json]',
  )
  const config = JSON.parse(readFileSync(resolve(args[1]), 'utf8'))
  if (args[0] === '--tunnel-config') checkTunnelConfig(config)
  else checkConfig(config, args[0] === '--external-config')
  process.exit(0)
}

// biome-ignore lint/suspicious/noUndeclaredEnvVars: 独立验收脚本不由 Turbo 调用或缓存。
const caddyImage = process.env.SELFHOST_PROXY_CADDY_IMAGE
assert(caddyImage, 'Set SELFHOST_PROXY_CADDY_IMAGE to a prebuilt release Caddy wrapper image')
const directory = mkdtempSync(join(tmpdir(), 'selfhost-proxy-'))
chmodSync(directory, 0o755)
const project = `selfhost-proxy-${process.pid}-${Date.now()}`
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  COMPOSE_PROFILES: 'caddy',
  APP_URL: 'https://proxy.test',
  APP_DOMAIN: 'proxy.test',
  GOOGLE_CLIENT_ID: 'fixture',
  GITHUB_CLIENT_ID: 'fixture',
  TURNSTILE_SITE_KEY: 'fixture',
  TRUSTED_PROXY_CIDRS: '172.30.77.2/32',
  EXTERNAL_INGRESS_NETWORK: `${project}-external`,
}
for (const name of ['WEB', 'JOBS', 'MIGRATE', 'POSTGRES', 'VALKEY', 'CADDY', 'CLOUDFLARED'])
  env[`${name}_IMAGE`] = `fixture/${name.toLowerCase()}:${'a'.repeat(40)}`
const run = (command, parameters, options = {}) =>
  execFileSync(command, parameters, {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    ...options,
  })
const config = (files, extra = []) =>
  JSON.parse(
    run('docker', [
      'compose',
      ...files.flatMap((file) => ['-f', file]),
      ...extra,
      'config',
      '--format',
      'json',
    ]),
  )
const fixture = join(directory, 'compose.yaml')
const compose = (...parameters) => run('docker', ['compose', '-f', fixture, ...parameters])
let started = false
try {
  checkConfig(config([composeFile]), false)
  checkConfig(config([composeFile, proxyFile]), true)
  // 显式启用所有 profile 仍无宿主端口；确保 override 真正清除列表而非追加。
  checkConfig(config([composeFile, proxyFile], ['--profile', '*']), true)
  const broad = config([composeFile, proxyFile])
  broad.services.web.environment.TRUSTED_PROXY_CIDRS = '172.30.0.0/16'
  assert.throws(() => checkConfig(broad, true), /exact proxy/)
  const exposed = config([composeFile, proxyFile])
  exposed.services.postgres.ports = [{ target: 5432, published: '5432' }]
  assert.throws(() => checkConfig(exposed, true), /host port/)

  // 隧道叠加：.env 保留 caddy profile 或误用 --profile '*' 都不能恢复内置代理与宿主端口。
  checkTunnelConfig(config([composeFile, tunnelFile]))
  const everyProfile = config([composeFile, tunnelFile], ['--profile', '*'])
  assert.deepEqual(everyProfile.services.caddy?.ports ?? [], [], 'Tunnel caddy kept host ports')
  delete everyProfile.services.caddy
  checkTunnelConfig(everyProfile)
  const tunnelBroad = config([composeFile, tunnelFile])
  tunnelBroad.services.web.environment.TRUSTED_PROXY_CIDRS = '172.30.77.0/28'
  assert.throws(() => checkTunnelConfig(tunnelBroad))
  const tunnelData = config([composeFile, tunnelFile])
  tunnelData.services.cloudflared.networks.data = {}
  assert.throws(() => checkTunnelConfig(tunnelData), /data/)
  const tunnelArgv = config([composeFile, tunnelFile])
  tunnelArgv.services.cloudflared.command.push('--token=leak')
  assert.throws(() => checkTunnelConfig(tunnelArgv), /argv/)
  const tunnelShared = config([composeFile, tunnelFile])
  tunnelShared.services.web.secrets.push({ source: 'cloudflared_tunnel_token' })
  assert.throws(() => checkTunnelConfig(tunnelShared), /stay with cloudflared/)

  run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(directory, 'server.key'),
    '-out',
    join(directory, 'server.crt'),
    '-days',
    '1',
    '-subj',
    '/CN=proxy.test',
    '-addext',
    'subjectAltName=DNS:proxy.test',
  ])
  // 夹具没有真实secret；可读私钥仅用于容器UID读取，父目录在 finally 删除。
  chmodSync(join(directory, 'server.key'), 0o644)
  writeFileSync(
    join(directory, 'echo.mjs'),
    `import {createServer} from 'node:http'
createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({peer:req.socket.remoteAddress,xff:req.headers['x-forwarded-for'],cf:req.headers['cf-connecting-ip'],forwarded:req.headers.forwarded,uid:process.getuid()}))}).listen(3000,'0.0.0.0')\n`,
  )
  writeFileSync(
    join(directory, 'Caddyfile'),
    `{
 http_port 8080
 https_port 8443
 admin off
 auto_https disable_redirects
 servers {
  protocols h1 h2
 }
}
proxy.test {
 tls /fixture/server.crt /fixture/server.key
 reverse_proxy web:3000 {
  header_up X-Forwarded-For {http.request.remote.host}
  header_up -CF-Connecting-IP
  header_up -Forwarded
 }
}\n`,
  )
  writeFileSync(
    fixture,
    `name: ${project}
services:
  web:
    image: ${nodeImage}
    user: '1000:1000'
    command: [node, /fixture/echo.mjs]
    volumes: ['${directory}:/fixture:ro']
    networks: [ingress, data]
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
  proxy:
    image: ${caddyImage}
    user: '10001:10001'
    command: [caddy, run, --config, /fixture/Caddyfile, --adapter, caddyfile]
    volumes: ['${directory}:/fixture:ro']
    environment: {XDG_CONFIG_HOME: /tmp/config, XDG_DATA_HOME: /tmp/data}
    tmpfs: ['/tmp:uid=10001,gid=10001']
    networks: [ingress]
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
  probe:
    image: ${nodeImage}
    user: '1000:1000'
    command: [node, -e, 'setInterval(()=>{},1000)']
    volumes: ['${directory}:/fixture:ro']
    networks: [ingress]
networks:
  ingress: {}
  data: {internal: true}
`,
  )
  // 只拉夹具所需固定 digest；proxy wrapper 已由调用者构建，不能被上游镜像替代。
  run('docker', ['pull', nodeImage], { timeout: 300_000 })
  started = true
  compose('up', '-d', '--pull', 'never')
  const probe = `const https=require('node:https'),fs=require('node:fs');const req=https.get({host:'proxy',port:8443,servername:'proxy.test',ca:fs.readFileSync('/fixture/server.crt'),headers:{host:'proxy.test','x-forwarded-for':'198.51.100.66, fake','cf-connecting-ip':'198.51.100.66',forwarded:'for=198.51.100.66'}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>console.log(text))});req.setTimeout(3000,()=>req.destroy());req.on('error',()=>process.exit(1))`
  let result
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      result = JSON.parse(compose('exec', '-T', 'probe', 'node', '-e', probe))
      break
    } catch {
      // 启动中的短窗口只等待本夹具；无外部网络重试。
      await new Promise((accept) => setTimeout(accept, 500))
    }
  }
  if (!result) process.stderr.write(compose('logs', '--no-log-prefix', 'proxy', 'web'))
  assert(result, 'TLS fixture failed to become available')
  const probeId = compose('ps', '-q', 'probe').trim()
  const probeIp = JSON.parse(run('docker', ['inspect', probeId]))[0].NetworkSettings.Networks[
    `${project}_ingress`
  ].IPAddress
  assert.equal(result.xff, probeIp, 'Forged XFF reached upstream')
  assert.equal(result.cf, undefined)
  assert.equal(result.forwarded, undefined)
  assert.equal(result.uid, 1000)
  const failure = probe.replace(",ca:fs.readFileSync('/fixture/server.crt')", '')
  assert.throws(
    () => compose('exec', '-T', 'probe', 'node', '-e', failure),
    'Untrusted TLS certificate accepted',
  )
  for (const [name, uid] of [
    ['web', '1000'],
    ['proxy', '10001'],
    ['probe', '1000'],
  ]) {
    assert.equal(compose('exec', '-T', name, 'id', '-u').trim(), uid)
    const id = compose('ps', '-q', name).trim()
    const inspection = JSON.parse(run('docker', ['inspect', id]))[0]
    assert(
      !Object.keys(inspection.NetworkSettings.Ports ?? {}).some(
        (port) => inspection.NetworkSettings.Ports[port]?.length,
      ),
      `${name}: published port`,
    )
    if (name !== 'web')
      assert(!inspection.NetworkSettings.Networks[`${project}_data`], `${name}: data access`)
  }
  event('selfhost.proxy.runtime', {
    tlsVerified: true,
    unknownCARejected: true,
    forgedHeadersRemoved: true,
    actualUid: { web: 1000, proxy: 10001, probe: 1000 },
    hostPorts: false,
    proxyDataNetwork: false,
  })
} finally {
  try {
    if (started) compose('down', '-v', '--remove-orphans')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  event('selfhost.proxy.cleaned')
}
