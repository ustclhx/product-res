import { readFileSync, writeFileSync } from 'node:fs'

const report = {
  sha: '1888e7d165b0b87784e7d16a4c39709a9bc063e3',
  checkedAt: new Date().toISOString(),
  success: false,
}
try {
  const input = JSON.parse(
    readFileSync('/tmp/selfhost-acceptance-1888e7d/browser-input.json', 'utf8'),
  )
  const response = await fetch(
    `https://selfhost.ezarouter.cc/api/files/${encodeURIComponent(input.fileId)}?workspaceId=${encodeURIComponent(input.workspaceId)}&download=1`,
    { headers: { cookie: input.cookie }, redirect: 'manual' },
  )
  if (response.status !== 302) throw Error('FILE_REDIRECT_FAILED')
  const target = response.headers.get('location')
  const get = await fetch(target)
  const body = new Uint8Array(await get.arrayBuffer())
  if (get.status !== 200 || body.length !== 4 || !body.every((v) => v === 0))
    throw Error('FILE_CONTENT_FAILED')
  Object.assign(report, {
    success: true,
    preRebootSessionStillAuthorized: true,
    redirectStatus: response.status,
    objectStatus: get.status,
    bytes: body.length,
    bodyMatches: true,
    tlsVerificationDisabled: false,
    secretsOrSignedUrlsReported: false,
  })
} catch (e) {
  report.errorType = e.name
  process.exitCode = 1
}
writeFileSync(
  '/tmp/selfhost-acceptance-1888e7d/postboot-file.json',
  `${JSON.stringify(report, null, 2)}\n`,
)
console.log(JSON.stringify(report))
