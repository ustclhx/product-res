import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'

// 受控内部 none 模式；只接本地 fixture，不转发到任何外部邮箱。
const attempts = {}
const messages = []
createServer((socket) => {
  let buffer = ''
  let recipient
  let data
  const send = (line) => socket.write(`${line}\r\n`)
  socket.on('error', () => {})
  socket.on('data', (chunk) => {
    buffer += chunk.toString()
    while (buffer.includes('\r\n')) {
      const end = buffer.indexOf('\r\n')
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      if (data) {
        if (line !== '.') data.push(line)
        else {
          messages.push({ recipient, raw: data.join('\r\n') })
          data = undefined
          send('250 accepted')
        }
        continue
      }
      switch (line.split(' ')[0].toUpperCase()) {
        case 'EHLO':
        case 'HELO':
          send('250-localhost')
          send('250 SIZE 1048576')
          break
        case 'MAIL':
          send('250 sender accepted')
          break
        case 'RCPT': {
          recipient = /<([^>]+)>/.exec(line)?.[1]
          const name = recipient?.split('@')[0]
          attempts[name] = (attempts[name] ?? 0) + 1
          if (name === 'permanent' || name === 'sink') send('550 fixture permanent failure')
          else if (name === 'exhausted' || (name === 'retry' && attempts[name] === 1))
            send('451 fixture temporary failure')
          else send('250 recipient accepted')
          break
        }
        case 'DATA':
          data = []
          send('354 end with dot')
          break
        case 'QUIT':
          send('221 goodbye')
          socket.end()
          break
        case 'RSET':
          data = undefined
          send('250 reset')
          break
        default:
          send('500 unsupported fixture command')
      }
    }
  })
  send('220 localhost jobs fixture')
}).listen(2525, '0.0.0.0')
createHttpServer((request, response) => {
  if (request.method === 'POST' && request.url === '/reset') {
    for (const key of Object.keys(attempts)) delete attempts[key]
    messages.length = 0
  }
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ attempts, messages }))
}).listen(8080, '0.0.0.0')
