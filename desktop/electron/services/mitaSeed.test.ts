import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { existsSync } from 'node:fs'
import { seedMitaAssetsIfFirstRun } from './mitaSeed'

interface Sandbox {
  root: string
  homeDir: string
  configDir: string
  installDir: string
  assetsDir: string
  skillsDir: string
}

async function makeSandbox(): Promise<Sandbox> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mita-seed-'))
  const homeDir = path.join(root, 'home')
  const configDir = path.join(homeDir, '.claude')
  const installDir = path.join(configDir, 'mita')
  const assetsDir = path.join(root, 'assets', 'mita')
  const skillsDir = path.join(configDir, 'skills')
  await fs.mkdir(homeDir, { recursive: true })
  await fs.mkdir(path.join(assetsDir, 'skills'), { recursive: true })
  await fs.mkdir(path.join(assetsDir, 'bin'), { recursive: true })
  return { root, homeDir, configDir, installDir, assetsDir, skillsDir }
}

async function writeAssets(sandbox: Sandbox): Promise<void> {
  const skillSrc = path.join(sandbox.assetsDir, 'skills', 'literature-field-extraction')
  await fs.mkdir(path.join(skillSrc, 'references'), { recursive: true })
  await fs.writeFile(
    path.join(skillSrc, 'SKILL.md'),
    '---\nname: literature-field-extraction\ndescription: test skill\n---\n\n# Test\n',
    'utf8',
  )
  await fs.writeFile(
    path.join(skillSrc, 'references', 'workflow.md'),
    'workflow body',
    'utf8',
  )
  const binaryName = process.platform === 'win32' ? 'mita-mcp-server.exe' : 'mita-mcp-server'
  await fs.writeFile(
    path.join(sandbox.assetsDir, 'bin', binaryName),
    '#!/bin/sh\necho mcp\n',
    'utf8',
  )
}

function fakeApp() {
  return { isPackaged: false } as never
}

describe('seedMitaAssetsIfFirstRun', () => {
  let sandbox: Sandbox

  beforeEach(async () => {
    sandbox = await makeSandbox()
    await writeAssets(sandbox)
  })

  afterEach(async () => {
    await fs.rm(sandbox.root, { recursive: true, force: true })
  })

  it('seeds skill + MCP binary + .claude.json on first run', async () => {
    const result = await seedMitaAssetsIfFirstRun({
      app: fakeApp(),
      getAssetsRoot: () => sandbox.assetsDir,
      configDir: sandbox.configDir,
      homeDir: sandbox.homeDir,
      env: {},
    })

    expect(result.seeded).toBe(true)
    expect(existsSync(path.join(sandbox.skillsDir, 'literature-field-extraction', 'SKILL.md'))).toBe(true)
    expect(existsSync(path.join(sandbox.installDir, 'VERSION'))).toBe(true)
    const binaryName = process.platform === 'win32' ? 'mita-mcp-server.exe' : 'mita-mcp-server'
    expect(existsSync(path.join(sandbox.installDir, 'bin', binaryName))).toBe(true)

    const configPath = path.join(sandbox.homeDir, '.claude.json')
    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      mcpServers: Record<string, { type: string; command: string; args: string[] }>
    }
    const literature = config.mcpServers.literature
    expect(literature).toBeDefined()
    expect(literature?.type).toBe('stdio')
    expect(literature?.command).toContain(binaryName)
  })

  it('is idempotent on second run when version matches', async () => {
    await seedMitaAssetsIfFirstRun({
      app: fakeApp(),
      getAssetsRoot: () => sandbox.assetsDir,
      configDir: sandbox.configDir,
      homeDir: sandbox.homeDir,
      env: {},
    })

    const result = await seedMitaAssetsIfFirstRun({
      app: fakeApp(),
      getAssetsRoot: () => sandbox.assetsDir,
      configDir: sandbox.configDir,
      homeDir: sandbox.homeDir,
      env: {},
    })

    expect(result.seeded).toBe(false)
    expect(result.reason).toContain('already at target version')
  })

  it('preserves unknown fields in .claude.json', async () => {
    const configPath = path.join(sandbox.homeDir, '.claude.json')
    await fs.mkdir(sandbox.homeDir, { recursive: true })
    await fs.writeFile(
      configPath,
      JSON.stringify({
        numStartups: 42,
        userID: 'u-123',
        mcpServers: { existing: { type: 'stdio', command: '/bin/true', args: [] } },
      }),
      'utf8',
    )

    await seedMitaAssetsIfFirstRun({
      app: fakeApp(),
      getAssetsRoot: () => sandbox.assetsDir,
      configDir: sandbox.configDir,
      homeDir: sandbox.homeDir,
      env: {},
    })

    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>
    expect(config.numStartups).toBe(42)
    expect(config.userID).toBe('u-123')
    expect((config.mcpServers as Record<string, unknown>).existing).toBeDefined()
    expect((config.mcpServers as Record<string, unknown>).literature).toBeDefined()
  })

  it('returns not-seeded when assets root is missing', async () => {
    const result = await seedMitaAssetsIfFirstRun({
      app: fakeApp(),
      getAssetsRoot: () => path.join(sandbox.root, 'missing'),
      configDir: sandbox.configDir,
      homeDir: sandbox.homeDir,
      env: {},
    })

    expect(result.seeded).toBe(false)
    expect(result.reason).toContain('assets root not found')
  })

  it('respects CLAUDE_CONFIG_DIR for .claude.json location', async () => {
    const altConfigDir = path.join(sandbox.root, 'altconfig')
    await fs.mkdir(altConfigDir, { recursive: true })
    const altHome = path.join(sandbox.root, 'althome')
    await fs.mkdir(altHome, { recursive: true })

    await seedMitaAssetsIfFirstRun({
      app: fakeApp(),
      getAssetsRoot: () => sandbox.assetsDir,
      configDir: altConfigDir,
      homeDir: sandbox.homeDir,
      env: { CLAUDE_CONFIG_DIR: altHome },
    })

    expect(existsSync(path.join(altHome, '.claude.json'))).toBe(true)
    expect(existsSync(path.join(sandbox.homeDir, '.claude.json'))).toBe(false)
  })
})
