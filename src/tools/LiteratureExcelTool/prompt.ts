export const DESCRIPTION =
  'Merge literature-extraction JSON records into a structured Excel workbook.'

export function getPrompt(): string {
  return `Merge JSON records produced by literature-extraction agents into an .xlsx workbook.

Use this after subagents have written their JSON outputs into the same directory.

Inputs:
- columns: ordered Excel columns from the normalized field specification. Required unless existing_excel_path already has headers.
- json_dir: absolute directory containing one or more .json files. Each file may be { records, issues } or an array of record objects.
- output_path: absolute path for the generated .xlsx file.
- existing_excel_path: optional absolute path to an existing workbook to preserve and append to.

Behavior:
- Reads all .json files directly inside json_dir.
- Preserves an existing workbook's headers and rows when existing_excel_path is provided.
- Writes only the requested columns or existing Excel headers.
- Treats common source fields such as "文献", "pdf原文", and "PDF文件" as aliases for duplicate detection.
- Skips duplicates by normalized title-like fields, citation-like fields, DOI, or PDF filename.
- Leaves missing fields blank; it does not invent values.
- Writes the final .xlsx using bundled app dependencies, not system Python or Office.`
}
