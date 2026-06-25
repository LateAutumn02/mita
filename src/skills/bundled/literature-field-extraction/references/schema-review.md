# Field Specification Review

Read this file before normalizing a user's field specification or creating prompts for extraction subagents.

## Goal

Turn the user's field requirement document into a compact extraction contract that subagents can follow without guessing.

The contract should be domain-neutral. Keep the user's topic context, but do not hard-code any disease, product, journal type, or fixed table schema unless the user supplied it.

## Review Checklist

For each field, make these items explicit when possible:

- `name`: the exact output column name.
- `description`: what the field means.
- `required`: whether the extractor should try hard to fill it.
- `allowed_values`: controlled vocabulary when the field should be categorized.
- `format`: expected shape such as date, number, text, multi-line summary, citation, DOI, or PDF filename.
- `source_rule`: where to look in the PDF, such as title page, abstract, methods, results, conclusion, reference section, guideline recommendations, table, or figure caption.
- `blank_rule`: when to leave the cell blank instead of inferring.
- `example`: one realistic example value if available.

## Normalization Rules

- Preserve the user's intended fields.
- Prefer concise, stable column names.
- Split overloaded fields when a single field asks for unrelated values.
- Merge duplicate fields when two names mean the same thing.
- Add a source/provenance field when the user omitted one and traceability matters. Common choices: `文献`, `pdf原文`, `PDF文件`, `页码`, `证据摘录`, `引用文献格式`, `DOI`.
- Mark fields as optional when they may not exist in every paper.
- Do not invent allowed values; derive them from the user's document or use broad categories with an `其他/不明确` option only when appropriate.
- Leave unverifiable values blank. Do not infer numeric results, sample sizes, P values, DOI, impact factor, author affiliations, recommendations, or drug names from filenames alone.

## Extraction Contract Shape

Use a concise contract like this in subagent prompts:

```json
{
  "topic": "user-provided topic or empty string",
  "columns": ["序号", "题目", "发表年份", "研究类型", "主要结论", "PDF文件"],
  "fields": [
    {
      "name": "题目",
      "description": "文献或指南的正式标题。",
      "required": true,
      "format": "text",
      "source_rule": "优先从标题页、首页标题、引用信息中提取。",
      "blank_rule": "无法确认正式标题时留空。",
      "example": "示例文献题目"
    }
  ],
  "dedupe_keys": ["题目", "DOI", "引用文献格式", "PDF文件"],
  "notes": []
}
```

## Subagent JSON Shape

Each subagent writes one JSON file with this shape:

```json
{
  "records": [
    {
      "题目": "",
      "发表年份": "",
      "PDF文件": "",
      "evidence": [
        {
          "field": "题目",
          "pdf": "",
          "page": null,
          "note": ""
        }
      ]
    }
  ],
  "issues": [
    {
      "pdf": "",
      "severity": "warning",
      "message": ""
    }
  ]
}
```

`records[]` must use the normalized column names exactly. Extra metadata fields such as `evidence` are allowed; `LiteratureExcel` writes only requested columns.

Allowed `issues[].severity` values: `info`, `warning`, `error`.
