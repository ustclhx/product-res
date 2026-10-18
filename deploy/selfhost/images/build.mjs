import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const [version, architecture, directory] = process.argv.slice(2)
if (
  !/^[a-f0-9]{40}$/.test(version ?? '') ||
  !['amd64', 'arm64'].includes(architecture) ||
  !directory
)
  throw new Error('Usage: build.mjs <fullSha> <amd64|arm64> <output-dir>')
const output = resolve(directory)
const catalog = JSON.parse(readFileSync(join(import.meta.dirname, 'catalog.json'), 'utf8'))
if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.services) || !catalog.services.length)
  throw new Error('Invalid image catalog')
const services = [
  ...catalog.services,
  { name: 'native-smoke', dockerfile: 'deploy/selfhost/app.Dockerfile', target: 'native-smoke' },
]
mkdirSync(output, { recursive: true })
const images = []
for (const { name, dockerfile, target } of services) {
  if (
    !/^[a-z][a-z0-9-]*$/.test(name) ||
    !/^deploy\/selfhost\/[\w./-]+\.Dockerfile$/.test(dockerfile)
  )
    throw new Error('Invalid image catalog entry')
  const image = `local/selfhost/${name}:${version}`
  execFileSync(
    'docker',
    [
      'buildx',
      'build',
      '--load',
      // tar 交付只保留已测运行镜像，避免单平台 attestation 嵌套索引混入最终双平台集合。
      '--provenance=false',
      '--platform',
      `linux/${architecture}`,
      '-f',
      dockerfile,
      ...(target ? ['--target', target] : []),
      '--build-arg',
      `APP_VERSION=${version}`,
      '--label',
      `org.opencontainers.image.revision=${version}`,
      '-t',
      image,
      root,
    ],
    { cwd: root, stdio: 'inherit' },
  )
  const [inspection] = JSON.parse(
    execFileSync('docker', ['image', 'inspect', image], { encoding: 'utf8' }),
  )
  if (
    inspection.Architecture !== architecture ||
    inspection.Os !== 'linux' ||
    inspection.Config.Labels?.['org.opencontainers.image.revision'] !== version
  )
    throw new Error(`${name}: image architecture/revision mismatch`)
  const archive = `${name}.tar`
  if (name === 'native-smoke') continue
  execFileSync('docker', ['save', '-o', join(output, archive), image], { stdio: 'inherit' })
  images.push({ name, image, archive, id: inspection.Id, architecture, revision: version })
}
writeFileSync(
  join(output, 'build.json'),
  `${JSON.stringify({ sha: version, arch: architecture, services: images }, null, 2)}\n`,
)
