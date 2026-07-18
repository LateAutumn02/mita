import { readFile } from 'fs/promises'
import { extname, isAbsolute, join } from 'path'
import { homedir } from 'os'
import { z } from 'zod/v4'

const DEFAULT_MAX_PAGES = 5
const DEFAULT_MAX_CHARS = 50_000

export const pdfExtractInputSchema = {
  pdf_path: z.string().describe('Absolute path to the PDF file.'),
  start_page: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('1-based page number to start reading. Defaults to 1.'),
  max_pages: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe('Maximum number of pages to read in this call. Defaults to 5.'),
  max_chars: z
    .number()
    .int()
    .positive()
    .max(200_000)
    .optional()
    .describe('Maximum total text characters to return. Defaults to 50000.'),
}

export const pdfExtractOutputSchema = z.object({
  pdfPath: z.string(),
  pageCount: z.number(),
  startPage: z.number(),
  endPage: z.number(),
  nextPage: z.number().nullable(),
  truncated: z.boolean(),
  totalChars: z.number(),
  pages: z.array(
    z.object({
      page: z.number(),
      text: z.string(),
      charCount: z.number(),
      truncated: z.boolean(),
    }),
  ),
  warnings: z.array(z.string()),
})

export type PdfExtractOutput = z.infer<typeof pdfExtractOutputSchema>

type TextItem = { str?: string; hasEOL?: boolean }
type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
type PdfJsWorker = typeof import('pdfjs-dist/legacy/build/pdf.worker.mjs')

function ensurePdfJsDomPolyfills() {
  const global = globalThis as typeof globalThis & {
    DOMMatrix?: unknown
    ImageData?: unknown
    Path2D?: unknown
  }
  global.DOMMatrix ??= class DOMMatrix {
    a = 1
    b = 0
    c = 0
    d = 1
    e = 0
    f = 0
    constructor(_init?: unknown) {}
    multiplySelf() {
      return this
    }
    preMultiplySelf() {
      return this
    }
    translateSelf() {
      return this
    }
    scaleSelf() {
      return this
    }
    rotateSelf() {
      return this
    }
    invertSelf() {
      return this
    }
  }
  global.ImageData ??= class ImageData {
    data: Uint8ClampedArray
    constructor(
      dataOrWidth: Uint8ClampedArray | number,
      public width?: number,
      public height?: number,
    ) {
      this.data =
        dataOrWidth instanceof Uint8ClampedArray
          ? dataOrWidth
          : new Uint8ClampedArray(dataOrWidth * (width ?? 0) * 4)
      if (typeof dataOrWidth === 'number') {
        this.width = dataOrWidth
      }
    }
  }
  global.Path2D ??= class Path2D {}
}

async function loadPdfJs(): Promise<PdfJs> {
  ensurePdfJsDomPolyfills()
  const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
  ;(globalThis as typeof globalThis & { pdfjsWorker?: PdfJsWorker }).pdfjsWorker =
    worker
  return await import('pdfjs-dist/legacy/build/pdf.mjs')
}

function joinTextItems(items: TextItem[]): string {
  const parts: string[] = []
  for (const item of items) {
    if (!item.str) continue
    parts.push(item.str)
    parts.push(item.hasEOL ? '\n' : ' ')
  }
  return parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\s+$/g, '')
}

function expandPath(p: string): string {
  if (p.startsWith('~')) return join(homedir(), p.slice(1))
  if (!isAbsolute(p)) return join(process.cwd(), p)
  return p
}

export async function pdfExtract(input: {
  pdf_path: string
  start_page?: number
  max_pages?: number
  max_chars?: number
}): Promise<PdfExtractOutput> {
  const pdfPath = expandPath(input.pdf_path)
  const startPage = input.start_page ?? 1
  const maxPages = input.max_pages ?? DEFAULT_MAX_PAGES
  const maxChars = input.max_chars ?? DEFAULT_MAX_CHARS
  const buffer = await readFile(pdfPath)
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const { getDocument } = await loadPdfJs()
  const loadingTask = getDocument({
    data,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true,
  })
  const pdf = await loadingTask.promise
  const pageCount = pdf.numPages
  const warnings: string[] = []

  if (startPage > pageCount) {
    await loadingTask.destroy()
    return {
      pdfPath,
      pageCount,
      startPage,
      endPage: pageCount,
      nextPage: null,
      truncated: false,
      totalChars: 0,
      pages: [],
      warnings: [`start_page ${startPage} is after the final page ${pageCount}.`],
    }
  }

  const pages: PdfExtractOutput['pages'] = []
  let totalChars = 0
  let endPage = startPage - 1
  let truncated = false
  const lastRequestedPage = Math.min(pageCount, startPage + maxPages - 1)

  for (let pageNumber = startPage; pageNumber <= lastRequestedPage; pageNumber++) {
    const page = await pdf.getPage(pageNumber)
    const textContent = await page.getTextContent()
    const text = joinTextItems(textContent.items as TextItem[])
    if (text.trim().length === 0) {
      warnings.push(
        `Page ${pageNumber} has no embedded text; it may be scanned or image-only. OCR is currently not enabled in PDFExtract.`,
      )
    }

    const remainingChars = maxChars - totalChars
    if (remainingChars <= 0) {
      truncated = true
      break
    }

    const pageText =
      text.length > remainingChars ? text.slice(0, remainingChars) : text
    const pageTruncated = pageText.length < text.length
    pages.push({
      page: pageNumber,
      text: pageText,
      charCount: pageText.length,
      truncated: pageTruncated,
    })
    totalChars += pageText.length
    endPage = pageNumber

    if (pageTruncated) {
      truncated = true
      break
    }
  }

  const nextPage =
    truncated || endPage < pageCount
      ? Math.min(pageCount, Math.max(endPage + 1, startPage))
      : null

  return {
    pdfPath,
    pageCount,
    startPage,
    endPage,
    nextPage,
    truncated,
    totalChars,
    pages,
    warnings,
  }
}

export function validatePdfPath(pdfPath: string): string | null {
  const expanded = expandPath(pdfPath)
  if (extname(expanded).toLowerCase() !== '.pdf') {
    return 'pdf_path must end with .pdf.'
  }
  return null
}

export function formatPdfExtractOutput(output: PdfExtractOutput): string {
  const lines = [
    `PDF: ${output.pdfPath}`,
    `Pages: ${output.startPage}-${output.endPage} of ${output.pageCount}`,
    `Chars: ${output.totalChars}`,
    output.nextPage ? `Next page: ${output.nextPage}` : 'Next page: none',
  ]
  if (output.warnings.length > 0) {
    lines.push('Warnings:')
    for (const warning of output.warnings.slice(0, 20)) {
      lines.push(`- ${warning}`)
    }
  }
  for (const page of output.pages) {
    lines.push(`\n## Page ${page.page}${page.truncated ? ' (truncated)' : ''}`)
    lines.push(page.text)
  }
  return lines.join('\n')
}
