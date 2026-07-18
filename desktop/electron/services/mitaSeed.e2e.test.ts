import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { seedMitaAssetsIfFirstRun } from './mitaSeed'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const MCP_BINARY = path.join(REPO_ROOT, 'mita-dist', 'mcp-server', 'mita-mcp-server.exe')

describe.skipIf(!existsSync(MCP_BINARY))('mita seed e2e (real binary)', () => {
  let testRoot: string
  let testHome: string
  let configDir: string

  beforeAll(async () => {
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mita-e2e-'))
    testHome = path.join(testRoot, 'home')
    configDir = path.join(testHome, '.claude')
    await fs.mkdir(configDir, { recursive: true })
  })

  afterAll(async () => {
    await new Promise(r => setTimeout(r, 300))
    await fs.rm(testRoot, { recursive: true, force: true })
  })

  it('seeds skill + binary + .claude.json, then MCP server responds to tools/list', async () => {
    const result = await seedMitaAssetsIfFirstRun({
      app: { isPackaged: false } as never,
      getAssetsRoot: () => path.join(REPO_ROOT, 'mita-dist'),
      configDir,
      homeDir: testHome,
      env: {},
    })
    expect(result.seeded).toBe(true)

    const skillFile = path.join(configDir, 'skills', 'literature-field-extraction', 'SKILL.md')
    expect(existsSync(skillFile)).toBe(true)
    const skillContent = await fs.readFile(skillFile, 'utf8')
    expect(skillContent).toContain('literature-field-extraction')

    const configPath = path.join(testHome, '.claude.json')
    expect(existsSync(configPath)).toBe(true)
    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      mcpServers: Record<string, { type: string; command: string; args: string[] }>
    }
    const literature = config.mcpServers.literature
    expect(literature).toBeDefined()
    expect(literature?.type).toBe('stdio')

    const seededBinary = literature!.command
    expect(existsSync(seededBinary)).toBe(true)

    const initReq = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}\n'
    const toolsReq = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n'

    const child = spawn(seededBinary, [])
    let buffer = ''
    const responses: unknown[] = []
    const collect = new Promise<void>(resolve => {
      child.stdout.on('data', chunk => {
        buffer += chunk.toString()
        let idx: number
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (line.trim()) {
            responses.push(JSON.parse(line))
          }
        }
        if (responses.length >= 2) resolve()
      })
      child.stderr.on('data', () => {})
    })

    child.stdin.write(initReq)
    child.stdin.write(toolsReq)
    await Promise.race([collect, new Promise(r => setTimeout(r, 8000))])
    child.kill()

    expect(responses.length).toBeGreaterThanOrEqual(2)
    const toolsResponse = responses.find(r => (r as { id?: number }).id === 2) as {
      result?: { tools?: { name: string }[] }
    }
    expect(toolsResponse).toBeDefined()
    const toolNames = toolsResponse!.result?.tools?.map(t => t.name) ?? []
    expect(toolNames).toContain('PDFExtract')
    expect(toolNames).toContain('LiteratureExcel')
  }, 30000)
})
