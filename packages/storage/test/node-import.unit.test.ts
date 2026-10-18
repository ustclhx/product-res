import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('loads the neutral export in Node without Workers modules or globals', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      "const storage = await import('@product-res/storage'); console.log(typeof storage.declareUpload, typeof storage.persistMediaOutputs, typeof globalThis.FixedLengthStream)",
    ],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' },
  )
  expect(output.trim()).toBe('function function undefined')
})

it('loads the explicit Node adapter without Workers globals', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      "const storage = await import('@product-res/storage/node'); console.log(typeof storage.createNodeStorage, typeof storage.createNodeMediaCopier, typeof globalThis.FixedLengthStream)",
    ],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' },
  )
  expect(output.trim()).toBe('function function undefined')
})
