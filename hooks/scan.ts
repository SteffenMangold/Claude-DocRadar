// Gathers the project's Markdown files, their git history and their use in
// the Claude transcripts, and turns them into one DocReport.
import type { EngineInterface } from 'claude-code'

import type { DocEntry, DocReport, DocUsage } from '../types'
import {
  DAY,
  analyzeMarkdown,
  baseName,
  compressionScore,
  dirOf,
  duplication,
  hashText,
  measureIndex,
  normalizePath,
  parseTranscript,
  resolveLink,
  roleOf,
  scoreDoc,
} from './analyze'
import type { MdMetrics, TranscriptFacts, UsageEvent } from './analyze'

type Engine = EngineInterface

/** One transcript's facts, kept in the store so history survives transcript cleanup. */
type CachedTranscript = {
  size: number
  mtimeMs: number
  session: string
  isMain: boolean
  start: number | null
  end: number | null
  hasPrompt: boolean
  ev: UsageEvent[]
}

// Bump `v` when parseTranscript changes what it extracts: older entries are parsed again.
type TranscriptCache = { v: 2; files: Record<string, CachedTranscript> }

const MD_PATTERNS = ['*.md', '*.mdx', '*.markdown']
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'bin', 'obj', 'dist', 'build', 'out', 'target', 'vendor', 'packages',
  '.vs', '.idea', '.venv', 'venv', '__pycache__', '.next', 'coverage', 'TestResults',
])
const ENTRY_NAMES = new Set(['contributing.md', 'changelog.md', 'security.md', 'license.md', 'code_of_conduct.md'])
const MAX_FILES = 600
const MAX_READ = 4 * 1024 * 1024
const MEMORY_INDEX = '~memory/MEMORY.md'
/**
 * What a session loads of MEMORY.md: the first 200 lines or 25 KB, whichever
 * comes first (code.claude.com/docs/en/memory). The docs leave the KB unit open;
 * 25,000 bytes errs on the side of a warning.
 */
const MEMORY_INDEX_LIMIT = { lines: 200, bytes: 25_000 }

/** Slash form, no trailing slash. */
function slash(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

async function git($: Engine, root: string, args: readonly string[]): Promise<string | null> {
  try {
    const result = await $.process.run(['git', '-c', 'core.quotePath=false', ...args], { cwd: root, timeoutMs: 30_000 })

    return result.exitCode === 0 ? result.stdout : null
  } catch {
    return null
  }
}

/** Lists Markdown files by walking the tree, for a project outside git. */
async function walk($: Engine, root: string): Promise<string[]> {
  const found: string[] = []
  const queue: [string, number][] = [['', 0]]
  while (queue.length > 0 && found.length < MAX_FILES) {
    const [dir, depth] = queue.shift() ?? ['', 0]
    const entries = await $.fs.list(dir === '' ? root : `${root}/${dir}`).catch(() => [])
    for (const entry of entries) {
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.kind === 'dir' && depth < 8 && !SKIP_DIRS.has(entry.name)) queue.push([path, depth + 1])
      if (entry.kind === 'file' && /\.(md|mdx|markdown)$/i.test(entry.name)) found.push(path)
    }
  }

  return found
}

async function readTranscript($: Engine, path: string, size: number): Promise<TranscriptFacts | null> {
  if (size <= MAX_READ) {
    const text = await $.fs.read(path).catch(() => null)

    return text === null ? null : parseTranscript(text)
  }
  // Too big for one read: let git pick the few lines that matter.
  const dir = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
  const lines = await $.process
    .run(['git', 'grep', '--no-index', '-h', '-F', '-e', '"tool_use"', '-e', '<command-name>', '--', baseName(slash(path))], {
      cwd: dir,
      timeoutMs: 120_000,
    })
    .catch(() => null)

  return lines === null || lines.exitCode > 1 ? null : parseTranscript(lines.stdout)
}

/** Every `*.jsonl` below a session folder (its subagents and workflows). */
async function nestedTranscripts($: Engine, dir: string, depth: number): Promise<{ path: string; size: number; mtimeMs: number }[]> {
  if (depth > 4) return []
  const entries = await $.fs.list(dir).catch(() => [])
  const out: { path: string; size: number; mtimeMs: number }[] = []
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`
    if (entry.kind === 'dir') out.push(...(await nestedTranscripts($, path, depth + 1)))
    else if (entry.kind === 'file' && entry.name.endsWith('.jsonl') && entry.name !== 'journal.jsonl') {
      out.push({ path, size: entry.size, mtimeMs: entry.mtimeMs })
    }
  }

  return out
}

/** Reads every transcript of the project, re-parsing only those that changed. */
async function loadTranscripts(
  $: Engine,
  projectsDir: string,
  dirName: string,
  isWindows: boolean,
  warnings: string[],
): Promise<CachedTranscript[]> {
  const key = `tx:${dirName}`
  const stored = (await $.store.get(key).catch(() => undefined)) as TranscriptCache | undefined
  const cache: TranscriptCache = stored?.v === 2 ? stored : { v: 2, files: {} }
  const same = (a: string, b: string) => (isWindows ? a.toLowerCase() === b.toLowerCase() : a === b)
  const dirs = (await $.fs.list(projectsDir).catch(() => [])).filter(
    entry =>
      entry.kind === 'dir' &&
      (same(entry.name, dirName) || (isWindows ? entry.name.toLowerCase() : entry.name).startsWith(`${isWindows ? dirName.toLowerCase() : dirName}--claude-worktrees-`)),
  )
  if (dirs.length === 0) warnings.push(`Keine Claude-Transkripte unter ${projectsDir}/${dirName}`)

  let isChanged = false
  let viaGit = 0
  for (const dir of dirs) {
    const base = `${projectsDir}/${dir.name}`
    const entries = await $.fs.list(base).catch(() => [])
    const found: { path: string; size: number; mtimeMs: number; session: string; isMain: boolean }[] = []
    for (const entry of entries) {
      if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) {
        found.push({ path: `${base}/${entry.name}`, size: entry.size, mtimeMs: entry.mtimeMs, session: entry.name.slice(0, -6), isMain: true })
      } else if (entry.kind === 'dir' && entry.name !== 'memory') {
        for (const nested of await nestedTranscripts($, `${base}/${entry.name}`, 0)) {
          found.push({ ...nested, session: entry.name, isMain: false })
        }
      }
    }
    for (const file of found) {
      const known = cache.files[file.path]
      if (known !== undefined && known.size === file.size && known.mtimeMs === file.mtimeMs) continue
      const facts = await readTranscript($, file.path, file.size)
      if (facts === null) continue
      if (file.size > MAX_READ) viaGit++
      cache.files[file.path] = {
        size: file.size,
        mtimeMs: file.mtimeMs,
        session: file.session,
        isMain: file.isMain,
        start: facts.start ?? file.mtimeMs,
        end: facts.end ?? file.mtimeMs,
        hasPrompt: facts.hasPrompt || file.size > MAX_READ,
        ev: facts.events,
      }
      isChanged = true
    }
  }
  if (viaGit > 0) warnings.push(`${viaGit} Transkript(e) über 4 MiB nur teilweise gelesen`)
  if (isChanged) await $.store.set(key, cache).catch(() => warnings.push('Nutzungs-Cache konnte nicht gespeichert werden'))

  return Object.values(cache.files)
}

function emptyUsage(): DocUsage {
  return {
    reads: 0,
    shellReads: 0,
    readSessions: 0,
    lastRead: null,
    edits: 0,
    lastEdit: null,
    mentions: 0,
    invocations: 0,
    lastInvoked: null,
    autoLoads: 0,
    lastAutoLoad: null,
    daily: Array.from({ length: 14 }, () => 0),
  }
}

const latest = (a: number | null, b: number) => (a === null || b > a ? b : a)

/** Scans the session's project. */
export async function scanProject($: Engine): Promise<DocReport> {
  const root = await $.session.root()
  const now = await $.clock.now()
  const isWindows = /^[A-Za-z]:[\\/]/.test(root) || root.startsWith('\\\\')
  const fold = (path: string) => (isWindows ? path.toLowerCase() : path)
  const warnings: string[] = []
  const rootSlash = slash(root)

  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  const configDir = slash((await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`)
  const dirName = root.replace(/[^a-zA-Z0-9]/g, '-')
  const projectsDir = `${configDir}/projects`
  // Claude Code keys memory to the git repository: a worktree's or a subfolder's is the main working tree's.
  const repoRoot = (await $.session.repo().catch(() => null))?.root ?? root
  const memoryDir = `${projectsDir}/${repoRoot.replace(/[^a-zA-Z0-9]/g, '-')}/memory`

  // Files: git knows what belongs to the project; a walk stands in without it.
  const prefix = (await git($, root, ['rev-parse', '--show-prefix']))?.trim()
  const isGit = prefix !== undefined
  let paths: string[]
  if (isGit) {
    const listed = await git($, root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...MD_PATTERNS])
    paths = [...new Set((listed ?? '').split('\0').filter(path => path !== ''))]
  } else {
    paths = await walk($, root)
    warnings.push('Kein Git-Repository: Historie fehlt')
  }
  if (paths.length > MAX_FILES) {
    warnings.push(`${paths.length} Dateien, nur die ersten ${MAX_FILES} ausgewertet`)
    paths = paths.slice(0, MAX_FILES)
  }
  const memoryFiles = (await $.fs.list(memoryDir).catch(() => []))
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.md'))
    .map(entry => `~memory/${entry.name}`)

  // Git history per file, newest commit first.
  const history = new Map<string, { commits: number; last: number; first: number }>()
  const dirty = new Set<string>()
  const tracked = new Set<string>()
  if (isGit) {
    const log = await git($, root, ['log', '--relative', '--format=@@%at', '--name-only', '--', ...MD_PATTERNS])
    let at = 0
    for (const line of (log ?? '').split('\n')) {
      if (line.startsWith('@@')) {
        at = Number(line.slice(2)) * 1000
      } else if (line.trim() !== '') {
        const key = fold(line.trim())
        const known = history.get(key)
        history.set(key, known === undefined ? { commits: 1, last: at, first: at } : { ...known, commits: known.commits + 1, first: at })
      }
    }
    const status = await git($, root, ['status', '--porcelain', '--', ...MD_PATTERNS])
    for (const line of (status ?? '').split('\n')) {
      const path = line.slice(3).split(' -> ').pop()?.trim().replace(/^"|"$/g, '')
      if (path !== undefined && path !== '') dirty.add(fold(path.startsWith(prefix) ? path.slice(prefix.length) : path))
    }
    const all = await git($, root, ['ls-files', '-z', '--', ...MD_PATTERNS])
    for (const path of (all ?? '').split('\0')) if (path !== '') tracked.add(fold(path))
  }

  // Read and measure every file.
  type Loaded = { path: string; abs: string; text: string; size: number; mtimeMs: number; metrics: MdMetrics }
  const loaded: Loaded[] = []
  for (const path of [...paths, ...memoryFiles]) {
    const abs = path.startsWith('~memory/') ? `${memoryDir}/${path.slice(8)}` : `${rootSlash}/${path}`
    const stat = await $.fs.stat(abs).catch(() => null)
    if (stat === null || stat.kind !== 'file' || stat.size > MAX_READ) continue
    const text = await $.fs.read(abs).catch(() => null)
    if (text === null) continue
    loaded.push({ path, abs, text, size: stat.size, mtimeMs: stat.mtimeMs, metrics: analyzeMarkdown(text) })
  }
  const index = new Map(loaded.map(file => [fold(file.path), file]))

  /** Finds a project file for a path written somewhere, trying the writer's folder, the root and a unique suffix. */
  const lookup = (written: string, fromDir: string): Loaded | undefined => {
    const candidates = [normalizePath(`${fromDir}/${written}`), normalizePath(written)]
    for (const candidate of candidates) {
      const hit = candidate === null ? undefined : index.get(fold(candidate))
      if (hit !== undefined) return hit
    }
    const tail = `/${fold(slash(written).replace(/^\.?\//, ''))}`
    const matches = loaded.filter(file => fold(`/${file.path}`).endsWith(tail))

    return matches.length === 1 ? matches[0] : undefined
  }

  // The CLAUDE.md chain: what every session loads before the first prompt.
  const always = new Set<string>()
  const follow = (file: Loaded | undefined, depth: number) => {
    if (file === undefined || depth > 5 || always.has(fold(file.path))) return
    always.add(fold(file.path))
    for (const target of file.metrics.imports) {
      if (!target.startsWith('~')) follow(lookup(target, dirOf(file.path)), depth + 1)
    }
  }
  for (const start of ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md', MEMORY_INDEX]) {
    follow(index.get(fold(start)), 0)
  }

  // Links, mentions and duplicates across files.
  const inbound = new Map<string, Set<string>>()
  const broken = new Map<string, string[]>()
  const existsCache = new Map<string, boolean>()
  const owners = new Map<string, Set<string>>()
  for (const file of loaded) {
    const fromDir = dirOf(file.path)
    const targets = new Set<string>()
    for (const link of file.metrics.links) {
      const resolved = resolveLink(file.path, link)
      if (resolved === null) continue
      const hit = index.get(fold(resolved))
      if (hit !== undefined) {
        targets.add(hit.path)
        continue
      }
      const abs = resolved.startsWith('~memory/') ? `${memoryDir}/${resolved.slice(8)}` : `${rootSlash}/${resolved}`
      let exists = existsCache.get(abs)
      if (exists === undefined) {
        exists = await $.fs.exists(abs).catch(() => true)
        existsCache.set(abs, exists)
      }
      if (!exists) broken.set(file.path, [...(broken.get(file.path) ?? []), link])
    }
    for (const mention of [...file.metrics.mentions, ...file.metrics.imports]) {
      const hit = lookup(mention, fromDir)
      if (hit !== undefined) targets.add(hit.path)
    }
    for (const target of targets) {
      if (target === file.path) continue
      inbound.set(target, (inbound.get(target) ?? new Set()).add(file.path))
    }
    for (const line of new Set(file.metrics.shingles)) {
      owners.set(line, (owners.get(line) ?? new Set()).add(file.path))
    }
  }

  // Claude's memory: the index every session loads, and the files it points to.
  const memoryIndex = index.get(fold(MEMORY_INDEX))
  const memoryPaths = loaded.filter(file => file.path.startsWith('~memory/')).map(file => file.path)
  const unindexed = memoryPaths.filter(path => path !== memoryIndex?.path && !(inbound.get(path)?.has(memoryIndex?.path ?? '') ?? false))
  const indexSize = memoryIndex === undefined ? { lines: 0, bytes: 0 } : measureIndex(memoryIndex.text)
  const memory =
    memoryPaths.length === 0
      ? null
      : {
          hasIndex: memoryIndex !== undefined,
          indexLines: indexSize.lines,
          indexBytes: indexSize.bytes,
          lineLimit: MEMORY_INDEX_LIMIT.lines,
          byteLimit: MEMORY_INDEX_LIMIT.bytes,
          unindexed,
          missing: memoryIndex === undefined ? [] : (broken.get(memoryIndex.path) ?? []),
        }

  // Usage, from every transcript of the project and its worktrees.
  const transcripts = await loadTranscripts($, projectsDir, dirName, isWindows, warnings)
  const usage = new Map(loaded.map(file => [file.path, emptyUsage()]))
  const sessionsOf = new Map<string, Set<string>>()
  const rootFold = fold(rootSlash)
  const memoryFold = fold(memoryDir)
  const today = Math.floor(now / DAY)
  const toFile = (kind: UsageEvent[1], value: string): Loaded | undefined => {
    if (kind === 'c') return index.get(fold(`.claude/commands/${value.replace(/:/g, '/')}.md`))
    if (kind === 'k') return index.get(fold(`.claude/skills/${value.split(':').pop() ?? value}/SKILL.md`))
    if (kind === 'a') return index.get(fold(`.claude/agents/${value}.md`))
    const path = slash(value.replace(/^["']|["']$/g, ''))
    const folded = fold(path)
    if (folded.startsWith(`${memoryFold}/`)) return index.get(`~memory/${folded.slice(memoryFold.length + 1)}`)
    if (/^([A-Za-z]:\/|\/)/.test(path)) {
      if (!folded.startsWith(`${rootFold}/`)) return undefined
      const relative = path.slice(rootSlash.length + 1).replace(/^\.claude\/worktrees\/[^/]+\//i, '')

      return index.get(fold(relative))
    }

    return lookup(path, '')
  }

  let sessions = 0
  let firstActivity: number | null = null
  const sessionDays: number[] = []
  let lastSession: number | null = null
  for (const transcript of transcripts) {
    if (transcript.start !== null) firstActivity = firstActivity === null ? transcript.start : Math.min(firstActivity, transcript.start)
    if (transcript.isMain && transcript.hasPrompt) {
      sessions++
      const end = transcript.end ?? transcript.mtimeMs
      lastSession = latest(lastSession, end)
      sessionDays.push(Math.floor(end / DAY))
    }
    for (const [at, kind, value] of transcript.ev) {
      const file = toFile(kind, value)
      if (file === undefined) continue
      const entry = usage.get(file.path)
      if (entry === undefined) continue
      const age = today - Math.floor(at / DAY)
      const isUse = kind !== 'e'
      if (isUse && age >= 0 && age < 14) entry.daily[13 - age] = (entry.daily[13 - age] ?? 0) + 1
      if (kind === 'r' || kind === 's' || kind === 'm') {
        if (kind === 'r') entry.reads++
        if (kind === 's') entry.shellReads++
        if (kind === 'm') entry.mentions++
        entry.lastRead = latest(entry.lastRead, at)
        sessionsOf.set(file.path, (sessionsOf.get(file.path) ?? new Set()).add(transcript.session))
      } else if (kind === 'e') {
        entry.edits++
        entry.lastEdit = latest(entry.lastEdit, at)
      } else {
        entry.invocations++
        entry.lastInvoked = latest(entry.lastInvoked, at)
      }
    }
  }

  // One entry per file.
  const files: DocEntry[] = loaded.map(file => {
    const key = fold(file.path)
    const isAlways = always.has(key)
    const { role, label } = roleOf(file.path, file.metrics.frontMatter, file.metrics.adrStatus, isAlways)
    const fileUsage = usage.get(file.path) ?? emptyUsage()
    fileUsage.readSessions = sessionsOf.get(file.path)?.size ?? 0
    if (isAlways) {
      fileUsage.autoLoads = sessions
      fileUsage.lastAutoLoad = lastSession
      for (const day of sessionDays) {
        const age = today - day
        if (age >= 0 && age < 14) fileUsage.daily[13 - age] = (fileUsage.daily[13 - age] ?? 0) + 1
      }
    }
    const found = history.get(key)
    const git = {
      commits: found?.commits ?? 0,
      lastCommit: found?.last ?? null,
      firstCommit: found?.first ?? null,
      isDirty: dirty.has(key) || (isGit && !file.path.startsWith('~memory/') && !tracked.has(key)),
      isTracked: tracked.has(key),
    }
    const name = baseName(file.path).toLowerCase()
    const isEntryPoint =
      ['readme', 'always', 'agent', 'rule', 'command', 'skill', 'subagent', 'memory', 'template'].includes(role) ||
      ENTRY_NAMES.has(name) ||
      file.path.startsWith('.github/')
    const links = inbound.get(file.path) ?? new Set<string>()
    const dup = duplication(file.path, [...new Set(file.metrics.shingles)], owners)
    const changed = git.lastCommit ?? file.mtimeMs
    const brokenLinks = broken.get(file.path) ?? []
    const verdictScore = scoreDoc({
      role,
      metrics: file.metrics,
      brokenLinks: brokenLinks.length,
      inbound: links.size,
      duplicateShare: dup.share,
      duplicateWith: dup.with,
      isEntryPoint,
      daysSinceChange: (now - changed) / DAY,
      isUnindexed: role === 'memory' && unindexed.includes(file.path),
      indexLoad: file.path === memoryIndex?.path ? { size: indexSize, limit: MEMORY_INDEX_LIMIT } : undefined,
    })
    const lastUse = Math.max(fileUsage.lastRead ?? 0, fileUsage.lastInvoked ?? 0)
    const verdict =
      role === 'always'
        ? 'always'
        : lastUse > 0 && now - lastUse <= 14 * DAY
          ? 'active'
          : lastUse > 0
            ? 'rare'
            : fileUsage.edits > 0
              ? 'write-only'
              : 'unused'
    const { metrics } = file

    return {
      path: file.path,
      absPath: isWindows ? file.abs.replace(/\//g, '\\') : file.abs,
      name: baseName(file.path),
      role,
      roleLabel: label,
      size: file.size,
      mtimeMs: file.mtimeMs,
      hash: hashText(file.text),
      git,
      usage: fileUsage,
      quality: {
        words: metrics.words,
        lines: metrics.lines,
        tokens: metrics.tokens,
        headings: metrics.headings,
        hasTitle: metrics.hasTitle,
        longestSectionWords: metrics.longestSectionWords,
        functionWordRatio: metrics.functionWordRatio,
        avgSegmentWords: metrics.avgSegmentWords,
        symbolsPer100: metrics.symbolsPer100,
        bulletShare: metrics.bulletShare,
        compression: metrics.compression,
        compressionScore: compressionScore(metrics.functionWordRatio, metrics.avgSegmentWords, metrics.symbolsPer100, metrics.bulletShare),
        brokenLinks,
        placeholders: metrics.placeholders,
        inbound: [...links].sort(),
        duplicateShare: dup.share,
        duplicateWith: dup.with,
        score: verdictScore.score,
        grade: verdictScore.grade,
        problems: verdictScore.problems,
        hints: verdictScore.hints,
      },
      verdict,
    } satisfies DocEntry
  })

  return {
    root,
    projectName: baseName(rootSlash) || rootSlash,
    scannedAt: now,
    isGit,
    sessions,
    transcripts: transcripts.length,
    firstActivity,
    files,
    memory,
    warnings,
  }
}

/** The text a file holds now, for a review. */
export async function readDoc($: Engine, absPath: string): Promise<string> {
  return $.fs.read(absPath)
}
