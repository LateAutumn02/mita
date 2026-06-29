---
name: literature-field-extraction
description: 审核并规范用户提供的文献字段说明书，再从一批 PDF 文献中提取结构化字段，要求子 agent 写出 JSON，最后合并为 Excel。适用于按自定义字段要求处理论文、指南、共识、报告等文献，也适用于基于已有半成品 Excel 的增量更新。
---

# 文献字段提取

## 用途

这个 skill 用于把一批文献 PDF 和一份用户提供的字段说明书，整理成结构化 Excel 工作簿。

这个 skill 是通用能力，不绑定固定主题、疾病、药品或字段表头。主题和字段要求由用户提供。主 agent 必须先审核并规范字段说明书，让子 agent 能按同一套规则稳定提取。

默认用户环境是 Windows 电脑。示例路径、输出路径和用户提示应优先使用 Windows 路径习惯；除非用户明确说明其他系统，否则不要假设 Linux/macOS 环境，也不要要求用户安装 Linux/macOS 命令行工具。

任务开始时，必须提醒用户：当前 OCR 已禁用，扫描件/纯图片 PDF 暂时无法处理。如果文献中包含扫描件，请用户提供带文本层的 PDF 或已经 OCR 处理过的 PDF。除非用户要求停止，否则继续处理可读取文本层的 PDF。

## 核心流程

1. 盘点输入。
   - 列出 PDF、已有 Excel、附件文件夹和字段说明书。
   - 如果用户提供已有 Excel，读取表头，并把表头作为目标字段的重要依据。
   - 在改写或规范字段说明书前，先阅读 `references/schema-review.md`。

2. 审核并规范字段说明书。
   - 生成一份简洁、明确、适合子 agent 阅读的提取契约。
   - 保留用户原本想要的字段，但要明确字段名、是否必填、允许值、样例和留空规则。
   - 每个字段尽量只保留一个稳定列名。
   - 如果用户提供已有 Excel 或官方样例，参考其填充/留空风格。样例中存在但整列为空的字段，默认继续留空，除非用户明确要求补充。
   - 必要时加入来源/证据字段，例如 PDF 文件名、页码、原文摘录、DOI、引文或证据备注。
   - 只有当字段说明书模糊到无法可靠提取时，才向用户追问。

3. 选择处理策略。
   - 1-5 个 PDF，且用户只是要快速小批量处理时，主 agent 可以直接处理。
   - 超过 5 个 PDF 时，创建 `general-purpose` 子 agent。
   - 同时最多运行 5 个子 agent。
   - 每个提取子 agent 最多处理 3 个 PDF。
   - PDF 较多时分轮处理：每轮最多启动 5 个子 agent；确认本轮所有 JSON 文件存在后，再启动下一轮。
   - 这个有限分片策略用于平衡速度和准确性，避免一次创建过多并行任务。
   - 启动子 agent 或做增量 Excel 更新前，先阅读 `references/workflow.md`。
   - 使用 task 工具前，先用 `ToolSearch` 加载对应 schema，例如 `select:TaskCreate`、`select:TaskUpdate`、`select:TaskGet`、`select:TaskOutput` 或 `select:TaskStop`。严格使用发现到的参数名：任务 ID 是 `taskId`，不是 `task_id`；任务标题字段是 `subject`，不是 `title`。

4. 委托提取。
   - 启动子 agent 前，先创建一个共享 JSON 输出目录，例如 `<输出目录>\literature-json\`。
   - 每个子 agent 收到最多 3 个 PDF、规范化后的提取契约、目标 `columns` 列表，以及必要的已有行去重信息。
   - 每个子 agent 使用 `PDFExtract` 按有限页码范围读取 PDF。大型 PDF 要根据 `nextPage` 继续读取，不要一次性读完整篇。
   - 子 agent 可以使用 `WebSearch` 和 `WebFetch` 验证或补充 PDF 中无法可靠确认的字段，例如 DOI、期刊信息、指南来源、出版页面、影响因子等。来自网页的信息必须在 `evidence` 或 `issues` 中记录来源说明。
   - 如果已有 Excel 或样例中影响因子、分区等期刊指标列为空，不要主动补这些字段。只有字段说明书明确要求，且可靠来源能验证数值和指标年份时，才填写。
   - 准确性优先于完整性。DOI、影响因子、期刊分区、学会/机构、推荐意见原文、样本量、数值结果、引文信息等字段，必须由 PDF 或可靠网页验证后才能填写。无法验证时留空并记录 issue。
   - 如果 `PDFExtract` 报告扫描件/纯图片页，则无法验证的字段留空，并把该 PDF 记录到 `issues`；当前流程不要尝试 OCR。
   - 每个子 agent 必须且只能在共享 JSON 目录中写入一个 JSON 文件，例如 `shard-01.json`、`shard-02.json`。
   - 每个 JSON 文件必须是一个对象，包含 `records` 和 `issues`。
   - 不接受只出现在子 agent 最终回复里的提取记录。如果 JSON 文件不存在，必须要求该子 agent 先写文件，再合并。

5. 合并并校验。
   - 从共享 JSON 输出目录中合并所有子 agent JSON。
   - 使用 `LiteratureExcel` 和规范化后的 `columns` 列表生成最终 `.xlsx`。
   - 如果用户提供已有 Excel，传入 `existing_excel_path`，保留已有行并追加新行。
   - 最终工作簿必须按来源文件夹或主题规范命名，例如 `<主题名>_文献提取结果.xlsx`；增量更新可命名为 `<主题名>_文献提取结果_增量更新.xlsx`。不要把 `f1.xlsx`、`result.xlsx`、`output.xlsx` 这类临时名字作为交付文件名。
   - 写入 Excel 后，主 agent 必须重新打开或检查整张表，严格检查列顺序、行数、序号、重复行、空行、明显异常的日期/数字、字段错位和未解决 issue。发现明确的格式或合并问题，交付前先修正。
   - 最终质量检查由主 agent 负责，默认不要再创建单独的验证子 agent。
   - 最终检查应主要依据 shard JSON、`issues`、最终 Excel 和规范化字段说明书。不要为了验证而重新全量读取或重新提取所有 PDF。
   - 只有遇到具体可疑字段、字段冲突、缺少证据，或用户要求抽查时，才回读对应 PDF 或使用 WebSearch/WebFetch。
   - 最终 Excel 通过检查后，主 agent 必须清理本流程产生的中间产物，包括 shard JSON 目录、临时规范字段说明、scratch 日志、临时工作簿和重试文件。用户可见输出位置只保留最终交付的 Excel；如果任务本身要求生成两个 Excel，则只保留这两个 Excel 和用户原始输入文件。
   - 不要依赖系统 Python、Office 或用户自行安装的 PDF/Excel 命令行工具。

6. 交付输出。
   - 生成最终 `.xlsx`。
   - 汇报新增行数、跳过的重复项、跳过的无效记录、未解决 PDF、以及重要留空字段。
   - 如果主 agent 调整过字段说明书，简要说明做了哪些有意义的规范化修改。

## 参考文件

- `references/schema-review.md`：如何把松散的字段说明书改写成清晰的提取契约。
- `references/workflow.md`：有限子 agent 分片、共享 JSON 输出、增量更新、去重策略和最终报告规则。

## 子 Agent 策略

在 cchaha 内运行时，使用 cchaha 自带的 `Agent` 工具或 task/agent 编排能力分配 PDF 分片。不要把 Codex 专用的子 agent/编排接口写进产品工作流。

如果使用 `TaskCreate` 等 task 工具，而不是直接调用 `Agent`，每个 task 工具第一次使用前都必须先调用 `ToolSearch`，例如：

- `select:TaskCreate`
- `select:TaskUpdate`
- `select:TaskGet`
- `select:TaskList`
- `select:TaskOutput`
- `select:TaskStop`

严格按发现到的 schema 调用。任务名称字段使用 `subject`，不要传 `title`。任务 ID 字段使用 `taskId`，不要传 `task_id`。如果 task schema 发现失败，改用已经可用的 `Agent` 工具，不要猜参数。

所有提取子 agent 都使用 `subagent_type: "general-purpose"`。同时最多运行 5 个子 agent；每个子 agent 最多处理 3 个 PDF。若还有更多 PDF，等当前轮次结束且 JSON 文件全部存在后，再启动下一轮。不要让子 agent 编辑同一个 Excel；子 agent 只负责生成 JSON。

启动子 agent 前，先选择或创建一个共享 JSON 输出目录。每个子 agent 必须在该目录直接写入一个 `.json` 文件。使用稳定文件名，例如 `shard-01.json`；不要让多个子 agent 写同一个文件。

子 agent 的提取结果必须写入磁盘，不能只在最终回复里贴出来。每个子 agent 提示词里都要明确要求：

- 使用 `PDFExtract` 读取分配的 PDF。
- 必要时使用 `WebSearch`/`WebFetch` 验证 DOI、出版信息、影响因子、指南来源或其他 PDF 中无法可靠确认的字段。
- 当样例或已有 Excel 中影响因子、期刊分区等期刊指标列为空时，不要主动补这些字段。只有字段契约明确要求，且可靠来源能验证数值和指标年份时，才填写。
- 网页来源字段必须可靠且记录证据；不确定的值留空。
- 使用 `Write` 创建分配的 shard JSON 文件。
- 最终回复只返回简短完成说明：JSON 文件路径、记录数、issue 数和阻塞问题。
- 不要在最终回复中粘贴完整 JSON。

推荐 JSON 结构：

```json
{
  "records": [],
  "issues": []
}
```

主 agent 负责最终合并、写 Excel 和向用户汇报。所有子 agent 结束后，调用 `LiteratureExcel`，传入 `json_dir`、`output_path` 和规范化后的 `columns` 数组。增量更新时同时传入 `existing_excel_path`。

最终 Excel 文件名必须可读、可识别，并基于主题文件夹或任务名称。避免 `f1.xlsx`、`final.xlsx`、`merged.xlsx`、`output.xlsx` 等模糊临时名称。交付前删除本流程产生的中间产物，只在用户可见输出位置留下最终交付 Excel。

## 运行兼容性

这个 skill 是 cchaha 的工作流和 schema 指南，必须能在 Windows 打包版 exe 中使用。默认用户没有 Python、Bun、Node、Office 或命令行 PDF 工具。

生产环境读取 PDF 必须使用内置 `PDFExtract` 工具或等价的 cchaha 应用代码。生产环境写 Excel 必须使用内置 `LiteratureExcel` 工具或等价的 cchaha 应用代码。外部脚本只能作为开发辅助，不能作为最终用户流程的必需条件。

当前流程禁用 OCR，因为本地 OCR 在子 agent 执行中太慢，不够稳定。子 agent 遇到扫描件/纯图片 PDF 时，必须记录到 `issues`，并将无法验证的字段留空，不要反复尝试 OCR。
