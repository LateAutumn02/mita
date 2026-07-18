import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod/v4'
import {
  pdfExtract,
  formatPdfExtractOutput,
  validatePdfPath,
  pdfExtractOutputSchema,
  type PdfExtractOutput,
} from './pdfExtract.js'
import {
  literatureExcel,
  formatLiteratureExcelOutput,
  validateLiteratureInput,
  literatureExcelOutputSchema,
  type LiteratureExcelOutput,
} from './literatureExcel.js'

const server = new McpServer(
  { name: 'literature', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

server.registerTool(
  'PDFExtract',
  {
    description: 'Extract embedded text from a PDF in bounded page and character ranges.',
    inputSchema: {
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
    },
    outputSchema: pdfExtractOutputSchema,
    _meta: { 'anthropic/alwaysLoad': true },
  },
  async (args) => {
    try {
      const input = args as {
        pdf_path: string
        start_page?: number
        max_pages?: number
        max_chars?: number
      }
      const pathError = validatePdfPath(input.pdf_path)
      if (pathError) {
        return {
          isError: true,
          content: [{ type: 'text', text: pathError }],
        }
      }
      const result: PdfExtractOutput = await pdfExtract(input)
      return {
        content: [{ type: 'text', text: formatPdfExtractOutput(result) }],
      }
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      }
    }
  },
)

server.registerTool(
  'LiteratureExcel',
  {
    description:
      'Merge subagent JSON records into a literature extraction .xlsx workbook, skipping duplicates and preserving existing rows.',
    inputSchema: {
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
    },
    outputSchema: literatureExcelOutputSchema,
    _meta: { 'anthropic/alwaysLoad': true },
  },
  async (args) => {
    try {
      const input = args as {
        columns?: string[]
        json_dir: string
        output_path: string
        existing_excel_path?: string
        renumber?: boolean
      }
      const validationError = await validateLiteratureInput(input)
      if (validationError) {
        return {
          isError: true,
          content: [{ type: 'text', text: validationError }],
        }
      }
      const result: LiteratureExcelOutput = await literatureExcel(input)
      return {
        content: [{ type: 'text', text: formatLiteratureExcelOutput(result) }],
      }
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      }
    }
  },
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(error => {
  console.error('[mita-mcp-server] fatal:', error)
  process.exit(1)
})
