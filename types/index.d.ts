/** How a Markdown file is consumed in the project. */
export type DocRole =
  | 'always'
  | 'agent'
  | 'rule'
  | 'command'
  | 'skill'
  | 'subagent'
  | 'readme'
  | 'doc'
  | 'adr'
  | 'template'
  | 'memory'

/** Whether a file is used, judged from the Claude transcripts. */
export type DocVerdict = 'always' | 'active' | 'rare' | 'write-only' | 'unused'

/** How tightly the prose is written. */
export type DocCompression = 'verbose' | 'balanced' | 'dense' | 'compressed'

/** Usage of one file, counted from the Claude transcripts of the project. */
export type DocUsage = {
  reads: number
  shellReads: number
  readSessions: number
  lastRead: number | null
  edits: number
  lastEdit: number | null
  mentions: number
  invocations: number
  lastInvoked: number | null
  autoLoads: number
  lastAutoLoad: number | null
  /** Uses per day over the last 14 days, oldest first. */
  daily: number[]
}

/** Git facts of one file. */
export type DocGit = {
  commits: number
  lastCommit: number | null
  firstCommit: number | null
  isDirty: boolean
  isTracked: boolean
}

/** Static metrics and the heuristic quality verdict of one file. */
export type DocQuality = {
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
  /** 0 for relaxed prose, 1 for keyword-only notes. */
  compressionScore: number
  brokenLinks: string[]
  placeholders: number
  inbound: string[]
  duplicateShare: number
  duplicateWith: string | null
  score: number
  grade: string
  /** Real defects: flagged in the row and counted in the header. */
  problems: string[]
  /** Matters of style: shown in the details only. */
  hints: string[]
}

/** One Markdown file of the project with everything the sidebar shows. */
export type DocEntry = {
  path: string
  absPath: string
  name: string
  role: DocRole
  roleLabel: string
  size: number
  mtimeMs: number
  hash: string
  git: DocGit
  usage: DocUsage
  quality: DocQuality
  verdict: DocVerdict
}

/** The health of Claude's memory index for the project. */
export type MemoryState = {
  /** Whether the memory folder holds a MEMORY.md. */
  hasIndex: boolean
  /** Lines and UTF-8 bytes of MEMORY.md without front matter and HTML comment blocks. */
  indexLines: number
  indexBytes: number
  /** What a session loads of MEMORY.md, the first of the two reached; the rest is cut. */
  lineLimit: number
  byteLimit: number
  /** Memory files MEMORY.md does not point to. */
  unindexed: string[]
  /** Links in MEMORY.md whose file is gone. */
  missing: string[]
}

/** The result of one scan of the project. */
export type DocReport = {
  root: string
  projectName: string
  scannedAt: number
  isGit: boolean
  sessions: number
  transcripts: number
  firstActivity: number | null
  files: DocEntry[]
  /** Null when the project has no memory files. */
  memory: MemoryState | null
  warnings: string[]
}

/** The person's choices, kept across sessions and projects. */
export type DocRadarSettings = {
  /** Scan again after Claude's tool calls and turns; off, only on request. */
  autoScan: boolean
  /** Open the sidebar when a session starts. */
  autoOpen: boolean
  /** Show the ◇ hints beside the ▲ problems. */
  showHints: boolean
}

/** How the files are laid out: grouped by use, or one list by last use. */
export type DocLayout = 'tree' | 'list'

/** A model's review of one file, kept per content hash. */
export type AiReview = {
  hash: string
  at: number
  model: string
  score: number
  compression: string
  verdict: string
  tips: string[]
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'doc-radar': {
      report: Shaped<DocReport | null>
      reviews: Shaped<Record<string, AiReview>>
      selected: string
      filter: string
      /** Groups the person opened (true) or closed (false); absent ones follow the default. */
      groups: Record<string, boolean>
      isScanning: boolean
      reviewing: string
      /** The search text; empty shows every file. */
      query: string
      isSearchOpen: boolean
      isSettingsOpen: boolean
      layout: DocLayout
      settings: Shaped<DocRadarSettings>
      /** The mod's version, from its plugin.json. */
      version: string
    }
  }
}
