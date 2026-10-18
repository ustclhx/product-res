import { parseCsv } from './csv.ts'
import { parseXlsx } from './xlsx.ts'

export type ImportFileKind = 'csv' | 'xlsx'

export interface ParsedImportFile {
  readonly kind: ImportFileKind
  /** 原文件存档用的 MIME */
  readonly contentType: string
  readonly table: string[][]
  /** 仅 XLSX：全部工作表名与实际解析的工作表 */
  readonly sheetNames: string[]
  readonly sheetName: string | null
}

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** 按扩展名判断文件类型；不支持（含旧版 .xls）返回 null */
export function detectImportKind(fileName: string): ImportFileKind | null {
  if (/\.(csv|tsv|txt)$/i.test(fileName)) return 'csv'
  if (/\.xlsx$/i.test(fileName)) return 'xlsx'
  return null
}

/** 按文件类型分派 CSV / XLSX 解析，输出同一表格结构 */
export async function parseImportFile(
  fileName: string,
  bytes: Uint8Array,
  sheetName?: string,
): Promise<ParsedImportFile> {
  const kind = detectImportKind(fileName)
  if (kind === 'xlsx') {
    const parsed = await parseXlsx(bytes, sheetName)
    return {
      kind,
      contentType: XLSX_CONTENT_TYPE,
      table: parsed.table,
      sheetNames: parsed.sheetNames,
      sheetName: parsed.sheetName,
    }
  }
  if (kind === 'csv') {
    return {
      kind,
      contentType: 'text/csv',
      table: parseCsv(new TextDecoder().decode(bytes)),
      sheetNames: [],
      sheetName: null,
    }
  }
  throw new Error(`不支持的文件类型：${fileName}`)
}
