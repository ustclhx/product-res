import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'

// 原文只在隔离容器内存中供测试读取，不落盘、不转发到外部收件人。
let mode = 'accept'
const messages = []
const attempts = []
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
        if (line !== '.') data.push(line.startsWith('..') ? line.slice(1) : line)
        else {
          const raw = data.join('\r\n')
          const messageId = /Message-ID:\s*(<[^>]+>)/i.exec(raw)?.[1]
          messages.push({ recipient, raw, messageId, acceptedAt: new Date().toISOString() })
          data = undefined
          // 服务端已接受 DATA，客户端却收不到最终 250：结果不确定，允许原身份重试。
          if (mode === 'drop-confirmation-once') {
            mode = 'accept'
            socket.destroy()
            return
          }
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
        case 'RCPT':
          recipient = /<([^>]+)>/.exec(line)?.[1]
          attempts.push({ recipient, at: new Date().toISOString(), mode })
          send(mode === 'temporary' ? '451 fixture temporary failure' : '250 recipient accepted')
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
          data = undefined
          send('250 reset')
          break
        default:
          send('500 unsupported fixture command')
      }
    }
  })
  send('220 localhost auth fixture')
}).listen(2525, '0.0.0.0')

createHttpServer((request, response) => {
  if (request.method === 'POST') {
    if (request.url === '/reset') {
      messages.length = 0
      attempts.length = 0
      mode = 'accept'
    } else if (request.url === '/temporary') mode = 'temporary'
    else if (request.url === '/drop-confirmation-once') mode = 'drop-confirmation-once'
    else if (request.url === '/accept') mode = 'accept'
    else {
      response.writeHead(404).end()
      return
    }
  }
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ mode, attempts, messages }))
}).listen(8080, '0.0.0.0')
