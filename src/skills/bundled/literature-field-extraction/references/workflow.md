# Workflow

Read this file before processing more than 5 PDFs, spawning subagents, or performing incremental Excel updates.

## Input Inventory

1. Count PDFs.
2. Identify the user-provided field specification.
3. Identify existing Excel files and their headers.
4. Normalize the field specification into a target `columns` array and field-by-field extraction contract.
5. Pair attachment folders with Excel files by name when possible.
6. Warn the user before extraction that scanned/image-only PDFs cannot currently be processed because OCR is disabled. Continue with text-layer PDFs unless the user says to stop.

## Parallel Sharding

Use at most 10 subagents. Each subagent may process at most 3 PDFs. If there are more than 30 PDFs, process them in multiple waves and merge each wave's JSON files after they complete.

Before using task tools, load the schema for each task tool. Call `ToolSearch` before the first use of every task tool, for example `select:TaskCreate`, `select:TaskUpdate`, `select:TaskGet`, `select:TaskList`, `select:TaskOutput`, and `select:TaskStop`. Use the discovered schema exactly; the task name/title parameter is `subject`, not `title`, and task IDs use `taskId`, not `task_id`. Do not guess task parameters from memory. If the task tools are not loaded or fail schema validation, fall back to direct `Agent` calls.

Before spawning subagents, create or choose one shared JSON output directory, for example `<output-dir>/literature-json/`. Each subagent must write exactly one `.json` file directly inside this directory. Use stable shard filenames such as `shard-01.json`, `shard-02.json`, and so on.

Suggested shard count:

- 1-5 PDFs: no subagent required unless the user explicitly wants parallel work.
- 6-9 PDFs: 2-3 subagents.
- 10-18 PDFs: 4-6 subagents.
- 19-30 PDFs: 7-10 subagents.
- More than 30 PDFs: 10 subagents per wave, then continue with the next wave.

Shard rules:

- Give each PDF to exactly one subagent.
- Give each subagent at most 3 PDFs.
- Do not assign the same PDF to multiple subagents in the same wave unless deliberately checking duplicates. Build the shard list once and verify each PDF appears in exactly one shard.
- Group very large or scanned PDFs separately.
- Use `subagent_type: "general-purpose"` for every extraction subagent.
- Include the normalized extraction contract and target `columns` array in each subagent prompt.
- Tell subagents to use `PDFExtract` with bounded `start_page`, `max_pages`, and `max_chars` values instead of shell PDF utilities.
- Tell subagents that OCR is disabled. If PDFExtract reports empty scanned/image-only pages, they must add an issue and leave unverifiable fields blank.
- Ask subagents to write JSON only into the shared JSON output directory; no Excel editing.
- Do not accept records returned only in the subagent final response. The main agent must verify the assigned JSON file exists before merging.
- Ask subagents to leave unknown values blank and record issues.

Subagent prompt template:

```text
Extract structured records from this PDF shard using the extraction contract below.

Use subagent_type: general-purpose.

Write one JSON object with keys records and issues to this exact file:
<json_output_dir>/shard-NN.json

Rules:
- Use the column names exactly as provided.
- Read PDFs with PDFExtract. Start with early pages for title/metadata, then jump to sections needed by the field contract when possible. For long PDFs, continue from nextPage rather than reading the whole file at once.
- If PDFExtract reports a scanned/image-only page, do not retry OCR. Add an issue and continue with the next readable PDF.
- You must write the JSON result to the exact shard file with Write.
- Your final response must not paste the full JSON. Return only: written file path, record count, issue count, and any blocking errors.
- Do not create or edit Excel.
- Do not invent missing values.
- Leave unverifiable fields blank.
- Include PDF filename and evidence notes when possible.

PDF shard:
- <paths>

Extraction contract:
<normalized field specification>
```

Task tool reminder: if wrapping this prompt in task tools, ensure the matching `ToolSearch select:<TaskToolName>` has already been called. Use `subject` for task labels and `taskId` for task IDs.

## PDF Text Extraction

Use `PDFExtract` as the default production path. It reads embedded PDF text in bounded chunks and returns `nextPage` when more pages remain.

Recommended order:

1. Call `PDFExtract` on the first pages to capture title, authors, journal/source, abstract, and table of contents if present.
2. For large PDFs, use `start_page` and `nextPage` to read only the pages needed for the requested fields.
3. If text is empty, sparse, or garbled, mark the PDF as likely scanned/image-only.
4. OCR is disabled in the current workflow. Do not call OCR tools or repeatedly retry large scanned PDFs.
5. Use filename plus readable metadata only for low-confidence source fields, leave unverifiable fields blank, and add an `issues` entry.
6. Never infer numeric results, DOI, impact factor, society, recommendation text, or sample sizes from filename alone.

## Incremental Excel Update

When the user provides an existing Excel:

1. Read headers and existing rows.
2. Use existing headers as the default `columns` array unless the user asks to change columns.
3. Compare the field specification with existing headers and report any mismatch before extraction if it could corrupt the table.
4. Build duplicate keys from likely identifiers:
   - normalized title-like fields such as `题目`, `标题`, `Title`
   - DOI
   - normalized citation-like fields
   - normalized PDF filename/source fields
5. Extract new PDFs to shard JSON files in the shared JSON output directory. Verify the files exist before merging.
6. Use `LiteratureExcel` with `existing_excel_path`, `json_dir`, `output_path`, and `columns` to skip exact duplicates and append new records.
7. Report possible duplicates separately when title similarity is high but not exact.
8. Append new rows after existing rows.
9. Re-number a serial-number column only if it exists and the user asked to renumber or the new appended rows need automatic numbering.
10. Aggregate all subagent `issues` into the final report; do not silently discard warnings.

## Duplicate Policy

Treat records as duplicates when any of these match:

- Same normalized title-like field.
- Same DOI.
- Same PDF filename/source field.
- Same citation after whitespace and punctuation normalization.

Possible duplicate when:

- Title similarity is high but punctuation/subtitle differs.
- PDF filename is coded, but extracted title matches an existing row approximately.

## Validation

Before writing final Excel:

- Confirm column order matches the normalized `columns` array or existing Excel headers.
- Confirm each record has at least one meaningful identifier, such as title, citation, DOI, or PDF filename.
- Confirm controlled-vocabulary fields use allowed values when specified.
- Confirm dates and numeric values are not obviously impossible.
- Confirm generated citations do not include fabricated DOI/pages.
- Confirm Chinese text and non-English text are preserved as UTF-8.
- Review subagent `issues` and distinguish extraction errors from normal blanks.

After writing final Excel, reopen or inspect the workbook and perform a strict whole-table check:

- Confirm column order and count exactly match the normalized `columns` array or existing Excel headers.
- Confirm serial-number columns are globally continuous after merge.
- Confirm there are no rows that contain only a PDF filename/source with all meaningful fields blank.
- Confirm exact duplicates were skipped and near duplicates are reported.
- Confirm no row has obvious field shifts, such as citations in title fields or result paragraphs in date fields.
- Confirm scanned/OCR rows are not silently empty; they must either contain OCR-derived fields or a clear issue entry.
- Correct clear merge/formatting problems before delivering the workbook.

## Final Report

Tell the user:

- Output Excel path.
- Number of existing rows preserved.
- Number of new rows added.
- Number of duplicates skipped.
- PDFs with extraction errors.
- Important fields left blank because they could not be verified.
- Any changes the main agent made while normalizing the field specification.
