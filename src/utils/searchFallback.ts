import { readdir, readFile, stat } from 'fs/promises'
import { dirname, isAbsolute, join, relative } from 'path'
import picomatch from 'picomatch'

const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.jj',
  'node_modules',
  'target',
  'dist',
  'build',
])

type WalkOptions = {
  signal: AbortSignal
  includeHidden?: boolean
  ignorePatterns?: string[]
}

type GrepFallbackOptions = {
  rootPath: string
  pattern: string
  outputMode: 'content' | 'files_with_matches' | 'count'
  glob?: string
  type?: string
  caseInsensitive?: boolean
  showLineNumbers?: boolean
  multiline?: boolean
  beforeContext?: number
  afterContext?: number
  ignorePatterns?: string[]
  signal: AbortSignal
}

const TYPE_EXTENSIONS: Record<string, string[]> = {
  js: ['.js', '.jsx', '.mjs', '.cjs'],
  ts: ['.ts', '.tsx', '.mts', '.cts'],
  py: ['.py', '.pyw'],
  rust: ['.rs'],
  go: ['.go'],
  java: ['.java'],
  json: ['.json', '.jsonc'],
  md: ['.md', '.markdown'],
  markdown: ['.md', '.markdown'],
  html: ['.html', '.htm'],
  css: ['.css'],
  txt: ['.txt'],
  yaml: ['.yaml', '.yml'],
}

function normalizePathForMatch(path: string): string {
  return path.replace(/\\/g, '/')
}

function patternMatcher(pattern: string): (value: string) => boolean {
  const normalized = normalizePathForMatch(pattern.replace(/^!/, ''))
  const candidates = normalized.startsWith('/') || normalized.includes('/')
    ? [normalized.replace(/^\//, '')]
    : [normalized, `**/${normalized}`]
  const matchers = candidates.map(candidate =>
    picomatch(candidate, { dot: true, nocase: process.platform === 'win32' }),
  )
  return value => matchers.some(matches => matches(value))
}

function buildIgnoreMatchers(ignorePatterns: string[] = []) {
  return ignorePatterns
    .filter(Boolean)
    .map(patternMatcher)
}

function isIgnored(relativePath: string, ignoreMatchers: Array<(value: string) => boolean>) {
  const normalized = normalizePathForMatch(relativePath)
  return ignoreMatchers.some(matches => matches(normalized))
}

function splitGlobPatterns(glob: string): string[] {
  const patterns: string[] = []
  for (const rawPattern of glob.split(/\s+/)) {
    if (!rawPattern) continue
    if (rawPattern.includes('{') && rawPattern.includes('}')) {
      patterns.push(rawPattern)
    } else {
      patterns.push(...rawPattern.split(',').filter(Boolean))
    }
  }
  return patterns
}

function extensionMatchesType(path: string, type?: string): boolean {
  if (!type) return true
  const extensions = TYPE_EXTENSIONS[type]
  if (!extensions) return true
  const lowerPath = path.toLowerCase()
  return extensions.some(ext => lowerPath.endsWith(ext))
}

async function walkFiles(rootPath: string, options: WalkOptions): Promise<string[]> {
  const ignoreMatchers = buildIgnoreMatchers(options.ignorePatterns)
  const files: Array<{ path: string; mtimeMs: number }> = []

  async function visit(directory: string) {
    options.signal.throwIfAborted()
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      options.signal.throwIfAborted()
      if (!options.includeHidden && entry.name.startsWith('.')) continue
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue

      const absolutePath = join(directory, entry.name)
      const relativePath = relative(rootPath, absolutePath)
      if (isIgnored(relativePath, ignoreMatchers)) continue

      if (entry.isDirectory()) {
        await visit(absolutePath)
      } else if (entry.isFile()) {
        let mtimeMs = 0
        try {
          mtimeMs = (await stat(absolutePath)).mtimeMs
        } catch {}
        files.push({ path: absolutePath, mtimeMs })
      }
    }
  }

  const rootStats = await stat(rootPath).catch(() => null)
  if (rootStats?.isFile()) return [rootPath]
  await visit(rootPath)

  files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path))
  return files.map(file => file.path)
}

export async function globWithNodeFallback({
  searchDir,
  searchPattern,
  ignorePatterns,
  includeHidden = true,
  signal,
}: {
  searchDir: string
  searchPattern: string
  ignorePatterns?: string[]
  includeHidden?: boolean
  signal: AbortSignal
}): Promise<string[]> {
  const match = patternMatcher(searchPattern)
  const files = await walkFiles(searchDir, {
    signal,
    includeHidden,
    ignorePatterns,
  })

  return files.filter(file => {
    const rel = normalizePathForMatch(relative(searchDir, file))
    return match(rel)
  })
}

export async function grepWithNodeFallback({
  rootPath,
  pattern,
  outputMode,
  glob,
  type,
  caseInsensitive,
  showLineNumbers = true,
  multiline,
  beforeContext = 0,
  afterContext = 0,
  ignorePatterns,
  signal,
}: GrepFallbackOptions): Promise<string[]> {
  const regexp = new RegExp(pattern, `${caseInsensitive ? 'i' : ''}${multiline ? 'ms' : ''}`)
  const globMatchers = glob
    ? splitGlobPatterns(glob).map(patternMatcher)
    : []

  const rootStats = await stat(rootPath).catch(() => null)
  const files = await walkFiles(rootPath, {
    signal,
    includeHidden: true,
    ignorePatterns,
  })

  const results: string[] = []
  for (const file of files) {
    signal.throwIfAborted()
    const rel = normalizePathForMatch(relative(rootStats?.isFile() ? dirname(rootPath) : rootPath, file))
    if (!extensionMatchesType(file, type)) continue
    if (globMatchers.length > 0 && !globMatchers.some(matches => matches(rel))) continue

    let content: string
    try {
      const buffer = await readFile(file)
      if (buffer.includes(0)) continue
      content = buffer.toString('utf8')
    } catch {
      continue
    }

    if (outputMode === 'files_with_matches') {
      if (regexp.test(content)) results.push(isAbsolute(file) ? file : join(rootPath, file))
      regexp.lastIndex = 0
      continue
    }

    const lines = content.split(/\r?\n/)
    const matchingLines: number[] = []
    for (let i = 0; i < lines.length; i++) {
      regexp.lastIndex = 0
      if (regexp.test(lines[i] ?? '')) matchingLines.push(i)
    }

    if (outputMode === 'count') {
      if (matchingLines.length > 0) results.push(`${file}:${matchingLines.length}`)
      continue
    }

    const emitted = new Set<number>()
    for (const lineIndex of matchingLines) {
      const start = Math.max(0, lineIndex - beforeContext)
      const end = Math.min(lines.length - 1, lineIndex + afterContext)
      for (let i = start; i <= end; i++) {
        if (emitted.has(i)) continue
        emitted.add(i)
        const prefix = showLineNumbers ? `${file}:${i + 1}:` : `${file}:`
        results.push(`${prefix}${lines[i] ?? ''}`)
      }
    }
  }

  return results
}
