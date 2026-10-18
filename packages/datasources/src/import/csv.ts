/**
 * CSV 解析（RFC 4180）：引号、转义引号、CRLF、UTF-8 BOM；自动识别逗号 / 制表符 / 分号分隔。
 * 返回原始字符串，不做类型转换。
 */
export function parseCsv(input: string, delimiter = detectDelimiter(input)): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += char
      continue
    }
    if (char === '"' && field === '') quoted = true
    else if (char === delimiter) {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += char
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  // 去掉末尾空行
  while (rows.length > 0 && rows.at(-1)?.every((cell) => cell.trim() === '')) rows.pop()
  return rows
}

function detectDelimiter(text: string) {
  const firstLine = text.slice(0, text.search(/\r?\n|$/))
  const counts = [',', '\t', ';'].map((d) => [d, firstLine.split(d).length - 1] as const)
  counts.sort((a, b) => b[1] - a[1])
  return counts[0]?.[1] ? counts[0][0] : ','
}
