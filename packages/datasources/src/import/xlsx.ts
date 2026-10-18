import readExcelFile from 'read-excel-file/universal'

export interface XlsxTable {
  /** 工作簿内全部工作表名，供界面选择 */
  readonly sheetNames: string[]
  /** 实际解析的工作表 */
  readonly sheetName: string
  /** 表头 + 行，与 parseCsv 的返回结构一致（全部为字符串） */
  readonly table: string[][]
}

export class XlsxSheetNotFoundError extends Error {
  constructor(readonly sheetName: string) {
    super(`工作簿中没有名为「${sheetName}」的工作表`)
    this.name = 'XlsxSheetNotFoundError'
  }
}

/**
 * XLSX 解析：默认取第一个工作表，可按名称指定；输出与 CSV 相同的字符串表格。
 * - 日期单元格转 YYYY-MM-DD；
 * - 数字保留文件中的原始文本（parseNumber 返回字符串），避免浮点转换丢精度；
 * - 完全为空的行跳过。
 * 只在服务端调用；传入的 bytes 由调用方限制大小。
 */
export async function parseXlsx(bytes: Uint8Array, sheetName?: string): Promise<XlsxTable> {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  const sheets = await readExcelFile<string>(buffer, { parseNumber: (text) => text })
  const sheetNames = sheets.map((s) => s.sheet)
  const picked = sheetName === undefined ? sheets[0] : sheets.find((s) => s.sheet === sheetName)
  if (!picked) throw new XlsxSheetNotFoundError(sheetName ?? '')
  const table = picked.data
    .map((row) => row.map(cellText))
    .filter((row) => row.some((cell) => cell.trim() !== ''))
  return { sheetNames, sheetName: picked.sheet, table }
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return String(value)
}
