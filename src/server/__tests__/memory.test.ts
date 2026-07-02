import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleMemoryApi } from '../api/memory.js'
import { getAutoMemPath, resetAutoMemPathCache } from '../../memdir/paths.js'

let tmpDir: string
let memoryDir: string
let originalOverride: string | undefined
let originalConfigDir: string | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-memory-api-'))
  // Pin the global memory directory to a test-controlled subdirectory under
  // tmpDir. The subdirectory is NOT created here, so tests that need it call
  // fs.mkdir(memoryDir, { recursive: true }). This lets the "empty state"
  // test observe projects=[] before any file exists.
  process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = path.join(tmpDir, 'memory')
  originalOverride = process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  resetAutoMemPathCache()
  memoryDir = getAutoMemPath()
})

afterEach(async () => {
  if (originalOverride !== undefined) {
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = originalOverride
  } else {
    delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  }
  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  resetAutoMemPathCache()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('memory API', () => {
  it('returns no projects when the global memory directory does not exist', async () => {
    const projectsRes = await request('GET', '/api/memory/projects')
    expect(projectsRes.status).toBe(200)
    const projectsBody = await projectsRes.json() as {
      projects: Array<{ id: string; isCurrent: boolean; exists: boolean }>
    }
    expect(projectsBody.projects).toEqual([])
  })

  it('lists global memory files with frontmatter metadata', async () => {
    await fs.mkdir(path.join(memoryDir, 'notes'), { recursive: true })
    await fs.writeFile(
      path.join(memoryDir, 'MEMORY.md'),
      [
        '---',
        'type: user',
        'description: Stable user context.',
        '---',
        '',
        '# Global Memory',
      ].join('\n'),
    )
    await fs.writeFile(path.join(memoryDir, 'notes', 'manual.md'), '# Manual')

    const projectsRes = await request('GET', '/api/memory/projects')
    expect(projectsRes.status).toBe(200)
    const projectsBody = await projectsRes.json() as {
      projects: Array<{ id: string; isCurrent: boolean; fileCount: number }>
    }
    expect(projectsBody.projects).toHaveLength(1)
    expect(projectsBody.projects[0]).toMatchObject({
      isCurrent: true,
      fileCount: 2,
    })

    const filesRes = await request('GET', '/api/memory/files')
    expect(filesRes.status).toBe(200)
    const filesBody = await filesRes.json() as {
      files: Array<{ path: string; type?: string; description?: string; isIndex: boolean }>
    }
    expect(filesBody.files[0]).toMatchObject({
      path: 'MEMORY.md',
      type: 'user',
      description: 'Stable user context.',
      isIndex: true,
    })
    expect(filesBody.files.some((file) => file.path === 'notes/manual.md')).toBe(true)
  })

  it('reads and writes only markdown files inside the global memory directory', async () => {
    const writeRes = await request('PUT', '/api/memory/file', {
      path: 'notes/identity.md',
      content: '# Edited Memory\n',
    })
    expect(writeRes.status).toBe(200)

    const filePath = path.join(memoryDir, 'notes', 'identity.md')
    expect(await fs.readFile(filePath, 'utf-8')).toBe('# Edited Memory\n')

    const readRes = await request('GET', `/api/memory/file?path=${encodeURIComponent('notes/identity.md')}`)
    expect(readRes.status).toBe(200)
    const body = await readRes.json() as { file: { path: string; content: string } }
    expect(body.file).toMatchObject({
      path: 'notes/identity.md',
      content: '# Edited Memory\n',
    })
  })

  it('rejects path traversal outside the memory directory', async () => {
    await fs.mkdir(memoryDir, { recursive: true })
    const traversalRes = await request('PUT', '/api/memory/file', {
      path: '../outside.md',
      content: 'escape',
    })
    expect(traversalRes.status).toBe(400)
  })

  it.skipIf(process.platform === 'win32')('rejects traversal and symlink escapes', async () => {
    const outsideDir = path.join(tmpDir, 'outside')
    await fs.mkdir(memoryDir, { recursive: true })
    await fs.mkdir(outsideDir, { recursive: true })
    await fs.symlink(outsideDir, path.join(memoryDir, 'linked'), 'dir')

    const traversalRes = await request('PUT', '/api/memory/file', {
      path: '../outside.md',
      content: 'escape',
    })
    expect(traversalRes.status).toBe(400)

    const symlinkRes = await request('PUT', '/api/memory/file', {
      path: 'linked/outside.md',
      content: 'escape',
    })
    expect(symlinkRes.status).toBe(400)
    await expect(fs.readFile(path.join(outsideDir, 'outside.md'), 'utf-8')).rejects.toThrow()
  })

  it('ignores projectId in the request body (backward compatibility)', async () => {
    const writeRes = await request('PUT', '/api/memory/file', {
      projectId: 'some-legacy-project-id',
      path: 'compat.md',
      content: '# compat\n',
    })
    expect(writeRes.status).toBe(200)
    expect(await fs.readFile(path.join(memoryDir, 'compat.md'), 'utf-8')).toBe('# compat\n')
  })
})

function request(method: string, pathname: string, body?: Record<string, unknown>): Promise<Response> {
  const url = new URL(pathname, 'http://localhost:3456')
  const init: RequestInit = { method }
  if (body) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return handleMemoryApi(
    new Request(url.toString(), init),
    url,
    url.pathname.split('/').filter(Boolean),
  )
}
