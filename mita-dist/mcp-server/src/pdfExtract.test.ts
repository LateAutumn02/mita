import { mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, test } from 'bun:test'
import { pdfExtract } from './pdfExtract.js'

const SIMPLE_PDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length 77 >>
stream
BT
/F1 24 Tf
72 720 Td
(Hello PDFExtract literature title) Tj
ET
endstream
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000241 00000 n 
0000000311 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
438
%%EOF
`

const BLANK_PDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>
endobj
xref
0 4
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
trailer
<< /Size 4 /Root 1 0 R >>
startxref
204
%%EOF
`

test('PDFExtract extracts embedded text from a bounded page range', async () => {
  const dir = join(tmpdir(), `pdf-extract-${Date.now()}`)
  await mkdir(dir, { recursive: true })
  const pdfPath = join(dir, 'sample.pdf')
  await writeFile(pdfPath, SIMPLE_PDF, 'utf8')

  const result = await pdfExtract({
    pdf_path: pdfPath,
    start_page: 1,
    max_pages: 1,
    max_chars: 1000,
  })

  expect(result.pageCount).toBe(1)
  expect(result.pages).toHaveLength(1)
  expect(result.pages[0]?.text).toContain('Hello PDFExtract literature title')
  expect(result.nextPage).toBeNull()
})

test('PDFExtract reports out-of-range start pages without throwing', async () => {
  const dir = join(tmpdir(), `pdf-extract-${Date.now()}-range`)
  await mkdir(dir, { recursive: true })
  const pdfPath = join(dir, 'sample.pdf')
  await writeFile(pdfPath, SIMPLE_PDF, 'utf8')

  const result = await pdfExtract({
    pdf_path: pdfPath,
    start_page: 5,
    max_pages: 1,
  })

  expect(result.pageCount).toBe(1)
  expect(result.pages).toHaveLength(0)
  expect(result.warnings[0]).toContain('after the final page')
})

test('PDFExtract reports empty embedded text pages without OCR retrying', async () => {
  const dir = join(tmpdir(), `pdf-extract-${Date.now()}-ocr`)
  await mkdir(dir, { recursive: true })
  const pdfPath = join(dir, 'blank.pdf')
  await writeFile(pdfPath, BLANK_PDF, 'utf8')

  const result = await pdfExtract({
    pdf_path: pdfPath,
    start_page: 1,
    max_pages: 1,
    max_chars: 1000,
  })

  expect(result.pages).toHaveLength(1)
  expect(result.pages[0]?.text).toBe('')
  expect(result.warnings.some(warning => warning.includes('OCR is currently not enabled'))).toBe(true)
})
