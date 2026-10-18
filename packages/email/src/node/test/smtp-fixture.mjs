import { readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { createSecureContext, createServer as createTlsServer, TLSSocket } from 'node:tls'

// 只模拟本地协议，不转发邮件，也不记录认证载荷。
const responseSentinel = 'SMTP_FIXTURE_PRIVATE_RESPONSE'
const certificates = (name) => ({
  key: readFileSync(`/certs/${name}.key`),
  cert: readFileSync(`/certs/${name}.crt`),
})
let scenario = {}
let state = { commands: [], messages: [], connections: 0, externalReads: 0 }

function session(initialSocket, mode, certificate = 'localhost') {
  const behavior = { ...scenario }
  let socket = initialSocket
  let buffer = ''
  let data = null
  let secured = mode === 'implicit'
  let authLogin = 0
  let recipientCount = 0
  state.connections++
  const send = (line) => socket.write(`${line}\r\n`)
  const reject = (stage) => {
    if (behavior.errorAt !== stage) return false
    send(`${behavior.status} ${responseSentinel}`)
    return true
  }
  const onData = (chunk) => {
    buffer += chunk.toString('utf8')
    while (buffer.includes('\r\n')) {
      const end = buffer.indexOf('\r\n')
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      if (data !== null) {
        if (line !== '.') {
          data.push(line.startsWith('..') ? line.slice(1) : line)
          continue
        }
        state.messages.push({ raw: data.join('\r\n'), secured })
        data = null
        if (behavior.behavior === 'accepted-close') socket.destroy()
        else if (!reject('data')) send('250 2.0.0 accepted')
        continue
      }
      if (authLogin > 0) {
        authLogin--
        if (authLogin > 0) send('334 UGFzc3dvcmQ6')
        else if (!reject('auth')) send('235 2.7.0 authenticated')
        continue
      }
      const command = line.split(' ')[0].toUpperCase()
      state.commands.push({ command, secured })
      switch (command) {
        case 'EHLO':
        case 'HELO':
          if (behavior.behavior === 'socket-timeout') break
          if (behavior.behavior === 'disconnect') {
            socket.destroy()
            break
          }
          send('250-localhost')
          if (mode === 'starttls' && !secured) send('250-STARTTLS')
          if (!behavior.hideAuth) send('250-AUTH PLAIN LOGIN')
          send('250 SIZE 1048576')
          break
        case 'STARTTLS': {
          if (mode !== 'starttls') {
            send(`500 ${responseSentinel}`)
            break
          }
          send('220 2.0.0 begin TLS')
          socket.removeListener('data', onData)
          socket = new TLSSocket(socket, {
            isServer: true,
            secureContext: createSecureContext(certificates(certificate)),
          })
          secured = true
          socket.on('error', () => {})
          socket.on('data', onData)
          break
        }
        case 'AUTH':
          if (line.startsWith('AUTH LOGIN')) {
            authLogin = 2
            send('334 VXNlcm5hbWU6')
          } else if (!reject('auth')) send('235 2.7.0 authenticated')
          break
        case 'MAIL':
          if (!reject('mail')) send('250 2.1.0 sender accepted')
          break
        case 'RCPT':
          recipientCount++
          if (
            behavior.errorAt === 'rcpt' &&
            (!behavior.rejectSecondRecipient || recipientCount === 2)
          ) {
            reject('rcpt')
          } else send('250 2.1.5 recipient accepted')
          break
        case 'DATA':
          data = []
          send('354 end with dot')
          break
        case 'QUIT':
          send('221 goodbye')
          socket.end()
          break
        case 'RSET':
          data = null
          send('250 reset')
          break
        default:
          send(`500 ${responseSentinel}`)
      }
    }
  }
  socket.on('error', () => {})
  socket.on('data', onData)
  if (behavior.behavior !== 'greeting-timeout') send(`220 localhost ${responseSentinel}`)
}

const endpoints = [
  [2525, 'none', 'localhost'],
  [2465, 'implicit', 'localhost'],
  [2587, 'starttls', 'localhost'],
  [2588, 'none', 'localhost'],
  [2466, 'implicit', 'mismatch'],
  [2467, 'implicit', 'untrusted'],
  [2589, 'starttls', 'mismatch'],
  [2590, 'starttls', 'untrusted'],
]
for (const [port, mode, certificate] of endpoints) {
  const accept = (socket) => session(socket, mode, certificate)
  const server =
    mode === 'implicit'
      ? createTlsServer(certificates(certificate), accept)
      : createNetServer(accept)
  server.on('tlsClientError', () => {})
  server.listen(port, '0.0.0.0')
}

createHttpServer(async (request, response) => {
  if (request.url === '/forbidden-attachment') state.externalReads++
  if (request.method === 'POST' && request.url === '/configure') {
    let body = ''
    for await (const chunk of request) body += chunk
    scenario = JSON.parse(body)
    state = { commands: [], messages: [], connections: 0, externalReads: 0 }
  }
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify(state))
}).listen(8080, '0.0.0.0')
