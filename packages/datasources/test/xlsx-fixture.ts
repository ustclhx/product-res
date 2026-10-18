import { strToU8, zipSync } from 'fflate'

/** 单元格：字符串 → 内联字符串；number → 数字；{ date } → Excel 序列号 + 日期样式；null → 空 */
export type FixtureCell = string | number | { date: number } | null
export interface FixtureSheet {
  readonly name: string
  readonly rows: FixtureCell[][]
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const column = (index: number) => String.fromCharCode(65 + index)
const xmlText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;')

function sheetXml(rows: FixtureCell[][]) {
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((cell, c) => {
          const ref = `${column(c)}${r + 1}`
          if (cell === null) return ''
          if (typeof cell === 'string')
            return `<c r="${ref}" t="inlineStr"><is><t>${xmlText(cell)}</t></is></c>`
          if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`
          return `<c r="${ref}" s="1"><v>${cell.date}</v></c>`
        })
        .join('')
      return `<row r="${r + 1}">${cells}</row>`
    })
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${NS}"><sheetData>${body}</sheetData></worksheet>`
}

/** 手工构造最小 xlsx 夹具（OOXML zip），不依赖写入库 */
export function buildXlsx(sheets: FixtureSheet[]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join('')}</Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>${sheets
        .map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join(
          '',
        )}<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    ),
    // 样式 1 = 内置日期格式 14（m/d/yyyy）
    'xl/styles.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${NS}"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    ),
  }
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s.rows))
  })
  return zipSync(files)
}
