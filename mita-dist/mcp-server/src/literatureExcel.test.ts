import { mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, test } from 'bun:test'
import ExcelJS from 'exceljs'
import { literatureExcel } from './literatureExcel.js'

const columns = ['序号', '题目', '发表年份', '主要结论', 'PDF文件']

function record(title: string, pdf: string): Record<string, string> {
  return {
    题目: title,
    发表年份: '2026',
    主要结论: `${title} conclusion`,
    PDF文件: pdf,
  }
}

test('LiteratureExcel writes generic JSON records to xlsx with requested columns', async () => {
  const dir = join(tmpdir(), `literature-excel-${Date.now()}-write`)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'shard-01.json'),
    JSON.stringify({
      records: [record('测试文献题目', 'test.pdf')],
      issues: [],
    }),
    'utf8',
  )

  const outputPath = join(dir, 'out.xlsx')
  const result = await literatureExcel({
    columns,
    json_dir: dir,
    output_path: outputPath,
  })

  expect(result.rowsAdded).toBe(1)
  expect(result.invalidRecordsSkipped).toBe(0)
  expect(result.columns).toEqual(columns)

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(outputPath)
  const sheet = workbook.worksheets[0]
  expect(sheet.getRow(1).getCell(3).value).toBe('发表年份')
  expect(sheet.getRow(2).getCell(2).value).toBe('测试文献题目')
})

test('LiteratureExcel preserves existing rows and skips duplicates', async () => {
  const dir = join(tmpdir(), `literature-excel-${Date.now()}-incremental`)
  const firstJsonDir = join(dir, 'first')
  const secondJsonDir = join(dir, 'second')
  await mkdir(firstJsonDir, { recursive: true })
  await mkdir(secondJsonDir, { recursive: true })

  await writeFile(
    join(firstJsonDir, 'shard-01.json'),
    JSON.stringify({
      records: [record('A title', 'a.pdf')],
      issues: [],
    }),
    'utf8',
  )

  const existingPath = join(dir, 'existing.xlsx')
  await literatureExcel({
    columns,
    json_dir: firstJsonDir,
    output_path: existingPath,
  })

  await writeFile(
    join(secondJsonDir, 'shard-01.json'),
    JSON.stringify({
      records: [record('A title', 'a-copy.pdf'), record('B title', 'b.pdf')],
      issues: [],
    }),
    'utf8',
  )

  const result = await literatureExcel({
    columns,
    json_dir: secondJsonDir,
    existing_excel_path: existingPath,
    output_path: join(dir, 'updated.xlsx'),
  })

  expect(result.existingRowsPreserved).toBe(1)
  expect(result.rowsAdded).toBe(1)
  expect(result.duplicatesSkipped).toBe(1)
})

test('LiteratureExcel renumbers Chinese serial columns by default', async () => {
  const dir = join(tmpdir(), `literature-excel-${Date.now()}-renumber`)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'shard-01.json'),
    JSON.stringify({
      records: [
        { 序号: 9, 题目: 'First title', 文献: 'first.pdf' },
        { 序号: 2, 题目: 'Second title', 文献: 'second.pdf' },
      ],
      issues: [],
    }),
    'utf8',
  )

  const outputPath = join(dir, 'out.xlsx')
  await literatureExcel({
    columns: ['序号', '题目', '文献'],
    json_dir: dir,
    output_path: outputPath,
  })

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(outputPath)
  const sheet = workbook.worksheets[0]
  expect(sheet.getRow(2).getCell(1).value).toBe(1)
  expect(sheet.getRow(3).getCell(1).value).toBe(2)
})

test('LiteratureExcel skips source-only empty extraction records', async () => {
  const dir = join(tmpdir(), `literature-excel-${Date.now()}-empty-record`)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'shard-01.json'),
    JSON.stringify({
      records: [{ 序号: 1, 研究类型: '体外/药理试验', 题目: '', 结果: '', 文献: 'scan.pdf' }],
      issues: ['scan.pdf OCR failed'],
    }),
    'utf8',
  )

  const result = await literatureExcel({
    columns: ['序号', '研究类型', '题目', '结果', '文献'],
    json_dir: dir,
    output_path: join(dir, 'out.xlsx'),
  })

  expect(result.rowsAdded).toBe(0)
  expect(result.invalidRecordsSkipped).toBe(1)
  expect(result.issues.some(issue => issue.message.includes('too few extracted fields'))).toBe(true)
})
