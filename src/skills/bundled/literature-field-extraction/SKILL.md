---
name: literature-field-extraction
description: Review and normalize a user-provided literature field specification, then extract structured fields from batches of PDF literature into subagent JSON files and merge them into Excel. Use when Codex needs to process multiple papers, guidelines, reports, or other literature PDFs according to a custom field requirement document, including incremental updates from an existing partial Excel.
---

# Literature Field Extraction

## Purpose

Use this skill to turn a batch of literature PDFs plus a user-provided field specification into a structured Excel workbook.

The skill is domain-neutral. Do not assume a fixed topic, disease area, drug, or column schema. The user supplies the topic and field requirements; the main agent first reviews and normalizes those requirements so subagents can follow them consistently.

Assume the end user is on Windows by default. Use Windows path conventions in examples and prompts unless the user explicitly provides another operating system. Do not ask users to install Linux/macOS command-line utilities.

At the start of the task, tell the user that scanned/image-only PDFs cannot currently be processed because OCR is disabled. Ask for text-layer PDFs or OCR-processed PDFs if the batch contains scans. Continue with readable PDFs unless the user says to stop.

## Core Workflow

1. Inventory inputs.
   - List PDFs, existing Excel files, attachment folders, and the field specification document.
   - If an existing Excel is provided, read its headers and use them as strong evidence for the intended columns.
   - Read `references/schema-review.md` before rewriting or normalizing the field specification.

2. Review and normalize the field specification.
   - Produce a concise extraction contract for subagents.
   - Preserve the user's intended fields, but make names, requiredness, allowed values, examples, and blank-value rules explicit.
   - Prefer one stable column name per field.
   - If an existing Excel or official sample workbook is provided, use its populated/blank patterns as strong style guidance. A column that exists but is consistently blank in the sample should default to blank unless the user explicitly asks to fill it.
   - Identify source/provenance fields such as PDF filename, page, quote, DOI, citation, or evidence note when useful.
   - Ask the user only if the field specification is too ambiguous to extract reliably.

3. Choose processing strategy.
   - For 1-5 PDFs, the main agent may process directly only when the user wants a quick small-batch run.
   - For more than 5 PDFs, spawn `general-purpose` subagents.
   - Use at most 5 subagents concurrently.
   - Assign at most 3 PDFs to each extraction subagent.
   - Process PDFs in waves when needed. Start no more than 5 subagents at once; after a wave finishes and all JSON files exist, start the next wave.
   - This limited-shard policy balances speed and accuracy without creating too many parallel agents.
   - Read `references/workflow.md` before spawning subagents or doing incremental updates.
   - Before using task tools, first load each needed schema with `ToolSearch`, for example `select:TaskCreate`, `select:TaskUpdate`, `select:TaskGet`, `select:TaskOutput`, or `select:TaskStop`. Use the discovered schema exactly; task IDs use `taskId`, not `task_id`, and the task title field is `subject`, not `title`.

4. Delegate extraction.
   - Create one shared JSON output directory before spawning subagents, for example `<output-dir>/literature-json/`.
   - Each subagent receives at most 3 PDFs, the normalized extraction contract, the target column list, and any existing rows needed for duplicate checks.
   - Each subagent reads PDFs with `PDFExtract` in bounded page ranges. For large PDFs, continue from `nextPage` until the fields are extracted or the document has been sufficiently reviewed.
   - Each subagent may use `WebSearch` and `WebFetch` to verify or supplement fields that are not reliably available in the PDF, such as DOI, journal metadata, guideline source, publisher page, and impact factor. Web-derived fields must include source notes in `evidence` or `issues`.
   - Do not proactively fill journal metrics such as impact factor or quartile when the provided sample/existing Excel leaves that column blank. Fill these metrics only when the field specification explicitly requires them and a reliable source verifies the value and metric year.
   - Accuracy is more important than completeness. Do not fill DOI, impact factor, journal quartile, society/organization, recommendation text, sample size, numeric result, or citation details unless verified from the PDF or a reliable web source. If not verified, leave the field blank and record an issue.
   - If `PDFExtract` reports scanned/image-only pages, leave unverifiable fields blank and record the PDF in `issues`; do not spend time trying OCR in the current workflow.
   - Each subagent writes exactly one JSON file into the shared JSON output directory, for example `shard-01.json`, `shard-02.json`.
   - Each JSON file must contain one object with `records` and `issues`.
   - Do not accept extracted records returned only in the subagent's final message. If the JSON file is missing, ask that subagent to write the file before merging.

5. Merge and validate.
   - Combine subagent JSON outputs from the shared JSON output directory.
   - Use `LiteratureExcel` with the normalized `columns` list to merge JSON into the final `.xlsx`.
   - When an existing Excel is provided, pass it as `existing_excel_path` so existing rows are preserved and new rows are appended.
   - Name the final workbook predictably from the source folder/topic, for example `<topic-name>_文献提取结果.xlsx` for a new table or `<topic-name>_文献提取结果_增量更新.xlsx` for an incremental update. Do not use temporary names such as `f1.xlsx`, `result.xlsx`, or `output.xlsx` as the delivered filename.
   - After writing Excel, the main agent must reopen or inspect the whole table and strictly check column order, row count, serial numbers, duplicate rows, empty rows, obviously malformed dates/numbers, misplaced content, and unresolved issue rows. Correct clear formatting or merge problems before delivery.
   - Final quality inspection is owned by the main agent. Do not spawn a separate validation subagent by default.
   - Final inspection must primarily use the generated shard JSON files, their `issues`, the final Excel workbook, and the normalized field specification. Do not re-extract or re-read every PDF just to validate the table.
   - Reopen a PDF or use WebSearch/WebFetch during validation only for a specific suspicious field, conflict, missing evidence, or user-requested spot check.
   - After the final Excel files pass inspection, the main agent must clean up temporary artifacts it created, including shard JSON directories, intermediate normalized-spec files, scratch logs, temporary workbooks, and retry files. Preserve only the deliverable Excel workbook for each table, plus any original user inputs. If the workflow intentionally creates two deliverable Excel files, preserve those two Excel files and delete the rest of the generated byproducts.
   - Do not rely on system Python, Office, or user-installed PDF/Excel tools.

6. Deliver output.
   - Produce the final `.xlsx`.
   - Report rows added, duplicates skipped, invalid records skipped, unresolved PDFs, and important fields left blank.
   - If the main agent revised the field specification, summarize the meaningful changes.

## Resources

- `references/schema-review.md`: how to turn a loose user field document into a clear extraction contract.
- `references/workflow.md`: limited subagent sharding, shared JSON output rules, incremental update rules, duplicate policy, and final report requirements.

## Subagent Policy

When running inside cchaha, use cchaha's own `Agent` tool or task/agent orchestration capability to delegate PDF shards. Do not use Codex-only orchestration APIs as part of the product workflow.

If using `TaskCreate`/task tools instead of direct `Agent` calls, first call `ToolSearch` for every task tool before the first call to that tool, for example:

- `select:TaskCreate`
- `select:TaskUpdate`
- `select:TaskGet`
- `select:TaskList`
- `select:TaskOutput`
- `select:TaskStop`

Use the discovered schemas exactly. In particular, use `subject` for the task name; do not send a `title` parameter. Use `taskId` for task IDs; do not send `task_id`. If task schema discovery fails, use the already available `Agent` tool instead of guessing task parameters.

Use `subagent_type: "general-purpose"` for every extraction subagent. Use at most 5 subagents concurrently. Assign at most 3 PDFs to each extraction subagent. If more PDFs remain, process them in additional waves after the current wave finishes and its JSON files exist. Do not ask subagents to edit the same Excel file; they should produce JSON only.

Before spawning subagents, choose or create a single shared JSON output directory. Every subagent must write one `.json` file directly inside that directory. Use stable filenames such as `shard-01.json`; do not let multiple subagents write the same file.

Subagent JSON must be written to disk, not returned only as prose or pasted into the final message. Require this exact behavior in every subagent prompt:

- Use `PDFExtract` to read assigned PDFs.
- Use `WebSearch`/`WebFetch` when needed to verify DOI, publication metadata, impact factor, guideline source, or other requested fields not reliably available in the PDF.
- Do not proactively fill impact factor, journal quartile, or other journal metrics when the sample/existing Excel leaves those columns blank. Only fill them when explicitly required by the field contract and verified from a reliable source with the metric year.
- Only write web-derived values when the source is reliable and the subagent records evidence. Leave uncertain values blank.
- Use `Write` to create the assigned shard JSON file.
- Return only a concise completion note with the JSON file path and issue count.
- Do not paste the full extracted JSON into the final response.

Prefer this JSON shape:

```json
{
  "records": [],
  "issues": []
}
```

The main agent owns final merging, Excel writing, and user-facing summary. After all subagents finish, call `LiteratureExcel` with `json_dir`, `output_path`, and the normalized `columns` array. Include `existing_excel_path` when this is an incremental update.

Use a human-readable final Excel filename based on the topic folder or task name. Avoid vague temporary filenames such as `f1.xlsx`, `final.xlsx`, `merged.xlsx`, or `output.xlsx`. Before delivery, delete temporary artifacts generated by this workflow and leave only the final deliverable Excel workbook(s) in the user-visible output location.

## Runtime Compatibility

This skill is a workflow and schema guide for cchaha. It must remain usable on a packaged Windows exe where the user may not have Python, Bun, Node, Office, or command-line PDF utilities installed.

Production PDF reading must use the bundled `PDFExtract` tool or equivalent cchaha application code. Production Excel writing must use the bundled `LiteratureExcel` tool or equivalent cchaha application code. External helper scripts are optional development aids only and must not be required for the end-user workflow.

OCR is currently disabled for this workflow because the bundled local OCR is too slow for reliable subagent execution. Subagents must record scanned/image-only PDFs in `issues` and leave unverifiable fields blank instead of retrying OCR.
