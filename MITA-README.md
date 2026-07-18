# mita 0.2.1 重构记录

## 背景

mita 之前基于 cc-haha fork，通过**修改源码**安装内置 skill 和 tool（`src/skills/bundled/` + `src/tools/`）。每次 rebase 上游都要处理 `src/tools.ts` 等冲突，维护成本高。

本次重构目标：**零源码侵入**，改成 Electron 首次启动自动 seed skill + MCP server，用户零配置。

## 已完成

### Phase 0 — 分支重置
- `git tag mita-archive-20260718 maita` 备份 22 个 commit
- `git reset --hard origin/main` 回到干净上游 v0.4.9
- 新分支 `feat/mita-installer`

### Phase 1 — 搬运资产到独立目录 `mita-dist/`
- `mita-dist/skills/literature-field-extraction/` — SKILL.md + 3 个 references，从 mita 分支原样搬运
- `mita-dist/mcp-server/src/` — 两个 tool 的业务逻辑原样搬运：
  - `pdfExtract.ts`（pdfjs-dist 文本抽取，340 行）
  - `literatureExcel.ts`（exceljs 合并去重，720 行）
  - `index.ts`（MCP server 入口，注册 2 个 tool）
- 依赖独立到 `mita-dist/mcp-server/package.json`，不污染 cc-haha

### Phase 2 — 测试
- MCP server 单元测试：7 pass（业务逻辑未改，只换 `buildTool` 壳为 MCP schema）
- `bun test` 全绿

### Phase 3 — 编译单文件二进制
- `bun build --compile --target=bun-windows-x64` 产出 `mita-mcp-server.exe`（100MB，pdfjs+exceljs 静态链接）
- MCP 协议握手冒烟通过（`initialize` + `tools/list` 返回 `PDFExtract` + `LiteratureExcel`）

### Phase 4 — Electron first-run seed
- 新增 `desktop/electron/services/mitaSeed.ts`：
  - 幂等 seed（按 `~/.claude/mita/VERSION` 判断）
  - 复制 skill 到 `~/.claude/skills/literature-field-extraction/`
  - 复制二进制到 `~/.claude/mita/bin/`
  - 写 `~/.claude.json` 的 `mcpServers.literature`（保留未知字段）
- 5 个单元测试 + 1 个 e2e 测试（真实二进制 + MCP 协议握手）全过

### Phase 5 — 接入 Electron
- `desktop/electron/main.ts` +4 行（import + `app.whenReady()` 里 fire-and-forget 调用）
- `desktop/package.json` `extraResources` 按平台配置（mac/win/linux 各自的二进制路径）
- `tsc -p electron/tsconfig.json` 编译通过

### Phase 6 — dev 模式验证
- 临时 `CLAUDE_CONFIG_DIR` 隔离，保护真实 `~/.claude.json`
- Electron 启动后 seed 自动执行，skill + MCP 二进制 + `.claude.json` 全部落地
- agent 调用 `literature-field-extraction` skill 成功
- MCP server 连接成功（340ms 握手，`hasTools:true`）

### 修复 DeepSeek 不调 tool 的问题
- 现象：DeepSeek-v4-pro 在 skill 启动后 thinking 完直接 `end_turn`，不调 `PDFExtract`
- 原因：cc-haha 默认把 MCP tool 标为 deferred，模型需先 `ToolSearch select:` 加载，DeepSeek 不熟悉此机制
- 修复：MCP server 注册时加 `_meta: { 'anthropic/alwaysLoad': true }`，跳过延迟加载
- 用户测试通过

## 对 cc-haha 源码的净改动

**完全不碰 `src/`**。改动面积：
- `desktop/electron/main.ts` +4 行
- `desktop/package.json` +34 行（extraResources + version 0.2.1）
- `desktop/electron/services/mitaSeed.ts` 新增（seed 逻辑）
- `desktop/electron/services/mitaSeed.test.ts` + `mitaSeed.e2e.test.ts` 新增（测试）
- `.gitignore` +3 行（忽略 `mita-dist/bin/`）
- `.github/workflows/build-desktop-dev.yml` +21 行（CI 加 MCP server 编译步骤）
- `release-notes/v0.2.1.md` 新增
- `mita-dist/` 新增独立目录（skill + MCP server 源码）

## 未完成

### 本地打包 NSIS .exe（阻塞）
- `electron-builder --win nsis` 卡在 `winCodeSign` 解压
- 原因：非 admin 账号无法创建符号链接（darwin 的 `.dylib` 符号链接）
- 尝试过：`CSC_IDENTITY_AUTO_DISCOVERY=false`、`toolsets.winCodeSign: "1.1.0"`，均未绕过
- **下一步**：要么用 admin 账号跑，要么直接推到 CI 打包

### 代码未提交
- 所有改动已 staged，但未 commit（用户要求先测试打包）
- 未推送到 fork `mita` remote

## 未来计划

### v0.2.1（当前）
- [x] MCP server + skill 重构
- [x] dev 模式验证
- [ ] 本地或 CI 打 NSIS .exe
- [ ] 新电脑安装测试

### v0.2.2
- 接入 `release-desktop.yml` 支持自动更新（electron-updater + GitHub Release）
- 改造 CI 支持单平台发布（当前 `release-desktop.yml` 强制全平台）

### v0.2.3
- macOS arm64 / Linux x64 二进制（当前只编译了 Windows x64）
- CI 矩阵覆盖全平台

### v0.3.0
- OCR 支持（扫描件 PDF，当前 SKILL.md 明确"OCR 已禁用"）

## 文件结构

```
mita-dist/                          # 独立目录，不进 cc-haha 源码树
├── skills/
│   └── literature-field-extraction/  # 从 mita 分支原样搬运
│       ├── SKILL.md
│       └── references/
├── bin/                             # gitignore，100MB 二进制
│   └── mita-mcp-server.exe
└── mcp-server/                      # MCP server 源码
    ├── src/
    │   ├── index.ts                  # MCP 入口，注册 2 个 tool
    │   ├── pdfExtract.ts             # pdfjs 文本抽取
    │   ├── literatureExcel.ts        # exceljs 合并去重
    │   └── *.test.ts                 # 7 个测试
    └── package.json                  # 独立依赖

desktop/electron/services/
├── mitaSeed.ts                      # first-run seed 逻辑
├── mitaSeed.test.ts                 # 5 个单元测试
└── mitaSeed.e2e.test.ts             # 端到端测试
```

## 验证命令

```bash
# MCP server 测试
cd mita-dist/mcp-server && bun test

# 编译二进制
cd mita-dist/mcp-server && bun build src/index.ts --compile --target=bun-windows-x64 --outfile=mita-mcp-server.exe

# Electron seed 测试
cd desktop && bun run test -- --run mitaSeed.test.ts mitaSeed.e2e.test.ts

# dev 模式启动（临时 CLAUDE_CONFIG_DIR 隔离）
$env:CLAUDE_CONFIG_DIR = "$env:TEMP\mita-dev-config"
cd desktop && bun run electron:dev
```
