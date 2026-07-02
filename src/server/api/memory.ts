/**
 * Memory REST API (global auto-memory directory)
 *
 * GET  /api/memory/projects        — single global memory entry
 * GET  /api/memory/files           — list markdown memory files
 * GET  /api/memory/file?path=...   — read a memory file
 * PUT  /api/memory/file            — update/create a markdown memory file
 *
 * Memory files live in the global auto-memory directory resolved by
 * getAutoMemPath(): ~/.claude/memory/ when autoMemoryDirectory is set in
 * user settings (the recommended global configuration), or
 * ~/.claude/projects/<git-root>/memory/ by default. The projectId
 * parameter is accepted on /files and /file for backward compatibility
 * with the desktop client but no longer affects the memory directory —
 * all entries map to the same global directory.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { getAutoMemPath } from '../../memdir/paths.js'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { parseMemoryType } from '../../memdir/memoryTypes.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

type MemoryProject = {
  id: string
  label: string
  memoryDir: string
  exists: boolean
  fileCount: number
  isCurrent: boolean
}

type MemoryFile = {
  path: string
  name: string
  bytes: number
  updatedAt: string
  type?: string
  description?: string
  title: string
  isIndex: boolean
}

const MAX_MEMORY_FILE_BYTES = 512 * 1024
const MAX_MEMORY_FILES = 500
const GLOBAL_PROJECT_ID = 'global'

export async function handleMemoryApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const sub = segments[2]

    switch (sub) {
      case 'projects':
        if (req.method !== 'GET') throw methodNotAllowed(req.method)
        return Response.json({
          projects: await listMemoryProjects(),
        })

      case 'files':
        if (req.method !== 'GET') throw methodNotAllowed(req.method)
        return Response.json({
          files: await listMemoryFiles(),
        })

      case 'file':
        return await handleMemoryFile(req, url)

      default:
        throw ApiError.notFound(`Unknown memory endpoint: ${sub}`)
    }
  } catch (error) {
    return errorResponse(error)
  }
}

/**
 * Return a single global memory entry. The desktop client's project
 * selector still consumes this shape, so it gets one "global" project
 * pointing at getAutoMemPath(). Returns an empty array when the global
 * memory directory does not exist yet (fresh install) so the UI can show
 * its empty state instead of fabricating an entry.
 */
async function listMemoryProjects(): Promise<MemoryProject[]> {
  const memoryDir = getAutoMemPath()
  const fileCount = await countMarkdownFiles(memoryDir)
  const exists = fileCount > 0 || (await directoryExists(memoryDir))
  if (!exists) return []
  return [
    {
      id: GLOBAL_PROJECT_ID,
      label: memoryDir,
      memoryDir,
      exists: true,
      fileCount,
      isCurrent: true,
    },
  ]
}

async function listMemoryFiles(): Promise<MemoryFile[]> {
  const memoryDir = getAutoMemPath()
  if (!(await directoryExists(memoryDir))) return []

  const files: MemoryFile[] = []

  async function walk(dir: string, prefix = ''): Promise<void> {
    if (files.length >= MAX_MEMORY_FILES) return

    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    for (const entry of entries) {
      if (files.length >= MAX_MEMORY_FILES) break
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue

      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath, relativePath)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue

      const stat = await fs.stat(fullPath)
      let type: string | undefined
      let description: string | undefined
      try {
        if (stat.size <= MAX_MEMORY_FILE_BYTES) {
          const raw = await fs.readFile(fullPath, 'utf-8')
          const parsed = parseFrontmatter(raw, fullPath)
          type = parseMemoryType(parsed.frontmatter.type) ?? undefined
          description =
            typeof parsed.frontmatter.description === 'string'
              ? parsed.frontmatter.description
              : undefined
        }
      } catch {
        // Metadata is best-effort. The file remains editable from the UI.
      }

      files.push({
        path: relativePath,
        name: entry.name,
        bytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
        type,
        description,
        title: relativePath === 'MEMORY.md' ? 'MEMORY.md' : entry.name.replace(/\.md$/, ''),
        isIndex: relativePath === 'MEMORY.md',
      })
    }
  }

  await walk(memoryDir)
  return files.sort((a, b) => {
    if (a.isIndex !== b.isIndex) return a.isIndex ? -1 : 1
    return a.path.localeCompare(b.path)
  })
}

async function handleMemoryFile(req: Request, url: URL): Promise<Response> {
  if (req.method === 'GET') {
    const relativePath = requireMemoryPath(url.searchParams.get('path'))
    const fullPath = await resolveMemoryFilePath(relativePath, {
      mustExist: true,
    })
    const stat = await fs.stat(fullPath)
    if (stat.size > MAX_MEMORY_FILE_BYTES) {
      throw ApiError.badRequest(`Memory file is too large to edit: ${relativePath}`)
    }
    return Response.json({
      file: {
        path: relativePath,
        content: await fs.readFile(fullPath, 'utf-8'),
        updatedAt: stat.mtime.toISOString(),
        bytes: stat.size,
      },
    })
  }

  if (req.method === 'PUT') {
    const body = await parseJsonBody(req)
    // projectId is ignored — all memory maps to the global directory.
    // Kept in the body schema for backward compatibility with the desktop client.
    const relativePath = requireMemoryPath(
      typeof body.path === 'string' ? body.path : undefined,
    )
    const content = typeof body.content === 'string' ? body.content : undefined
    if (content === undefined) {
      throw ApiError.badRequest('Missing or invalid "content" in request body')
    }
    if (Buffer.byteLength(content, 'utf-8') > MAX_MEMORY_FILE_BYTES) {
      throw ApiError.badRequest('Memory file content exceeds 512 KB')
    }

    const fullPath = await resolveMemoryFilePath(relativePath, {
      mustExist: false,
    })
    const memoryDir = getAutoMemPath()
    await fs.mkdir(path.dirname(fullPath), { recursive: true, mode: 0o700 })
    await assertWithinDirectory(path.dirname(fullPath), memoryDir, true)
    if (await fileExists(fullPath)) {
      await assertWithinDirectory(fullPath, memoryDir, true)
    }
    await fs.writeFile(fullPath, content, { encoding: 'utf-8', mode: 0o600 })
    const stat = await fs.stat(fullPath)
    return Response.json({
      ok: true,
      file: {
        path: relativePath,
        updatedAt: stat.mtime.toISOString(),
        bytes: stat.size,
      },
    })
  }

  throw methodNotAllowed(req.method)
}

function requireMemoryPath(value: string | null | undefined): string {
  if (!value || typeof value !== 'string') {
    throw ApiError.badRequest('Missing memory file path')
  }
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '')
  if (
    normalized.length === 0 ||
    normalized.includes('\0') ||
    normalized.split('/').some(part => part === '' || part === '.' || part === '..') ||
    !normalized.endsWith('.md')
  ) {
    throw ApiError.badRequest('Memory path must be a relative .md file path')
  }
  return normalized
}

async function resolveMemoryFilePath(
  relativePath: string,
  opts: { mustExist: boolean },
): Promise<string> {
  const memoryDir = getAutoMemPath()
  if (opts.mustExist && !(await directoryExists(memoryDir))) {
    throw ApiError.notFound('Memory directory not found')
  }
  const candidate = path.resolve(memoryDir, relativePath)
  await assertWithinDirectory(candidate, memoryDir, opts.mustExist)
  return candidate
}

async function assertWithinDirectory(
  candidate: string,
  directory: string,
  mustExist: boolean,
): Promise<void> {
  const resolvedDirectory = mustExist
    ? await safeRealpath(directory)
    : path.resolve(directory)
  const resolvedCandidate = mustExist
    ? await safeRealpath(candidate)
    : path.resolve(candidate)
  const boundary = resolvedDirectory.endsWith(path.sep)
    ? resolvedDirectory
    : `${resolvedDirectory}${path.sep}`
  if (resolvedCandidate !== resolvedDirectory && !resolvedCandidate.startsWith(boundary)) {
    throw ApiError.badRequest('Path escapes memory directory')
  }
}

async function safeRealpath(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath)
  } catch {
    return path.resolve(targetPath)
  }
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir)
    return stat.isDirectory()
  } catch {
    return false
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile()
  } catch {
    return false
  }
}

async function countMarkdownFiles(dir: string): Promise<number> {
  let count = 0
  async function walk(current: string): Promise<void> {
    if (count >= MAX_MEMORY_FILES) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (count >= MAX_MEMORY_FILES) break
      if (entry.name.startsWith('.')) continue
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        count++
      }
    }
  }
  await walk(dir)
  return count
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function methodNotAllowed(method: string): ApiError {
  return new ApiError(405, `Method ${method} not allowed`, 'METHOD_NOT_ALLOWED')
}
