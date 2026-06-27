# 工作流

在处理超过 5 个 PDF、启动子 agent，或执行增量 Excel 更新之前，必须先阅读本文件。

## 输入盘点

1. 统计 PDF 数量。
2. 识别用户提供的字段说明书。
3. 识别已有 Excel 文件及其表头。
4. 如果用户提供官方样例或已有 Excel，检查每列的填充/留空风格。样例中存在但整列为空的字段，默认保持留空，除非用户明确要求补充。
5. 将字段说明书规范化为目标 `columns` 数组，以及逐字段的提取规则。
6. 尽可能按名称将附件文件夹与 Excel 文件配对。
7. 在开始提取前提醒用户：当前 OCR 已禁用，扫描件/纯图片 PDF 暂时无法处理。除非用户要求停止，否则继续处理带文本层的 PDF。

## 有限分片子 Agent 调度

默认策略：一个提取子 agent 最多处理 3 个 PDF，同时最多运行 5 个子 agent。这个策略能减少任务爆炸、上下文切换和工具调用混乱。

并发规则：

- 同时最多运行 5 个提取子 agent。
- 每个子 agent 最多分配 3 个 PDF。
- 每个 PDF 只能分配给一个子 agent，除非用户明确要求交叉复核。
- 子 agent 完成并写出 JSON 后即结束，不要继续接新任务。
- PDF 超过 15 个时，分多轮处理：每轮最多 5 个子 agent、最多 15 个 PDF。确认本轮所有 JSON 存在后，再启动下一轮。
- 特别大的 PDF、扫描件 PDF、字段要求复杂的 PDF 可以单独成为一个 shard，不要和其他 PDF 合并。

使用 task 工具前，必须先加载对应 task 工具的 schema。每个 task 工具首次使用前都要调用 `ToolSearch`，例如 `select:TaskCreate`、`select:TaskUpdate`、`select:TaskGet`、`select:TaskList`、`select:TaskOutput`、`select:TaskStop`。严格按发现到的 schema 调用：任务名称/标题参数是 `subject`，不是 `title`；任务 ID 参数是 `taskId`，不是 `task_id`。不要凭记忆猜测参数。如果 task 工具没有加载，或 schema 校验失败，则退回直接调用 `Agent`。

启动子 agent 前，先创建或选择一个共享 JSON 输出目录，例如 `<output-dir>/literature-json/`。每个子 agent 必须在该目录的直接子级写入且只写入一个 `.json` 文件。使用稳定的分片文件名，例如 `shard-01.json`、`shard-02.json`，以此类推。

## 子 Agent 规则

- 所有提取子 agent 都使用 `subagent_type: "general-purpose"`。
- 每个子 agent 的提示词里都必须包含规范化后的提取规则和目标 `columns` 数组。
- 每个子 agent 只能处理提示词中指定的 PDF 列表，最多 3 个 PDF。
- 告诉子 agent 使用 `PDFExtract`，并设置有限的 `start_page`、`max_pages`、`max_chars`，不要使用 shell PDF 工具。
- 告诉子 agent 当前 OCR 已禁用。如果 `PDFExtract` 报告页面为空、疑似扫描件/纯图片页，子 agent 必须记录 issue，并将无法核验的字段留空。
- 子 agent 可以使用 `WebSearch` 和 `WebFetch` 验证或补充 PDF 中无法可靠确认的字段，例如 DOI、期刊信息、指南发布机构、官网/出版页、影响因子等。
- 如果官方样例或已有 Excel 中的影响因子、JCR 分区、中科院分区等期刊指标列整体为空，子 agent 不要主动补这些字段。只有字段说明书明确要求填写，且可靠来源能核验数值和指标年份时，才允许填写。
- Web 补充的字段必须有可靠来源，且要在 `evidence` 或 `issues` 中记录来源说明。不能只因为搜索结果摘要里出现某个值就直接填写。
- 准确性优先于完整性。DOI、影响因子、JCR 分区、学会/机构、推荐意见原文、样本量、数值结果、页码、引文信息等字段，只有在 PDF 或可靠网页中核验后才能填写。无法核验时必须留空并记录 issue。
- 子 agent 只把 JSON 写入共享 JSON 输出目录；不要编辑 Excel。
- 不接受只出现在子 agent 最终回复里的记录。主 agent 合并前必须确认分配的 JSON 文件确实存在。
- 子 agent 必须将未知值留空，并记录问题。

## Web 检索准确性规则

允许检索：

- DOI、PMID、期刊名、卷期页、发表年份。
- 指南/共识的发布机构、发布日期、官网或期刊页面。
- 影响因子、JCR/中科院分区等用户明确要求的期刊指标。
- PDF 中无法确认但字段说明书要求填写的可公开核验信息。

优先来源：

- 出版商页面、Crossref、PubMed、期刊官网、指南/学会官网。
- 官方数据库或权威索引页面。
- 对影响因子等指标，优先使用期刊官网、Clarivate/JCR 可公开页面、期刊说明页，或用户指定来源。
- 如果样例表格中的影响因子/分区列为空，默认不检索、不填写这些指标。

禁止做法：

- 不要用搜索结果标题或摘要作为唯一证据填写关键字段。
- 不要从非权威转载页、营销页、AI 摘要页推断 DOI、影响因子或推荐意见。
- 不要把不同年份的影响因子混填到未指定年份的字段中；如果年份不明，要写清来源年份或留空。
- 不要使用 Wikipedia 或类似百科/聚合页面作为影响因子、分区等期刊指标的主要来源。
- 不要为了“填满表格”而猜测。宁可留空并说明，也不要写错。

## 子 Agent 提示词模板

```text
Extract structured records from the assigned PDF shard using the extraction contract below.

Use subagent_type: general-purpose.

Write one JSON object with keys records and issues to this exact file:
<json_output_dir>/shard-NN.json

Rules:
- Process only the PDFs listed in this prompt. Do not process any other PDF.
- This shard contains at most 3 PDFs.
- Use the column names exactly as provided.
- Read each PDF with PDFExtract. Start with early pages for title/metadata, then jump to sections needed by the field contract when possible. For long PDFs, continue from nextPage rather than reading the whole file at once.
- If PDFExtract reports a scanned/image-only page, do not retry OCR. Add an issue and leave unverifiable fields blank.
- You may use WebSearch and WebFetch to verify or supplement requested fields such as DOI, journal metadata, publisher page, guideline source, and impact factor.
- Do not proactively fill impact factor, journal quartile, or other journal metrics when the official sample or existing Excel leaves those columns blank.
- Only fill journal metrics when the extraction contract explicitly requires them and the value plus metric year are verified from a reliable source.
- Only fill web-derived values when they are verified from reliable sources. Record source notes in evidence or issues.
- Do not fill DOI, impact factor, society/organization, recommendation text, sample sizes, numeric results, page numbers, or citation details unless verified.
- You must write the JSON result to the exact file with Write.
- Your final response must not paste the full JSON. Return only: written file path, record count, issue count, and any blocking errors.
- Do not create or edit Excel.
- Do not invent missing values.
- Leave unverifiable fields blank.
- Include PDF filename, page/evidence notes, and web source notes when possible.

PDF shard:
- <paths>

Extraction contract:
<normalized field specification>
```

Task 工具提醒：如果用 task 工具包装这段提示词，必须确认已经调用过对应的 `ToolSearch select:<TaskToolName>`。任务标签使用 `subject`，任务 ID 使用 `taskId`。

## PDF 文本提取

默认生产路径使用 `PDFExtract`。它会以有限块读取 PDF 内嵌文本；如果后面还有页面，会返回 `nextPage`。

推荐顺序：

1. 先对前几页调用 `PDFExtract`，获取题名、作者、期刊/来源、摘要，以及可能存在的目录。
2. 对大型 PDF，使用 `start_page` 和 `nextPage` 只读取字段要求所需页面。
3. 如果文本为空、过少或乱码，标记该 PDF 可能是扫描件/纯图片 PDF。
4. 当前工作流禁用 OCR。不要调用 OCR 工具，也不要反复重试大型扫描件 PDF。
5. 对低置信度的来源字段，只能结合文件名、可读元数据和可靠网页；无法核验的字段留空，并添加一条 `issues` 记录。
6. 绝不要仅凭文件名推断数值结果、DOI、影响因子、学会/协会、推荐意见文本或样本量。

## 增量 Excel 更新

当用户提供已有 Excel 时：

1. 读取表头和已有行。
2. 除非用户要求修改列，否则使用已有表头作为默认 `columns` 数组。
3. 检查已有行/官方样例的列填充习惯。若某列存在但整列为空，例如影响因子、JCR 分区、中科院分区等，默认将该列的 `blank_rule` 设为“保持空白，除非用户明确要求补充并提供可靠来源规则”。
4. 将字段说明书与已有表头对比；如果不一致且可能破坏表格，提取前先报告。
5. 从可能的标识符构建重复键：
   - 规范化后的题名类字段，例如 `题目`、`标题`、`Title`
   - DOI
   - 规范化后的引文类字段
   - 规范化后的 PDF 文件名/来源字段
6. 将新 PDF 提取为共享 JSON 输出目录中的 shard JSON 文件。每个 shard 最多 3 个 PDF。合并前必须确认这些文件存在。
7. 使用 `LiteratureExcel`，传入 `existing_excel_path`、`json_dir`、`output_path`、`columns`，跳过完全重复记录并追加新记录。
8. 当题名相似度高但不完全一致时，单独报告可能重复。
9. 新行追加到已有行之后。
10. 只有当存在序号列，且用户要求重新编号，或新追加行需要自动编号时，才重新编号序号列。
11. 汇总所有子 agent 的 `issues` 到最终报告；不要静默丢弃警告。

## 重复记录策略

以下任意一项匹配时，视为重复记录：

- 规范化后的题名类字段相同。
- DOI 相同。
- PDF 文件名/来源字段相同。
- 去除空白和标点差异后，引文相同。

以下情况视为可能重复：

- 题名相似度高，但标点或副标题不同。
- PDF 文件名是编码形式，但提取出的题名与已有行近似匹配。

## 校验

写入最终 Excel 前：

- 确认列顺序与规范化后的 `columns` 数组或已有 Excel 表头一致。
- 确认每条记录至少有一个有意义的标识符，例如题名、引文、DOI 或 PDF 文件名。
- 如果指定了受控词表，确认字段值使用允许值。
- 确认日期和数值没有明显不可能的情况。
- 确认生成的引文没有编造 DOI 或页码。
- 确认 Web 补充字段有来源说明，且没有把低可信网页内容当作事实。
- 确认官方样例/已有 Excel 中整体为空的列没有被主动填充；尤其检查影响因子、JCR 分区、中科院分区等期刊指标。
- 确认中文和非英文文本以 UTF-8 保留。
- 审阅子 agent 的 `issues`，区分提取错误、Web 核验失败和正常空白。

写入最终 Excel 后，重新打开或检查工作簿，并执行严格的整表检查：

- 确认列顺序和列数与规范化后的 `columns` 数组或已有 Excel 表头完全一致。
- 确认合并后序号列全局连续。
- 确认不存在只有 PDF 文件名/来源，而所有有意义字段都为空的行。
- 确认完全重复项已跳过，并报告了近似重复项。
- 确认没有明显字段错位，例如题名字段里出现引文，日期字段里出现结果段落。
- 确认扫描件/OCR 相关行没有被静默留空；它们必须有清晰的 issue 记录。
- 抽查 DOI、影响因子、指南机构等 Web 补充字段是否与来源一致。
- 交付工作簿前，先修正明确的合并或格式问题。

## 最终报告

告诉用户：

- 输出 Excel 路径。
- 保留的已有行数。
- 新增行数。
- 跳过的重复项数量。
- 提取出错的 PDF。
- Web 检索补充了哪些字段，以及是否有未能核验的字段。
- 因无法核验而留空的重要字段。
- 主 agent 在规范化字段说明书时做过的任何修改。
