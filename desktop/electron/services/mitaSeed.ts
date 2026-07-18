import { app, type App } from 'electron'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { claudeConfigDir } from './sidecarManager'

const MITA_VERSION = '0.1.0'
const MCP_SERVER_NAME = 'literature'
const SKILL_NAME = 'literature-field-extraction'

type MitaAssetsRootProvider = () => string

interface MitaSeedOptions {
  app: App
  getAssetsRoot?: MitaAssetsRootProvider
  configDir?: string
  homeDir?: string
  env?: NodeJS.ProcessEnv
}

function defaultAssetsRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'mita')
  }
  const cwd = process.cwd()
  const candidates = [
    path.join(cwd, 'mita-dist'),
    path.join(cwd, '..', 'mita-dist'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]!
}

function mitaInstallDir(configDir: string): string {
  return path.join(configDir, 'mita')
}

function versionFilePath(installDir: string): string {
  return path.join(installDir, 'VERSION')
}

async function copyDir(source: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true })
  const entries = await fs.readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const src = path.join(source, entry.name)
    const dst = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(src, dst)
    } else if (entry.isFile()) {
      await fs.copyFile(src, dst)
    }
  }
}

async function dirEquals(a: string, b: string): Promise<boolean> {
  try {
    const aEntries = await fs.readdir(a, { withFileTypes: true })
    const bEntries = await fs.readdir(b, { withFileTypes: true })
    if (aEntries.length !== bEntries.length) return false
    const bNames = new Set(bEntries.map(e => e.name))
    for (const entry of aEntries) {
      if (!bNames.has(entry.name)) return false
    }
    return true
  } catch {
    return false
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

interface GlobalClaudeConfig {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

async function writeGlobalConfigWithMcp(
  configPath: string,
  serverName: string,
  serverConfig: Record<string, unknown>,
): Promise<void> {
  const existing = (await readJsonFile<GlobalClaudeConfig>(configPath)) ?? {}
  const next: GlobalClaudeConfig = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      [serverName]: serverConfig,
    },
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  const tmp = `${configPath}.tmp`
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
  await fs.rename(tmp, configPath)
}

function mcpServerConfig(binaryPath: string): Record<string, unknown> {
  return {
    type: 'stdio',
    command: binaryPath,
    args: [] as string[],
  }
}

async function seedSkill(
  assetsRoot: string,
  skillsDir: string,
): Promise<string | null> {
  const src = path.join(assetsRoot, 'skills', SKILL_NAME)
  if (!existsSync(src)) return null
  const dest = path.join(skillsDir, SKILL_NAME)
  const destSkillFile = path.join(dest, 'SKILL.md')
  if (existsSync(destSkillFile) && (await dirEquals(src, dest))) {
    return dest
  }
  await copyDir(src, dest)
  return dest
}

async function seedMcpBinary(
  assetsRoot: string,
  installDir: string,
): Promise<string | null> {
  const platform = process.platform
  const binaryName = platform === 'win32' ? 'mita-mcp-server.exe' : 'mita-mcp-server'
  const src = path.join(assetsRoot, 'bin', binaryName)
  if (!existsSync(src)) return null
  const dest = path.join(installDir, 'bin', binaryName)
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.copyFile(src, dest)
  if (platform !== 'win32') {
    await fs.chmod(dest, 0o755)
  }
  return dest
}

async function seedMcpConfig(
  configDir: string,
  binaryPath: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = require('node:os').homedir(),
): Promise<void> {
  const legacyFallback = existsSync(path.join(configDir, '.config.json'))
  const baseDir = legacyFallback ? configDir : (env.CLAUDE_CONFIG_DIR || homeDir)
  const configPath = path.join(baseDir, '.claude.json')
  await writeGlobalConfigWithMcp(
    configPath,
    MCP_SERVER_NAME,
    mcpServerConfig(binaryPath),
  )
}

async function readInstalledVersion(installDir: string): Promise<string | null> {
  try {
    return (await fs.readFile(versionFilePath(installDir), 'utf8')).trim()
  } catch {
    return null
  }
}

async function writeInstalledVersion(installDir: string): Promise<void> {
  await fs.mkdir(installDir, { recursive: true })
  await fs.writeFile(versionFilePath(installDir), MITA_VERSION, 'utf8')
}

export async function seedMitaAssetsIfFirstRun(
  options: MitaSeedOptions,
): Promise<{ seeded: boolean; reason: string } | { seeded: false; reason: string; error: string }> {
  const { app: appInstance } = options
  const assetsRoot = options.getAssetsRoot?.() ?? defaultAssetsRoot()
  const configDir = options.configDir ?? claudeConfigDir()
  const installDir = mitaInstallDir(configDir)
  const homeDir = options.homeDir ?? require('node:os').homedir()
  void appInstance

  if (!existsSync(assetsRoot)) {
    return { seeded: false, reason: `assets root not found: ${assetsRoot}` }
  }

  const installedVersion = await readInstalledVersion(installDir)
  if (installedVersion === MITA_VERSION) {
    return { seeded: false, reason: 'already at target version' }
  }

  try {
    const skillsDir = path.join(configDir, 'skills')
    const skillDest = await seedSkill(assetsRoot, skillsDir)
    const binaryDest = await seedMcpBinary(assetsRoot, installDir)
    if (binaryDest) {
      await seedMcpConfig(configDir, binaryDest, options.env ?? process.env, homeDir)
    }
    await writeInstalledVersion(installDir)
    return {
      seeded: true,
      reason: `seeded skill=${skillDest ?? 'none'}, mcp=${binaryDest ?? 'none'}`,
    }
  } catch (error) {
    return {
      seeded: false,
      reason: 'seed failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
