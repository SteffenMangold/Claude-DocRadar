// Pure analysis of Markdown text and Claude transcript lines: no `$`, so it
// runs (and is checked) anywhere.
import type { DocCompression, DocRole } from '../types'

export const DAY = 86_400_000

/** What a session loads of a memory index, measured as Claude Code measures it. */
export type IndexSize = { lines: number; bytes: number }

/** Bytes as kilobytes with one decimal, so a size just over a limit never reads as the limit. */
export function kilobytes(bytes: number): string {
  return (Math.ceil(bytes / 100) / 10).toFixed(1).replace(/\.0$/, '')
}

/**
 * Lines and UTF-8 bytes of a memory index once its front matter and block-level
 * HTML comments are stripped, which Claude Code drops before it loads the index.
 */
export function measureIndex(text: string): IndexSize {
  const all = text.replace(/\r\n?/g, '\n').split('\n')
  const { end } = parseFrontMatter(all)
  const kept: string[] = []
  let inComment = false
  for (const line of all.slice(end)) {
    if (inComment) {
      if (line.includes('-->')) inComment = false
      continue
    }
    if (/^\s*<!--/.test(line)) {
      if (!line.includes('-->')) inComment = true
      continue
    }
    kept.push(line)
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  const body = kept.join('\n')
  let bytes = 0
  for (let index = 0; index < body.length; index++) {
    const code = body.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code < 0xdc00) {
      bytes += 4
      index++
    } else bytes += 3
  }

  return { lines: kept.length, bytes }
}

/** What one Markdown text measures, before cross-file facts are known. */
export type MdMetrics = {
  words: number
  lines: number
  tokens: number
  headings: number
  hasTitle: boolean
  longestSectionWords: number
  functionWordRatio: number
  avgSegmentWords: number
  symbolsPer100: number
  bulletShare: number
  compression: DocCompression
  placeholders: number
  links: string[]
  mentions: string[]
  imports: string[]
  /** Normalized long lines, for duplicate detection across files. */
  shingles: string[]
  frontMatter: Record<string, string>
  adrStatus: string | null
}

const FUNCTION_WORDS = new Set(
  (
    'a an the and or but nor so yet if then than that this these those there here ' +
    'is are was were be been being am do does did done have has had having will would ' +
    'shall should can could may might must of in on at to from by with without for about ' +
    'into onto over under after before between through during within across per as ' +
    'it its they them their we our you your he she his her i me my not no only also ' +
    'which who whom whose what when where why how all any each every some such both ' +
    'more most less very just too again once own same other because while until ' +
    'der die das den dem des ein eine einer einem einen eines und oder aber doch wenn ' +
    'dann als wie ist sind war waren wird werden wurde wurden sein hat haben hatte ' +
    'kann können muss müssen soll sollen darf nicht kein keine zu von mit für auf in ' +
    'im am an aus bei nach über unter vor durch um ohne bis es sie er wir ihr ich du ' +
    'man sich auch noch nur schon so da dass was wer wo welche welcher welches dieser ' +
    'diese dieses jeder jede jedes alle mehr sehr hier dort'
  ).split(' '),
)

const PLACEHOLDER = /\b(TODO|TBD|FIXME|XXX)\b|lorem ipsum|coming soon/gi
const SYMBOLS = /→|⇒|⟶|←|↔|=>|->|<-|≥|≤|≈|≠|\s[+&=/]\s|;/g
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu
const LINK = /!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g
const REF_LINK = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/
const MD_MENTION = /(?:^|[\s`'"(\[])((?:\.{1,2}\/|\/)?[\w.@~-]+(?:\/[\w.@~-]+)*\.(?:md|mdx|markdown))\b/gi

const clamp = (value: number) => Math.min(1, Math.max(0, value))

/** Removes inline Markdown so only readable words stay. */
function plain(line: string): string {
  return line
    .replace(/<!--.*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`[^`]*`/g, ' code ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_~]+/g, '')
}

function words(text: string): string[] {
  return text.match(WORD) ?? []
}

function parseFrontMatter(lines: string[]): { data: Record<string, string>; end: number } {
  if (lines[0]?.trim() !== '---') return { data: {}, end: 0 }
  const data: Record<string, string> = {}
  for (let index = 1; index < Math.min(lines.length, 80); index++) {
    const line = lines[index] ?? ''
    if (line.trim() === '---') return { data, end: index + 1 }
    const pair = /^([\w-]+):\s*(.*)$/.exec(line)
    if (pair?.[1] !== undefined) data[pair[1]] = (pair[2] ?? '').replace(/^["']|["']$/g, '')
  }

  return { data: {}, end: 0 }
}

/** Measures one Markdown text: size, structure, prose style, links. */
export function analyzeMarkdown(text: string): MdMetrics {
  const all = text.replace(/\r\n?/g, '\n').split('\n')
  const { data: frontMatter, end } = parseFrontMatter(all)
  const lines = all.slice(end)
  let inFence = false
  let headings = 0
  let hasTitle = false
  let section = 0
  let longestSectionWords = 0
  let totalWords = 0
  let proseWords = 0
  let functionWords = 0
  let symbols = 0
  let listLines = 0
  let proseLines = 0
  let placeholders = 0
  const segments: number[] = []
  const links: string[] = []
  const mentions: string[] = []
  const imports: string[] = []
  const shingles: string[] = []
  let paragraph = ''
  let adrStatus: string | null = frontMatter['status'] ?? null
  let isStatusNext = false

  const flushParagraph = () => {
    if (paragraph.trim() === '') return
    for (const sentence of paragraph.split(/(?<=[.!?:])\s+/)) {
      const count = words(sentence).length
      if (count > 0) segments.push(count)
    }
    paragraph = ''
  }

  let inComment = false
  for (const raw of lines) {
    if (/^\s{0,3}(```|~~~)/.test(raw)) {
      inFence = !inFence
      flushParagraph()
      continue
    }
    if (inFence) continue
    placeholders += (raw.match(PLACEHOLDER) ?? []).length

    // What an HTML comment holds is not shown, so its links neither work nor break.
    let line = raw.trimEnd()
    if (inComment) {
      const close = line.indexOf('-->')
      if (close < 0) continue
      line = line.slice(close + 3)
      inComment = false
    }
    line = line.replace(/<!--.*?-->/g, ' ')
    const open = line.indexOf('<!--')
    if (open >= 0) {
      line = line.slice(0, open)
      inComment = true
    }

    const importMatch = /^@(\S+\.(?:md|mdx|markdown))\s*$/i.exec(line)
    if (importMatch?.[1] !== undefined) imports.push(importMatch[1])

    for (const match of line.matchAll(LINK)) {
      if (match[2] !== undefined) links.push(match[2])
    }
    const refLink = REF_LINK.exec(line)
    if (refLink?.[1] !== undefined) links.push(refLink[1])
    for (const match of line.matchAll(MD_MENTION)) {
      if (match[1] !== undefined) mentions.push(match[1])
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      headings++
      if (heading[1] === '#' && headings === 1) hasTitle = true
      longestSectionWords = Math.max(longestSectionWords, section)
      section = 0
      const title = heading[2] ?? ''
      totalWords += words(plain(title)).length
      isStatusNext = /^status\b/i.test(title)
      continue
    }

    const statusLine = /^\s*(?:[-*]\s*)?(?:\*\*|__)?status(?:\*\*|__)?\s*[:|-]\s*(?:\*\*|__)?\s*([A-Za-z]+)/i.exec(line)
    if (adrStatus === null && statusLine?.[1] !== undefined) adrStatus = statusLine[1]
    if (adrStatus === null && isStatusNext && line.trim() !== '') {
      adrStatus = words(plain(line))[0] ?? null
      isStatusNext = false
    }

    const text = plain(line)
    const lineWords = words(text)
    totalWords += lineWords.length
    section += lineWords.length

    if (lineWords.length >= 8) {
      shingles.push(lineWords.join(' ').toLowerCase())
    }

    const isTable = /^\s*\|/.test(line)
    if (line.trim() === '' || isTable) {
      flushParagraph()
      continue
    }

    proseLines++
    proseWords += lineWords.length
    for (const word of lineWords) {
      if (FUNCTION_WORDS.has(word.toLowerCase())) functionWords++
    }
    symbols += (` ${line} `.match(SYMBOLS) ?? []).length

    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (item) {
      flushParagraph()
      listLines++
      paragraph = item[1] ?? ''
      flushParagraph()
    } else {
      paragraph += ` ${line}`
    }
  }
  flushParagraph()
  longestSectionWords = Math.max(longestSectionWords, section)

  const functionWordRatio = proseWords === 0 ? 0 : functionWords / proseWords
  const avgSegmentWords =
    segments.length === 0 ? 0 : segments.reduce((sum, n) => sum + n, 0) / segments.length
  const symbolsPer100 = proseWords === 0 ? 0 : (symbols * 100) / proseWords
  const bulletShare = proseLines === 0 ? 0 : listLines / proseLines

  return {
    words: totalWords,
    lines: all.length,
    tokens: Math.round(text.length / 4),
    headings,
    hasTitle: hasTitle || frontMatter['name'] !== undefined || frontMatter['title'] !== undefined,
    longestSectionWords,
    functionWordRatio,
    avgSegmentWords,
    symbolsPer100,
    bulletShare,
    compression: classifyCompression(functionWordRatio, avgSegmentWords, symbolsPer100, bulletShare, proseWords),
    placeholders,
    links,
    mentions,
    imports,
    shingles,
    frontMatter,
    adrStatus,
  }
}

/** Weighs the style signals into one label; telegraphic text loses its function words first. */
export function classifyCompression(
  functionWordRatio: number,
  avgSegmentWords: number,
  symbolsPer100: number,
  bulletShare: number,
  proseWords: number,
): DocCompression {
  if (proseWords < 40) return 'balanced'
  const score = compressionScore(functionWordRatio, avgSegmentWords, symbolsPer100, bulletShare)
  if (score >= 0.62) return 'compressed'
  if (score >= 0.45) return 'dense'
  if (functionWordRatio > 0.48 && avgSegmentWords > 24) return 'verbose'

  return 'balanced'
}

/** 0 for relaxed prose, 1 for keyword-only notes. */
export function compressionScore(
  functionWordRatio: number,
  avgSegmentWords: number,
  symbolsPer100: number,
  bulletShare: number,
): number {
  return (
    0.45 * clamp((0.4 - functionWordRatio) / 0.18) +
    0.25 * clamp((12 - avgSegmentWords) / 7) +
    0.2 * clamp(symbolsPer100 / 5) +
    0.1 * clamp((bulletShare - 0.4) / 0.5)
  )
}

/** Folds `.` and `..` out of a slash path; null when it climbs above the root. */
export function normalizePath(path: string): string | null {
  const out: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(part)
  }

  return out.join('/')
}

export function dirOf(path: string): string {
  const cut = path.lastIndexOf('/')

  return cut < 0 ? '' : path.slice(0, cut)
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Resolves a link target written in `from` to a project path, or null for an external one. */
export function resolveLink(from: string, target: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//')) {
    return null
  }
  let clean = target.split('#')[0]?.split('?')[0] ?? ''
  try {
    clean = decodeURIComponent(clean)
  } catch {
    // A stray % stays as written.
  }
  if (clean === '') return null

  return clean.startsWith('/')
    ? normalizePath(clean)
    : normalizePath(`${dirOf(from)}/${clean}`)
}

/** Decides how a file is consumed from its path and front matter. */
export function roleOf(
  path: string,
  frontMatter: Record<string, string>,
  adrStatus: string | null,
  isAlways: boolean,
): { role: DocRole; label: string } {
  const lower = path.toLowerCase()
  const name = baseName(lower)

  if (lower.startsWith('~memory/')) {
    return isAlways
      ? { role: 'always', label: 'Memory-Index · immer im Kontext' }
      : { role: 'memory', label: `Claude-Memory${frontMatter['type'] !== undefined ? ` (${frontMatter['type']})` : ''}` }
  }
  if (isAlways) return { role: 'always', label: 'Immer im Kontext (CLAUDE.md-Kette)' }

  const command = /^\.claude\/commands\/(.+)\.md$/i.exec(path)
  if (command?.[1] !== undefined) {
    return { role: 'command', label: `Slash-Command /${command[1].replace(/\//g, ':')}` }
  }
  const skill = /(?:^|\/)\.claude\/skills\/([^/]+)\/skill\.md$/i.exec(lower)
  if (skill?.[1] !== undefined) return { role: 'skill', label: `Skill ${skill[1]}` }
  const agent = /^\.claude\/agents\/(.+)\.md$/i.exec(path)
  if (agent?.[1] !== undefined) return { role: 'subagent', label: `Subagent ${agent[1]}` }

  if (/\.instructions\.md$/.test(name) || lower.startsWith('.claude/rules/') || lower.startsWith('.cursor/rules/')) {
    const glob = frontMatter['applyTo'] ?? frontMatter['paths'] ?? frontMatter['globs']

    return { role: 'rule', label: `Pfad-Regel${glob !== undefined ? ` (${glob})` : ''}` }
  }
  if (['agents.md', 'claude.md', 'gemini.md', 'copilot-instructions.md', 'claude.local.md'].includes(name)) {
    return { role: 'agent', label: 'Agent-Anweisung' }
  }
  if (/(^|\/)(adr|adrs|decisions)\/[a-z]*-?\d{3,4}[-_]/i.test(lower)) {
    return { role: 'adr', label: `ADR${adrStatus !== null ? ` · ${adrStatus}` : ''}` }
  }
  if (name.includes('template')) return { role: 'template', label: 'Vorlage' }
  if (/^readme(\.|$)/.test(name)) return { role: 'readme', label: 'README · Einstieg' }

  return { role: 'doc', label: 'Doku · bei Bedarf gelesen' }
}

/** A compact usage event: [epoch ms, kind, value]. */
export type UsageEvent = [number, UsageKind, string]

/** read, shell read, edit, @-mention, slash command, skill, subagent. */
export type UsageKind = 'r' | 's' | 'e' | 'm' | 'c' | 'k' | 'a'

/** What one transcript file contributes. */
export type TranscriptFacts = {
  start: number | null
  end: number | null
  hasPrompt: boolean
  events: UsageEvent[]
}

const READ_TOOLS = new Set(['Read'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const MD_IN_TEXT = /[^\s"'`|<>;&()]+\.(?:md|mdx|markdown)\b/gi
const READ_VERBS = new Set([
  'cat', 'head', 'tail', 'sed', 'awk', 'less', 'more', 'bat', 'type', 'grep', 'egrep', 'fgrep', 'rg',
  'findstr', 'nl', 'cut', 'diff', 'cmp', 'get-content', 'gc', 'select-string', 'sls',
])
const LEADING = new Set(['do', 'then', 'else', 'sudo', 'xargs', 'time', '{', '(', '!'])
const GIT_READS = new Set(['diff', 'show', 'blame'])

/** The Markdown files a shell command reads: segments led by a read verb, and a `for` list feeding one. */
export function shellReads(command: string): string[] {
  const segments = command.split(/&&|\|\||[;|\n]/).map(segment => {
    const words = segment.trim().replace(/^(?:\w+=\S*\s+)+/, '').split(/\s+/)
    while (words.length > 1 && LEADING.has((words[0] ?? '').toLowerCase())) words.shift()
    const verb = (words[0] ?? '').toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/, '')
    const isRead = READ_VERBS.has(verb) || (verb === 'git' && GIT_READS.has((words[1] ?? '').toLowerCase()))

    return { segment, verb, isRead }
  })
  const hasRead = segments.some(part => part.isRead)
  const found = new Set<string>()
  for (const part of segments) {
    if (!part.isRead && !(hasRead && part.verb === 'for')) continue
    for (const path of part.segment.match(MD_IN_TEXT) ?? []) found.add(path)
  }

  return [...found]
}

const AT_MENTION = /(?:^|\s)@("[^"]+\.(?:md|mdx|markdown)"|[^\s"']+\.(?:md|mdx|markdown))/gi

type Line = {
  type?: string
  timestamp?: string
  isMeta?: boolean
  message?: { role?: string; content?: unknown }
}

type Block = { type?: string; id?: string; name?: string; input?: Record<string, unknown>; text?: string }

/** Pulls the Markdown-related events out of one JSONL transcript. */
export function parseTranscript(text: string): TranscriptFacts {
  const facts: TranscriptFacts = { start: null, end: null, hasPrompt: false, events: [] }
  const seen = new Set<string>()

  for (const raw of text.split('\n')) {
    const stamp = /"timestamp":"([^"]+)"/.exec(raw)?.[1]
    const at = stamp === undefined ? NaN : Date.parse(stamp)
    if (!Number.isNaN(at)) {
      if (facts.start === null) facts.start = at
      facts.end = at
    }

    const isAssistant = raw.includes('"tool_use"')
    const isCommand = raw.includes('<command-name>')
    const isUser = raw.includes('"type":"user"')
    if (isUser && !raw.includes('"tool_result"')) facts.hasPrompt = true
    const isMention = isUser && raw.includes('@') && /\.(?:md|mdx|markdown)\b/i.test(raw)
    if (!isAssistant && !isCommand && !isMention) continue

    let line: Line
    try {
      line = JSON.parse(raw) as Line
    } catch {
      continue
    }
    if (Number.isNaN(at)) continue
    const content = line.message?.content

    if (line.type === 'assistant' && Array.isArray(content)) {
      for (const block of content as Block[]) {
        if (block.type !== 'tool_use' || block.name === undefined) continue
        if (block.id !== undefined) {
          if (seen.has(block.id)) continue
          seen.add(block.id)
        }
        const input = block.input ?? {}
        const file = typeof input['file_path'] === 'string' ? input['file_path'] : undefined
        if (READ_TOOLS.has(block.name) && file !== undefined) {
          facts.events.push([at, 'r', file])
        } else if (EDIT_TOOLS.has(block.name) && file !== undefined) {
          facts.events.push([at, 'e', file])
        } else if (SHELL_TOOLS.has(block.name) && typeof input['command'] === 'string') {
          for (const path of shellReads(input['command'])) facts.events.push([at, 's', path])
        } else if (block.name === 'Skill' && typeof input['skill'] === 'string') {
          facts.events.push([at, 'k', input['skill']])
        } else if ((block.name === 'Agent' || block.name === 'Task') && typeof input['subagent_type'] === 'string') {
          facts.events.push([at, 'a', input['subagent_type']])
        }
      }
      continue
    }

    if (line.type !== 'user') continue
    const texts =
      typeof content === 'string'
        ? [content]
        : Array.isArray(content)
          ? (content as Block[]).filter(block => block.type === 'text').map(block => block.text ?? '')
          : []
    for (const body of texts) {
      const command = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(body)?.[1]
      if (command !== undefined) facts.events.push([at, 'c', command])
      if (line.isMeta === true) continue
      for (const match of body.matchAll(AT_MENTION)) {
        if (match[1] !== undefined) facts.events.push([at, 'm', match[1].replace(/"/g, '')])
      }
    }
  }

  return facts
}

/** 32-bit FNV-1a of a text, as hex: enough to notice a changed file. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** The share of `own` lines that also stand in another file, and the file sharing most. */
export function duplication(
  path: string,
  own: readonly string[],
  owners: ReadonlyMap<string, ReadonlySet<string>>,
): { share: number; with: string | null } {
  if (own.length === 0) return { share: 0, with: null }
  const counts = new Map<string, number>()
  let shared = 0
  for (const line of own) {
    const others = [...(owners.get(line) ?? [])].filter(other => other !== path)
    if (others.length === 0) continue
    shared++
    for (const other of others) counts.set(other, (counts.get(other) ?? 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]

  return { share: shared / own.length, with: top?.[0] ?? null }
}

/** Score inputs that need the whole project. */
export type ScoreInput = {
  role: DocRole
  metrics: MdMetrics
  brokenLinks: number
  inbound: number
  duplicateShare: number
  duplicateWith: string | null
  isEntryPoint: boolean
  daysSinceChange: number | null
  /** A memory file the memory index does not point to. */
  isUnindexed?: boolean
  /** For the memory index: its size, and how much of it Claude Code loads. */
  indexLoad?: { size: IndexSize; limit: IndexSize }
}

/** What lowered a score: problems are real defects worth a flag, hints only matters of style. */
export type ScoreResult = { score: number; grade: string; problems: string[]; hints: string[] }

/** Heuristic 0-100 quality score with the reasons that lowered it. */
export function scoreDoc(input: ScoreInput): ScoreResult {
  const { role, metrics } = input
  const problems: string[] = []
  const hints: string[] = []
  let score = 100
  const isTemplate = role === 'template' || role === 'command'
  // A template is a skeleton by design: short, terse and untitled is its shape.
  const isSkeleton = role === 'template'
  const percent = (share: number) => `${Math.round(share * 100)} %`

  if (!metrics.hasTitle && !['command', 'skill', 'subagent', 'memory', 'rule', 'template'].includes(role)) {
    score -= 8
    hints.push('Kein H1-Titel')
  }
  if (input.brokenLinks > 0) {
    score -= Math.min(30, input.brokenLinks * 8)
    problems.push(`${input.brokenLinks} kaputte${input.brokenLinks === 1 ? 'r' : ''} Link${input.brokenLinks === 1 ? '' : 's'}`)
  }
  if (metrics.placeholders > 0 && !isTemplate) {
    score -= Math.min(20, metrics.placeholders * 4)
    problems.push(`${metrics.placeholders}× TODO/TBD/FIXME`)
  }
  const minimum = role === 'memory' ? 15 : role === 'adr' ? 120 : 60
  if (metrics.words < minimum && role !== 'always' && !isSkeleton) {
    score -= 15
    hints.push(`Sehr kurz (${metrics.words} Wörter)`)
  }
  if (isSkeleton) {
    // No style verdict for a skeleton.
  } else if (metrics.compression === 'compressed') {
    score -= 15
    problems.push('Stark komprimiert')
  } else if (metrics.compression === 'dense') {
    score -= 5
    hints.push('Dicht geschrieben')
  } else if (metrics.compression === 'verbose') {
    score -= 8
    hints.push('Wortreich, lange Sätze')
  }
  if (metrics.longestSectionWords > 700) {
    score -= 8
    hints.push(`Abschnitt mit ${metrics.longestSectionWords} Wörtern ohne Überschrift`)
  }
  if (input.duplicateShare >= 0.3) {
    score -= 15
    problems.push(`${percent(input.duplicateShare)} doppelt mit ${input.duplicateWith ?? '?'}`)
  } else if (input.duplicateShare >= 0.12) {
    score -= 6
    hints.push(`${percent(input.duplicateShare)} doppelt mit ${input.duplicateWith ?? '?'}`)
  }
  if (input.inbound === 0 && !input.isEntryPoint) {
    score -= 10
    problems.push('Verwaist, nirgends verlinkt')
  }
  if (input.isUnindexed === true) {
    score -= 10
    problems.push('Fehlt im MEMORY.md-Index')
  }
  if (input.indexLoad !== undefined) {
    const { size, limit } = input.indexLoad
    // Counted as Claude Code counts them, without front matter and comments: no line number of the file.
    if (size.lines > limit.lines) {
      score -= 15
      problems.push(`${size.lines} Zeilen: nur ${limit.lines} geladen`)
    } else if (size.bytes > limit.bytes) {
      score -= 15
      problems.push(`${kilobytes(size.bytes)} KB: nur ${kilobytes(limit.bytes)} KB geladen`)
    }
  }
  if (role === 'always' && metrics.tokens > 4000) {
    score -= 10
    problems.push(`Teuer: ~${Math.round(metrics.tokens / 100) / 10}k Tokens je Session`)
  }
  if (input.daysSinceChange !== null && input.daysSinceChange > 365 && role !== 'adr') {
    score -= 8
    hints.push(`Seit ${Math.round(input.daysSinceChange / 30)} Monaten unverändert`)
  }

  score = Math.max(0, Math.min(100, score))
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : 'D'

  return { score, grade, problems, hints }
}
