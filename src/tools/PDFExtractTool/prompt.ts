export const DESCRIPTION =
  'Extract embedded text from a PDF in bounded page and character ranges.'

export function getPrompt(): string {
  return `Extract embedded text from PDF files in bounded chunks.

Use this before asking an agent to analyze a PDF, especially for large literature files that may not fit in one read.

Inputs:
- pdf_path: absolute path to a PDF file.
- start_page: 1-based page number to start reading. Defaults to 1.
- max_pages: maximum pages to read in this call. Defaults to 5.
- max_chars: maximum total text characters to return in this call. Defaults to 50000.
Behavior:
- Reads embedded PDF text page by page using bundled app dependencies.
- Returns page_count, pages, warnings, and next_page when more pages remain.
- Truncates safely at max_chars and tells the caller where to continue.
- Does not perform OCR. If a scanned PDF has no embedded text, pages may be blank and warnings will explain that OCR is currently not enabled.`
}
