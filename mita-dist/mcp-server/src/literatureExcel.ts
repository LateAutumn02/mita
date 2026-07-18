import ExcelJS from 'exceljs'
import { mkdir, readdir, readFile, stat } from 'fs/promises'
import { dirname, extname, isAbsolute, join } from 'path'
import { homedir } from 'os'
import { z } from 'zod/v4'

export const literatureExcelInputSchema = {
  columns: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Ordered Excel columns from the normalized field specification. Required unless existing_excel_path has headers.',
    ),
  json_dir: z
    .string()
    .describe('Absolute directory containing subagent JSON output files.'),
  output_path: z
    .string()
    .describe('Absolute .xlsx path to write the merged workbook to.'),
  existing_excel_path: z
    .string()
    .optional()
    .describe('Optional absolute .xlsx path to preserve and append to.'),
  renumber: z
    .boolean()
    .optional()
    .describe('Whether to renumber a serial-number column after merging.'),
}

export const literatureExcelOutputSchema = z.object({
  outputPath: z.string(),
  columns: z.array(z.string()),
  jsonFilesRead: z.number(),
  existingRowsPreserved: z.number(),
  rowsAdded: z.number(),
  duplicatesSkipped: z.number(),
  invalidRecordsSkipped: z.number(),
  issues: z.array(
    z.object({
      source: z.string(),
      message: z.string(),
    }),
  ),
})

export type LiteratureExcelOutput = z.infer<typeof literatureExcelOutputSchema>

type RecordObject = Record<string, unknown>

function normalize(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。；;、:："'“”‘’()（）[\]【】\-]+/g, '')
}

function extractDoi(value: unknown): string {
  const match = String(value ?? '').match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/)
  return match?.[0]?.replace(/[.;,，。；]+$/, '') ?? ''
}

function looksLikeSerialColumn(header: string): boolean {
  return ['序号', '编号', 'No.', 'No', 'ID', 'id'].includes(header)
}

function titleColumns(headers: string[]): string[] {
  return headers.filter(header =>
    ['题目', '标题', '文献题目', 'Title', 'title'].includes(header),
  )
}

function citationColumns(headers: string[]): string[] {
  return headers.filter(header =>
    ['引用文献格式', '参考文献', '引用', 'Citation', 'citation'].includes(header),
  )
}

function sourceColumns(headers: string[]): string[] {
  return headers.filter(header =>
    ['文献', 'pdf原文', 'PDF文件', 'PDF', 'pdf', '文件名', '来源文件'].includes(header),
  )
}

function doiColumns(headers: string[]): string[] {
  return headers.filter(header => ['DOI', 'doi'].includes(header))
}

function headerMatchesClean(header: string, candidates: string[]): boolean {
  const normalizedHeader = normalize(header)
  return candidates.some(candidate => normalize(candidate) === normalizedHeader)
}

function serialColumnsClean(headers: string[]): string[] {
  return headers.filter(header =>
    headerMatchesClean(header, ['序号', '编号', '搴忓彿', '缂栧彿', 'No.', 'No', 'ID', 'id']),
  )
}

function titleColumnsClean(headers: string[]): string[] {
  return headers.filter(header =>
    headerMatchesClean(header, [
      '题目',
      '标题',
      '文献题目',
      '棰樼洰',
      '鏍囬',
      '鏂囩尞棰樼洰',
      'Title',
      'title',
    ]),
  )
}

function citationColumnsClean(headers: string[]): string[] {
  return headers.filter(header =>
    headerMatchesClean(header, [
      '引用文献格式',
      '参考文献',
      '引用',
      '寮曠敤鏂囩尞鏍煎紡',
      '鍙傝€冩枃鐚?',
      '寮曠敤',
      'Citation',
      'citation',
    ]),
  )
}

function sourceColumnsClean(headers: string[]): string[] {
  return headers.filter(header =>
    headerMatchesClean(header, [
      '文献',
      'pdf原文',
      'PDF文件',
      '文件名',
      '来源文件',
      '鏂囩尞',
      'pdf鍘熸枃',
      'PDF鏂囦欢',
      '鏂囦欢鍚?',
      '鏉ユ簮鏂囦欢',
      'PDF',
      'pdf',
    ]),
  )
}

function valueForClean(record: RecordObject, header: string): unknown {
  if (record[header] !== undefined) return record[header]
  if (headerMatchesClean(header, ['文献', '鏂囩尞'])) {
    return (
      record['pdf原文'] ??
      record['pdf鍘熸枃'] ??
      record['PDF文件'] ??
      record['PDF鏂囦欢'] ??
      ''
    )
  }
  if (headerMatchesClean(header, ['pdf原文', 'pdf鍘熸枃'])) {
    return (
      record['文献'] ??
      record['鏂囩尞'] ??
      record['PDF文件'] ??
      record['PDF鏂囦欢'] ??
      ''
    )
  }
  if (headerMatchesClean(header, ['PDF文件', 'PDF鏂囦欢'])) {
    return (
      record['文献'] ??
      record['鏂囩尞'] ??
      record['pdf原文'] ??
      record['pdf鍘熸枃'] ??
      ''
    )
  }
  return valueFor(record, header)
}

function valueFor(record: RecordObject, header: string): unknown {
  if (record[header] !== undefined) return record[header]
  if (header === '文献') return record['pdf原文'] ?? record['PDF文件'] ?? ''
  if (header === 'pdf原文') return record['文献'] ?? record['PDF文件'] ?? ''
  if (header === 'PDF文件') return record['文献'] ?? record['pdf原文'] ?? ''
  return ''
}

function stringifyCellValue(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return ''
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  return JSON.stringify(value)
}

function keysForRecord(record: RecordObject, headers: string[]): Set<string> {
  const values: unknown[] = []
  for (const header of [
    ...titleColumnsClean(headers),
    ...citationColumnsClean(headers),
    ...sourceColumnsClean(headers),
    ...doiColumns(headers),
  ]) {
    values.push(valueForClean(record, header))
  }
  for (const header of citationColumnsClean(headers)) {
    values.push(extractDoi(valueForClean(record, header)))
  }
  return new Set(values.map(normalize).filter(Boolean))
}

function keysForWorksheetRow(
  worksheet: ExcelJS.Worksheet,
  rowNumber: number,
  headers: string[],
): Set<string> {
  const headerIndex = new Map(headers.map((h, i) => [h, i + 1]))
  const row = worksheet.getRow(rowNumber)
  const values: unknown[] = []
  for (const header of [
    ...titleColumnsClean(headers),
    ...citationColumnsClean(headers),
    ...sourceColumnsClean(headers),
    ...doiColumns(headers),
  ]) {
    const index = headerIndex.get(header)
    if (index) values.push(row.getCell(index).value)
  }
  for (const header of citationColumnsClean(headers)) {
    const index = headerIndex.get(header)
    if (index) values.push(extractDoi(row.getCell(index).value))
  }
  return new Set(values.map(normalize).filter(Boolean))
}

async function readJsonRecords(
  jsonDir: string,
): Promise<{
  filesRead: number
  records: { source: string; record: RecordObject }[]
  issues: LiteratureExcelOutput['issues']
}> {
  const entries = await readdir(jsonDir, { withFileTypes: true })
  const jsonFiles = entries
    .filter(entry => entry.isFile() && extname(entry.name).toLowerCase() === '.json')
    .map(entry => entry.name)
    .sort()

  const records: { source: string; record: RecordObject }[] = []
  const issues: LiteratureExcelOutput['issues'] = []

  for (const file of jsonFiles) {
    try {
      const parseResult = parseShardJson(await readFile(join(jsonDir, file), 'utf8'))
      if (parseResult.parsed === undefined) {
        issues.push({
          source: file,
          message: `Failed to parse JSON${parseResult.repaired ? ' after repair attempt' : ''}: ${parseResult.error}`,
        })
        continue
      }
      if (parseResult.repaired) {
        issues.push({
          source: file,
          message: 'Repaired likely unescaped quotes inside JSON strings before merging.',
        })
      }
      const parsed = parseResult.parsed
      const fileRecords = Array.isArray(parsed)
        ? parsed
        : typeof parsed === 'object' && parsed !== null
          ? ((parsed as { records?: unknown }).records ?? [])
          : []
      const fileIssues =
        typeof parsed === 'object' && parsed !== null
          ? ((parsed as { issues?: unknown }).issues ?? [])
          : []

      if (!Array.isArray(fileRecords)) {
        issues.push({ source: file, message: 'records is not an array' })
        continue
      }

      for (const record of fileRecords) {
        if (typeof record === 'object' && record !== null && !Array.isArray(record)) {
          records.push({ source: file, record: record as RecordObject })
        } else {
          issues.push({ source: file, message: 'Skipped non-object record' })
        }
      }

      if (Array.isArray(fileIssues)) {
        for (const issue of fileIssues) {
          issues.push({
            source: file,
            message:
              typeof issue === 'object' && issue !== null
                ? JSON.stringify(issue)
                : String(issue),
          })
        }
      }
    } catch (error) {
      issues.push({
        source: file,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { filesRead: jsonFiles.length, records, issues }
}

function validateRecord(record: RecordObject, headers: string[]): string | null {
  const hasStrongIdentifier = [
    ...titleColumnsClean(headers),
    ...citationColumnsClean(headers),
    ...doiColumns(headers),
  ].some(header => normalize(valueForClean(record, header)))
  const hasSourceIdentifier = sourceColumnsClean(headers).some(header =>
    normalize(valueForClean(record, header)),
  )
  const meaningfulNonSourceValues = headers.filter(
    header =>
      serialColumnsClean([header]).length === 0 &&
      sourceColumnsClean([header]).length === 0 &&
      normalize(valueForClean(record, header)),
  )
  const hasIdentifier = hasStrongIdentifier || hasSourceIdentifier
  if (!hasIdentifier) {
    return 'Missing identifier field such as title, citation, DOI, or PDF filename'
  }
  if (!hasStrongIdentifier && meaningfulNonSourceValues.length < 2) {
    return 'Only PDF filename/source and too few extracted fields were provided; skipped likely empty extraction record'
  }
  return null
}

function normalizeColumns(columns: string[] | undefined): string[] {
  return [...new Set((columns ?? []).map(column => column.trim()).filter(Boolean))]
}

function escapeLikelyUnescapedStringQuotes(content: string): string {
  let repaired = ''
  let inString = false
  let escaped = false

  for (let index = 0; index < content.length; index++) {
    const char = content[index]
    if (!inString) {
      if (char === '"') inString = true
      repaired += char
      continue
    }
    if (escaped) {
      repaired += char
      escaped = false
      continue
    }
    if (char === '\\') {
      repaired += char
      escaped = true
      continue
    }
    if (char === '"') {
      let lookahead = index + 1
      while (lookahead < content.length && /\s/.test(content[lookahead] ?? '')) {
        lookahead++
      }
      const next = content[lookahead]
      if (next === ':' || next === ',' || next === '}' || next === ']' || next === undefined) {
        inString = false
        repaired += char
      } else {
        repaired += '\\"'
      }
      continue
    }
    repaired += char
  }

  return repaired
}

function parseShardJson(content: string): {
  parsed?: unknown
  repaired: boolean
  error?: string
} {
  try {
    return { parsed: JSON.parse(content), repaired: false }
  } catch (firstError) {
    const repairedContent = escapeLikelyUnescapedStringQuotes(content)
    try {
      return { parsed: JSON.parse(repairedContent), repaired: true }
    } catch (secondError) {
      return {
        repaired: repairedContent !== content,
        error:
          secondError instanceof Error
            ? secondError.message
            : firstError instanceof Error
              ? firstError.message
              : String(secondError),
      }
    }
  }
}

async function loadWorkbook(
  existingPath: string | undefined,
  requestedColumns: string[] | undefined,
): Promise<{
  workbook: ExcelJS.Workbook
  worksheet: ExcelJS.Worksheet
  headers: string[]
  existingRows: number
}> {
  const workbook = new ExcelJS.Workbook()
  if (existingPath) {
    await workbook.xlsx.readFile(existingPath)
    const worksheet = workbook.worksheets[0]
    if (!worksheet) throw new Error('Existing workbook has no worksheets')
    const headers = worksheet.getRow(1).values
    const existingHeaders = Array.isArray(headers)
      ? headers.slice(1).map(value => String(value ?? '')).filter(Boolean)
      : []
    return {
      workbook,
      worksheet,
      headers:
        existingHeaders.length > 0
          ? existingHeaders
          : normalizeColumns(requestedColumns),
      existingRows: Math.max(0, worksheet.rowCount - 1),
    }
  }

  const headers = normalizeColumns(requestedColumns)
  const worksheet = workbook.addWorksheet('文献提取')
  worksheet.addRow(headers)
  return { workbook, worksheet, headers, existingRows: 0 }
}

function applyWorksheetFormatting(worksheet: ExcelJS.Worksheet, headers: string[]) {
  worksheet.getRow(1).font = { bold: true }
  worksheet.eachRow(row => {
    row.alignment = { vertical: 'top', wrapText: true }
  })
  headers.forEach((header, index) => {
    const column = worksheet.getColumn(index + 1)
    column.width = serialColumnsClean([header]).length > 0
      ? 12
      : titleColumnsClean([header]).length > 0 ||
          citationColumnsClean([header]).length > 0 ||
          ['摘要', '结论', '主要结论', '结果', '主要结果', '证据摘录', '备注'].includes(header)
        ? 48
        : 24
  })
}

function expandPath(p: string): string {
  if (p.startsWith('~')) return join(homedir(), p.slice(1))
  if (!isAbsolute(p)) return join(process.cwd(), p)
  return p
}

function isENOENT(e: unknown): boolean {
  return e instanceof Error && 'code' in e && (e as { code?: string }).code === 'ENOENT'
}

export async function validateLiteratureInput(input: {
  json_dir: string
  output_path: string
  existing_excel_path?: string
  columns?: string[]
}): Promise<string | null> {
  const jsonDir = expandPath(input.json_dir)
  const outputPath = expandPath(input.output_path)
  const existingPath = input.existing_excel_path
    ? expandPath(input.existing_excel_path)
    : undefined

  const jsonDirStat = await stat(jsonDir).catch(error => {
    if (isENOENT(error)) return null
    throw error
  })
  if (!jsonDirStat?.isDirectory()) {
    return 'json_dir must be an existing directory.'
  }

  if (existingPath) {
    const existingStat = await stat(existingPath).catch(error => {
      if (isENOENT(error)) return null
      throw error
    })
    if (!existingStat?.isFile()) {
      return 'existing_excel_path must be an existing file when provided.'
    }
  } else if (normalizeColumns(input.columns).length === 0) {
    return 'columns is required when no existing_excel_path is provided.'
  }

  if (extname(outputPath).toLowerCase() !== '.xlsx') {
    return 'output_path must end with .xlsx.'
  }

  return null
}

export async function literatureExcel(input: {
  columns?: string[]
  json_dir: string
  output_path: string
  existing_excel_path?: string
  renumber?: boolean
}): Promise<LiteratureExcelOutput> {
  const jsonDir = expandPath(input.json_dir)
  const outputPath = expandPath(input.output_path)
  const existingPath = input.existing_excel_path
    ? expandPath(input.existing_excel_path)
    : undefined

  const { workbook, worksheet, headers, existingRows } = await loadWorkbook(
    existingPath,
    input.columns,
  )
  const { filesRead, records, issues } = await readJsonRecords(jsonDir)

  const seen = new Set<string>()
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
    for (const key of keysForWorksheetRow(worksheet, rowNumber, headers)) {
      seen.add(key)
    }
  }

  let rowsAdded = 0
  let duplicatesSkipped = 0
  let invalidRecordsSkipped = 0

  for (const { source, record } of records) {
    const validationError = validateRecord(record, headers)
    if (validationError) {
      invalidRecordsSkipped++
      issues.push({ source, message: validationError })
      continue
    }

    const keys = keysForRecord(record, headers)
    if (keys.size > 0 && [...keys].some(key => seen.has(key))) {
      duplicatesSkipped++
      const title = titleColumnsClean(headers)
        .map(header => String(valueForClean(record, header) ?? '').trim())
        .find(Boolean)
      const sourceName = sourceColumnsClean(headers)
        .map(header => String(valueForClean(record, header) ?? '').trim())
        .find(Boolean)
      issues.push({
        source,
        message: `Skipped duplicate record${title ? `: ${title}` : sourceName ? ` from ${sourceName}` : ''}`,
      })
      continue
    }

    const nextIndex = worksheet.rowCount
    const row = headers.map(header => {
      if (serialColumnsClean([header]).length > 0 && !record[header]) return nextIndex
      return stringifyCellValue(valueForClean(record, header))
    })
    worksheet.addRow(row)
    rowsAdded++
    for (const key of keys) seen.add(key)
  }

  if (input.renumber !== false) {
    const serialIndex = headers.findIndex(header => serialColumnsClean([header]).length > 0)
    if (serialIndex >= 0) {
      for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
        worksheet.getRow(rowNumber).getCell(serialIndex + 1).value = rowNumber - 1
      }
    }
  }

  applyWorksheetFormatting(worksheet, headers)
  await mkdir(dirname(outputPath), { recursive: true })
  await workbook.xlsx.writeFile(outputPath)

  return {
    outputPath,
    columns: headers,
    jsonFilesRead: filesRead,
    existingRowsPreserved: existingRows,
    rowsAdded,
    duplicatesSkipped,
    invalidRecordsSkipped,
    issues,
  }
}

export function formatLiteratureExcelOutput(output: LiteratureExcelOutput): string {
  const lines = [
    `Output: ${output.outputPath}`,
    `Columns: ${output.columns.join(', ')}`,
    `JSON files read: ${output.jsonFilesRead}`,
    `Existing rows preserved: ${output.existingRowsPreserved}`,
    `Rows added: ${output.rowsAdded}`,
    `Duplicates skipped: ${output.duplicatesSkipped}`,
    `Invalid records skipped: ${output.invalidRecordsSkipped}`,
  ]
  if (output.issues.length > 0) {
    lines.push('Issues:')
    for (const issue of output.issues.slice(0, 20)) {
      lines.push(`- ${issue.source}: ${issue.message}`)
    }
    if (output.issues.length > 20) {
      lines.push(`- ... ${output.issues.length - 20} more`)
    }
  }
  return lines.join('\n')
}
