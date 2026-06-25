import { readFile } from 'fs/promises'
import { extname } from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isENOENT } from '../../utils/errors.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { expandPath } from '../../utils/path.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { PDF_EXTRACT_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

const DEFAULT_MAX_PAGES = 5
const DEFAULT_MAX_CHARS = 50_000

const inputSchema = lazySchema(() =>
  z.strictObject({
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
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
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
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

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

export const PDFExtractTool = buildTool({
  name: PDF_EXTRACT_TOOL_NAME,
  searchHint: 'extract PDF text by page range',
  maxResultSizeChars: 250_000,
  strict: true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  userFacingName() {
    return 'PDFExtract'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  shouldDefer: false,
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  getPath(input: Input): string {
    return input.pdf_path
  },
  backfillObservableInput(input: Input) {
    input.pdf_path = expandPath(input.pdf_path)
  },
  async preparePermissionMatcher({ pdf_path }) {
    return pattern => matchWildcardPattern(pattern, pdf_path)
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    return checkReadPermissionForTool(
      PDFExtractTool,
      input,
      context.getAppState().toolPermissionContext,
    )
  },
  async validateInput(input) {
    const fs = getFsImplementation()
    const pdfPath = expandPath(input.pdf_path)
    const stat = await fs.stat(pdfPath).catch(error => {
      if (isENOENT(error)) return null
      throw error
    })
    if (!stat?.isFile()) {
      return {
        result: false,
        message: 'pdf_path must be an existing PDF file.',
        errorCode: 1,
      }
    }
    if (extname(pdfPath).toLowerCase() !== '.pdf') {
      return {
        result: false,
        message: 'pdf_path must end with .pdf.',
        errorCode: 2,
      }
    }
    return { result: true }
  },
  renderToolUseMessage(input) {
    return `Extracting PDF text from ${input.pdf_path}`
  },
  renderToolUseRejectedMessage() {
    return 'PDF extraction rejected'
  },
  renderToolUseErrorMessage() {
    return 'PDF extraction failed'
  },
  renderToolResultMessage(output: Output) {
    const next = output.nextPage ? `, next page ${output.nextPage}` : ''
    return `Read PDF pages ${output.startPage}-${output.endPage} of ${output.pageCount} (${output.totalChars} chars${next})`
  },
  async call(input): Promise<{ data: Output }> {
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
        data: {
          pdfPath,
          pageCount,
          startPage,
          endPage: pageCount,
          nextPage: null,
          truncated: false,
          totalChars: 0,
          pages: [],
          warnings: [`start_page ${startPage} is after the final page ${pageCount}.`],
        },
      }
    }

    const pages: Output['pages'] = []
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
      data: {
        pdfPath,
        pageCount,
        startPage,
        endPage,
        nextPage,
        truncated,
        totalChars,
        pages,
        warnings,
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const output = content as Output
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
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: lines.join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
