// The sidebar's drawing, after the Doc Radar mockup in the desktop app's own
// look: the theme's ground, text colours, borders and sans face, and tints and
// SVG icons and charts where the theme has no word. A light and a dark theme
// read alike. The terminal gets the same layout in glyphs.
import type { Elements, RenderElement, RenderSurface, Space } from 'claude-code'

import type { AiReview, DocCompression, DocEntry, DocLayout, DocQuality, DocRadarSettings, DocReport, DocRole, MemoryState } from '../types'
import { kilobytes } from './analyze'

type Table = Elements[keyof Elements]

/** A top-level branch of the tree. */
export type GroupDef = { id: string; icon: string; title: string; roles: readonly DocRole[] }

export const GROUPS: readonly GroupDef[] = [
  { id: 'always', icon: '🧠', title: 'Immer im Kontext', roles: ['always'] },
  { id: 'rules', icon: '📐', title: 'Regeln & Anweisungen', roles: ['agent', 'rule'] },
  { id: 'commands', icon: '⚡', title: 'Commands & Skills', roles: ['command', 'skill', 'subagent'] },
  { id: 'docs', icon: '📘', title: 'Doku', roles: ['readme', 'doc'] },
  { id: 'adr', icon: '🏛️', title: 'ADRs', roles: ['adr'] },
  { id: 'templates', icon: '📋', title: 'Vorlagen', roles: ['template'] },
  { id: 'memory', icon: '💾', title: 'Memory & Trim State', roles: ['memory'] },
]

/** What the sidebar draws from. */
export type ViewState = {
  report: DocReport
  now: number
  selected: string
  filter: string
  groups: Record<string, boolean>
  reviews: Record<string, AiReview>
  reviewing: string
  isScanning: boolean
  columns: number
  /** The lines the pane's body has room for. */
  rows: number
  surface: RenderSurface
  query: string
  isSearchOpen: boolean
  isSettingsOpen: boolean
  layout: DocLayout
  settings: DocRadarSettings
  version: string
}

/** What a press asks for; the hooks module carries it out. */
export type ViewActions = {
  toggleFile: (path: string) => void
  toggleGroup: (id: string, isOpen: boolean) => void
  toggleAll: (isOpen: boolean) => void
  setFilter: (filter: string) => void
  rescan: () => void
  review: (entry: DocEntry) => void
  open: (entry: DocEntry) => void
  mention: (entry: DocEntry) => void
  toggleLayout: () => void
  handOff: () => void
  toggleSettings: () => void
  setSetting: (key: keyof DocRadarSettings, value: boolean) => void
  close: () => void
  setQuery: (value: string) => void
  openSearch: () => void
  closeSearch: () => void
}

// Colours ------------------------------------------------------------------

/** Text colours: the theme's own keys, so the pane follows the app's light or dark mode. */
const INK = {
  text: 'text',
  secondary: 'inactive',
  muted: 'subtle',
  brand: 'claude',
  success: 'success',
  warning: 'warning',
  error: 'error',
  accent: 'suggestion',
  violet: 'merged',
} as const

/** Hues for tints and drawings: mid tones that read on a light and a dark ground alike. */
const HUE = {
  brand: '#d97757',
  green: '#30a46c',
  amber: '#e09b1a',
  blue: '#4c8ed9',
  violet: '#9b7be0',
  red: '#e5484d',
  gray: '#8b8d98',
} as const

/** `hex` at `alpha` as CSS rgba: a tint the theme's ground shows through. */
function tint(hex: string, alpha: number): string {
  const channel = (at: number) => Number.parseInt(hex.slice(at, at + 2), 16)

  return `rgba(${channel(1)}, ${channel(3)}, ${channel(5)}, ${alpha})`
}

const GRADE: Record<string, { ink: string; hue: string }> = {
  A: { ink: INK.success, hue: HUE.green },
  B: { ink: INK.accent, hue: HUE.blue },
  C: { ink: INK.warning, hue: HUE.amber },
  D: { ink: INK.error, hue: HUE.red },
}

const STYLE: Record<DocCompression, { label: string; short: string; ink: string }> = {
  verbose: { label: 'wortreich', short: 'wortreich', ink: INK.accent },
  balanced: { label: 'ausgewogen (optimal)', short: 'ausgewogen', ink: INK.success },
  dense: { label: 'dicht', short: 'dicht', ink: INK.warning },
  compressed: { label: 'stark komprimiert', short: 'stark komprimiert', ink: INK.error },
}

const INVOKED: readonly DocRole[] = ['command', 'skill', 'subagent']
/** Lines the hover card sits above its row. */
const CARD_ROWS = 4
/** The width of one `ch`, the unit a graphical surface lays Box widths in: Anthropic Sans "0" at 13px. */
const CH_PX = 7.2
/** A colour of no ink. */
const CLEAR = '#00000000'
/**
 * Em spaces ahead of a press layer's label: wider than any pane, so the
 * Button spans its region, and the label's own text, with the ellipsis a
 * surface draws at an overflow, lands past the region's clipped edge.
 */
const FILL = ' '.repeat(64)
/** How far, in `ch`, a press layer reaches past its region's right edge, into the clip. */
const HIT_BLEED = 16
/** The most file rows one drawing holds; the engine refuses a tree of more than 20,000 elements. */
const ROW_BUDGET = 250

// Icons: the mockup's Heroicons outlines, 24 by 24 -------------------------

const ICON = {
  doc: ['M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'],
  file: ['M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z'],
  warning: ['M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z'],
  eye: [
    'M15 12a3 3 0 11-6 0 3 3 0 016 0z',
    'M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z',
  ],
  clock: ['M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z'],
  link: [
    'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1',
  ],
  lines: ['M4 6h16M4 12h8m-8 6h16'],
  commit: [
    'M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2',
  ],
  bolt: ['M13 10V3L4 14h7v7l9-11h-7z'],
  stack: [
    'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
  ],
  menu: ['M4 6h16M4 12h16M4 18h7'],
  grid: ['M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v6H4zM14 15h6v6h-6z'],
  terminal: ['M8 9l3 3-3 3m5 0h3'],
  adjustments: [
    'M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4',
  ],
  expand: ['M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4'],
  collapse: ['M9 9V5m0 4H5m4 0L4 4m11 5V5m0 4h4m-4 0l5-5M9 15v4m0-4H5m4 0l-5 5m11-5v4m0-4h4m-4 0l5 5'],
  close: ['M6 18L18 6M6 6l12 12'],
  refresh: ['M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15'],
  check: ['M5 13l4 4L19 7'],
  search: ['M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z'],
} as const

type IconName = keyof typeof ICON

/**
 * An icon in `color`; `currentColor` takes the theme's text colour, which the
 * desktop hands every drawing, and `opacity` dims it to the theme's secondary.
 */
function iconSvg(name: IconName, color: string, size: number, opacity = 1): string {
  const paths = ICON[name].map(d => `<path d="${d}"/>`).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
}

function starSvg(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="${HUE.green}" fill-opacity="0.2" stroke="${HUE.green}" stroke-width="2" stroke-linejoin="round"/></svg>`
}

/** The badge left of the title: the document icon on a tile of Claude's colour. */
function logoSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><rect x="0.5" y="0.5" width="21" height="21" rx="5" fill="${HUE.brand}" fill-opacity="0.12" stroke="${HUE.brand}" stroke-opacity="0.35"/><g transform="translate(4 4) scale(0.5833)" fill="none" stroke="${HUE.brand}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON.doc[0]}"/></g></svg>`
}

/** How a file's dot reads: its hue for a drawing, its ink for the terminal, fill, ring or glow. */
type Dot = { hue: string; ink: string; isRing: boolean; isGlow: boolean; label: string }

function dotOf(entry: DocEntry): Dot {
  if (entry.verdict === 'always') return { hue: HUE.brand, ink: INK.brand, isRing: false, isGlow: true, label: 'immer im Kontext' }
  if (entry.quality.problems.length > 0) return { hue: HUE.amber, ink: INK.warning, isRing: false, isGlow: false, label: 'Optimierung empfohlen' }
  if (entry.verdict === 'active') return { hue: HUE.green, ink: INK.success, isRing: false, isGlow: false, label: 'kürzlich genutzt' }
  if (entry.verdict === 'rare') return { hue: HUE.gray, ink: INK.muted, isRing: false, isGlow: false, label: 'selten genutzt' }
  if (entry.verdict === 'write-only') return { hue: HUE.amber, ink: INK.warning, isRing: true, isGlow: false, label: 'nur geschrieben, nie gelesen' }

  return { hue: HUE.gray, ink: INK.muted, isRing: true, isGlow: false, label: 'nie genutzt' }
}

function dotSvg(dot: Dot, isLarge: boolean): string {
  const size = isLarge ? 12 : 10
  const middle = size / 2
  const radius = isLarge ? 4 : 3
  const halo = dot.isGlow || isLarge ? `<circle cx="${middle}" cy="${middle}" r="${middle}" fill="${dot.hue}" fill-opacity="${isLarge ? 0.2 : 0.28}"/>` : ''
  const core = dot.isRing
    ? `<circle cx="${middle}" cy="${middle}" r="${radius - 0.75}" fill="none" stroke="${dot.hue}" stroke-width="1.5"/>`
    : `<circle cx="${middle}" cy="${middle}" r="${radius}" fill="${dot.hue}"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${halo}${core}</svg>`
}

/**
 * The live dot: it breathes, or sends out a ring as a ping does, where the
 * surface animates an image. Never drawn `isInteractive`: the desktop keeps a
 * drawing's frames across redraws and patches the tree around them, and with a
 * clicked Button holding the focus that patch scrolls the pane to its end.
 */
function pulseSvg(color: string, isPing: boolean): string {
  const motion = isPing
    ? `<circle cx="5" cy="5" r="3" fill="${color}" fill-opacity="0.6"><animate attributeName="r" values="3;5" dur="1.4s" repeatCount="indefinite"/><animate attributeName="fill-opacity" values="0.6;0" dur="1.4s" repeatCount="indefinite"/></circle><circle cx="5" cy="5" r="3" fill="${color}"/>`
    : `<circle cx="5" cy="5" r="2.5" fill="${color}"><animate attributeName="opacity" values="1;0.35;1" dur="2s" repeatCount="indefinite"/></circle>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">${motion}</svg>`
}

/**
 * Where a file sits between wordy (0) and compressed (1), balanced prose in
 * the middle: the scale the mockup draws, from the compression signals.
 */
export function gaugePosition(q: DocQuality): number {
  const clamp = (value: number) => Math.min(1, Math.max(0, value))
  if (q.compression === 'verbose') {
    const wordiness = 0.5 * clamp((q.functionWordRatio - 0.48) / 0.12) + 0.5 * clamp((q.avgSegmentWords - 24) / 16)

    return 0.3 - 0.3 * wordiness
  }
  // A file with too little prose to judge reads as balanced, so it sits in that band whatever its score.
  const score = q.compression === 'balanced' ? Math.min(q.compressionScore, 0.449) : q.compressionScore
  if (score < 0.45) return 0.35 + (score / 0.45) * 0.3
  if (score < 0.62) return 0.65 + ((score - 0.45) / 0.17) * 0.15

  return 0.8 + clamp((score - 0.62) / 0.38) * 0.2
}

// The bar and the line are drawn `preserveAspectRatio="none"` without a width,
// so a column Box stretches them across; `width` is only the viewBox, the best
// guess of the drawn size. What must stay round is drawn apart (`markerSvg`).

/** The compression scale's track: a gradient rim around a groove of the theme's text colour, faint. */
function gaugeBarSvg(width: number): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="16" viewBox="0 0 ${width} 16" preserveAspectRatio="none">`,
    `<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="${HUE.blue}"/><stop offset="0.5" stop-color="${HUE.green}"/><stop offset="1" stop-color="${HUE.amber}"/></linearGradient></defs>`,
    `<rect x="0" y="5" width="${width}" height="6" rx="3" fill="url(#g)"/>`,
    `<rect x="1" y="6" width="${width - 2}" height="4" rx="2" fill="currentColor" fill-opacity="0.12"/>`,
    '</svg>',
  ].join('')
}

/** The file's place on the scale: a white dot in a green ring and glow. */
function markerSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="${HUE.green}" fill-opacity="0.2"/><circle cx="8" cy="8" r="6" fill="${HUE.green}"/><circle cx="8" cy="8" r="4" fill="#ffffff"/></svg>`
}

/** The 14-day line: an area and a line over a dashed base, the busiest day and the last one marked. */
function sparkSvg(values: readonly number[], width: number): string {
  const height = 24
  const base = 20
  const max = Math.max(...values, 1)
  const step = values.length > 1 ? width / (values.length - 1) : width
  const points = values.map((value, index) => [Math.round(index * step * 10) / 10, Math.round((22 - (value / max) * 19) * 10) / 10] as const)
  const line = points.map(([x, y]) => `${x},${y}`).join(' ')
  const area = `0,${height} ${line} ${width},${height}`
  const busiest = values.indexOf(Math.max(...values))
  const last = values.reduce((found, value, index) => (value > 0 ? index : found), -1)
  const mark = (index: number, color: string) => {
    const point = points[index]

    return point === undefined || (values[index] ?? 0) === 0 ? '' : `<circle cx="${point[0]}" cy="${point[1]}" r="2" fill="${color}"/>`
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">`,
    `<line x1="0" x2="${width}" y1="${base}" y2="${base}" stroke="currentColor" stroke-opacity="0.2" stroke-width="0.5" stroke-dasharray="2,2"/>`,
    `<polygon points="${area}" fill="${HUE.green}" fill-opacity="0.14"/>`,
    `<polyline points="${line}" fill="none" stroke="${HUE.green}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>`,
    last !== busiest ? mark(last, HUE.blue) : '',
    mark(busiest, HUE.green),
    '</svg>',
  ].join('')
}

/** A 1px line stretched by its parent: the theme's border, faint text colour, unless given a colour. */
function lineSvg(color = 'currentColor', opacity = 0.12): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1" preserveAspectRatio="none"><rect width="1" height="1" fill="${color}" fill-opacity="${opacity}"/></svg>`
}

// Numbers ------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, '0')

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function fmtDate(ms: number): string {
  const d = new Date(ms)

  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`
}

function fmtTime(ms: number): string {
  const d = new Date(ms)

  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** "2h", "3d": the age a row has room for. */
function shortAgo(ms: number, now: number): string {
  if (ms <= 0) return '—'
  const minutes = Math.floor((now - ms) / 60_000)
  if (minutes < 1) return 'jetzt'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}d`
  if (days < 60) return `${Math.floor(days / 7)}w`

  return `${Math.floor(days / 30)}mo`
}

export function uses(entry: DocEntry): number {
  const u = entry.usage

  return u.reads + u.shellReads + u.mentions + u.invocations
}

export function lastUse(entry: DocEntry): number {
  const u = entry.usage

  return Math.max(u.lastRead ?? 0, u.lastInvoked ?? 0, u.lastAutoLoad ?? 0)
}

export function isIdle(entry: DocEntry): boolean {
  return entry.verdict === 'rare' || entry.verdict === 'unused' || entry.verdict === 'write-only'
}

export function isWeak(entry: DocEntry): boolean {
  return entry.quality.grade === 'C' || entry.quality.grade === 'D'
}

function matches(entry: DocEntry, filter: string, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle !== '' && !entry.path.toLowerCase().includes(needle)) return false
  if (filter === 'weak') return isWeak(entry)
  if (filter === 'idle') return isIdle(entry)
  if (filter === 'problems') return entry.quality.problems.length > 0

  return true
}

/** Most recently used first; never used last, by name. */
function byUse(a: DocEntry, b: DocEntry): number {
  return lastUse(b) - lastUse(a) || a.path.localeCompare(b.path)
}

/** The headline number of a file: what "used" means for its role. */
function useFact(entry: DocEntry): { icon: IconName; glyph: string; value: string; caption: string } {
  const u = entry.usage
  if (entry.role === 'always') return { icon: 'stack', glyph: '🧠', value: `${u.autoLoads}x`, caption: 'Ladungen' }
  if (INVOKED.includes(entry.role)) return { icon: 'bolt', glyph: '⚡', value: `${u.invocations}x`, caption: 'Aufrufe' }

  return { icon: 'eye', glyph: '👁', value: `${uses(entry)}x`, caption: 'Reads' }
}

/** The memory group's badge: whether the index loads whole and points to every memory file. */
function memoryBadge(memory: MemoryState | null): { text: string; isClean: boolean } | null {
  if (memory === null) return null
  if (!memory.hasIndex) return { text: 'kein Index', isClean: false }
  if (memory.indexLines > memory.lineLimit) return { text: `trim ${memory.indexLines}/${memory.lineLimit}`, isClean: false }
  if (memory.indexBytes > memory.byteLimit) {
    return { text: `trim ${kilobytes(memory.indexBytes)}/${kilobytes(memory.byteLimit)} KB`, isClean: false }
  }
  if (memory.unindexed.length > 0) return { text: `${memory.unindexed.length} ohne Index`, isClean: false }
  if (memory.missing.length > 0) return { text: `${memory.missing.length} fehlt`, isClean: false }

  return { text: 'clean', isClean: true }
}

/** The task the ›_ button hands Claude: every file with a problem, and what it is. */
export function handOffText(files: readonly DocEntry[]): string | null {
  const flagged = files.filter(file => file.quality.problems.length > 0)
  if (flagged.length === 0) return null
  const lines = flagged.map(file => {
    const where = file.path.startsWith('~memory/') ? file.absPath : file.path
    const broken = file.quality.brokenLinks.length > 0 ? ` (Links: ${file.quality.brokenLinks.join(', ')})` : ''

    return `- ${where}: ${file.quality.problems.join('; ')}${broken}`
  })

  return ['Doc Radar meldet Probleme in der Doku. Bitte prüfe diese Dateien und behebe, was sinnvoll ist:', ...lines].join('\n')
}

// Drawing ------------------------------------------------------------------

export function renderPane(ui: Table, state: ViewState, actions: ViewActions): RenderElement {
  const { Box, Text, Button } = ui
  // The engine hands every surface a table with every element's name (one a
  // surface lacks draws as a fragment), so the surface decides, not the table.
  const isRich = state.surface !== 'terminal'
  const hasInput = state.surface !== 'mobile'
  const Svg = isRich && 'Svg' in ui ? ui.Svg : undefined
  const Input = hasInput && 'Input' in ui ? ui.Input : undefined
  const { report, now, filter, settings } = state
  const files = report.files
  const step = (rich: Space, plain: number): Space => (isRich ? rich : plain)
  /** A tint on a graphical surface; the terminal keeps its theme's ground. */
  const wash = (hue: string, alpha: number) => (isRich ? tint(hue, alpha) : undefined)
  // The pane's body in CSS pixels: the charts' viewBox, so they stretch with little distortion.
  const bodyPx = Math.max(200, Math.round(state.columns * CH_PX))

  const svg = (source: string, alt: string, width: number, height: number) =>
    Svg === undefined ? null : <Svg source={source} alt={alt} width={width} height={height} />

  /** A drawing as wide as its column: no width, so the surface stretches it. */
  const wideSvg = (source: string, alt: string, height: number) => (Svg === undefined ? null : <Svg source={source} alt={alt} height={height} />)

  /** A 1px line across its column parent in the theme's border colour, drawn in CSS pixels so it never snaps to two. */
  const hairline = () => wideSvg(lineSvg(), 'Linie', 1)

  /**
   * The press of a region on a graphical surface, which draws a Button as its
   * label alone: a plain Button laid over the region and stretched to it, the
   * region drawn `overflow="hidden"` so only the label's leading blanks show.
   * The Button's own hover is the app's, and the region's.
   */
  const hit = (key: string, label: string, onPress: () => void) =>
    isRich ? (
      <Box position="absolute" top={0} left={0} right={-HIT_BLEED} bottom={0} flexDirection="row" alignItems="stretch">
        <Button key={key} plain label={`${FILL}${label}`} hover={{ color: CLEAR }} onPress={onPress} />
      </Box>
    ) : null

  /** What a control shows: as drawn on a graphical surface (`hit` takes the press), inside its Button on the terminal. */
  const face = (key: string, label: string, onPress: () => void, look: RenderElement) =>
    isRich ? (
      look
    ) : (
      <Button key={key} plain label={label} onPress={onPress}>
        {look}
      </Button>
    )

  /** The rounded corners a press region needs for the app's hover, which its clip follows. */
  const region = isRich ? { borderStyle: 'single', borderColor: CLEAR } : {}

  /**
   * A small label: on a graphical surface a tinted, bordered Box, its corners
   * the renderer's smallest (6px) unless `isRound` asks for a capsule; a
   * coloured run on the terminal.
   */
  const pill = (text: string, ink: string, hue: string, isRound = false) =>
    isRich ? (
      <Box borderStyle={isRound ? 'round' : 'single'} borderColor={tint(hue, 0.35)} backgroundColor={tint(hue, 0.12)} paddingX="sm" paddingY={0} flexShrink={0}>
        <Text size="caption" weight="medium" color={ink}>
          {text}
        </Text>
      </Box>
    ) : (
      <Text color={ink}>{text}</Text>
    )

  const chip = (entry: DocEntry, isStrong = false) => {
    const isFaded = entry.verdict === 'rare' || entry.verdict === 'unused'
    const tone = GRADE[entry.quality.grade] ?? { ink: INK.error, hue: HUE.red }
    const hue = isFaded ? HUE.gray : tone.hue
    const ink = isFaded ? INK.secondary : tone.ink

    return isRich ? (
      <Box
        borderStyle="single"
        borderColor={tint(hue, isStrong ? 0.45 : 0.35)}
        backgroundColor={tint(hue, isStrong ? 0.18 : 0.1)}
        paddingX={isStrong ? 'sm' : 'xs'}
        paddingY={0}
        flexShrink={0}
      >
        <Text size="caption" weight="semibold" tabular color={ink}>
          {entry.quality.grade}
        </Text>
      </Box>
    ) : (
      <Text color={ink} weight="bold">
        {entry.quality.grade}
      </Text>
    )
  }

  const dot = (entry: DocEntry, isLarge = false) => {
    const look = dotOf(entry)

    return isRich ? svg(dotSvg(look, isLarge), look.label, isLarge ? 12 : 10, isLarge ? 12 : 10) : <Text color={look.ink}>{look.isRing ? '○' : '●'}</Text>
  }

  /** A coloured icon, or a glyph on the terminal. */
  const icon = (name: IconName, hue: string, ink: string, glyphText: string, size = 12) =>
    isRich ? svg(iconSvg(name, hue, size), glyphText, size, size) : <Text color={ink}>{glyphText}</Text>

  /** A small pressable mark of the title bar or the footer; `isInert` draws it without a press. */
  const tool = (id: string, look: RenderElement, label: string, onPress: () => void, isInert = false) => (
    <Box key={`tool:${id}`} flexDirection="row" alignItems="center" flexShrink={0} paddingX={step('xs', 0)} paddingY={step('xs', 0)} overflow="hidden" {...region}>
      {isInert ? look : face(id, label, onPress, look)}
      {isInert ? null : hit(id, label, onPress)}
    </Box>
  )

  // A filter or a search shows every branch open, so while one is on the
  // branches' own open and closed states are neither shown nor changed.
  const isFiltered = filter !== 'all' || state.query.trim() !== ''

  // Title bar ------------------------------------------------------------
  const visibleGroups = GROUPS.filter(group => files.some(file => group.roles.includes(file.role)))
  const flaggedIn = (group: GroupDef) => files.filter(file => group.roles.includes(file.role) && file.quality.problems.length > 0).length
  const isOpenGroup = (group: GroupDef) => state.groups[group.id] ?? (group.id === 'always' || flaggedIn(group) > 0)
  const isAllOpen = visibleGroups.length > 0 && visibleGroups.every(isOpenGroup)
  const glyph = (text: string, isActive = false, ink: string = INK.secondary) => (
    <Text size="footnote" color={isActive ? INK.brand : ink}>
      {text}
    </Text>
  )
  /** A title-bar mark: the mockup's icon in the theme's text colour (Claude's when active), a glyph on the terminal. */
  const mark = (name: IconName, text: string, isActive = false, isDim = false) =>
    svg(iconSvg(name, isActive ? HUE.brand : 'currentColor', 14, isActive ? 1 : isDim ? 0.35 : 0.7), text, 14, 14) ??
    glyph(text, isActive, isDim ? INK.muted : INK.secondary)

  const titleBar = (
    <Box flexDirection="row" alignItems="center" paddingX={step('xs', 0)} paddingY={step('xs', 0)}>
      <Box flexDirection="row" alignItems="center" columnGap={step('sm', 1)} flexGrow={1} flexShrink={1}>
        {svg(logoSvg(), 'Docs', 22, 22)}
        <Text size="heading" weight="semibold">
          Docs
        </Text>
        {pill('Radar', INK.brand, HUE.brand, true)}
      </Box>
      <Box flexDirection="row" alignItems="center" columnGap={step('xs', 1)}>
        {tool(
          'layout',
          state.layout === 'tree' ? mark('menu', '☰') : mark('grid', '⊞', true),
          state.layout === 'tree' ? 'Als Liste nach Nutzung zeigen' : 'Als Baum nach Rolle zeigen',
          actions.toggleLayout,
        )}
        {tool('handoff', mark('terminal', '›_'), 'Probleme als Auftrag in den Prompt', actions.handOff)}
        {tool('settings', mark('adjustments', '⚙', state.isSettingsOpen), 'Einstellungen', actions.toggleSettings)}
        {isRich ? <Box width={0.14} height={0.75} marginX="xs" backgroundColor={tint(HUE.gray, 0.3)} /> : <Text color={INK.muted}>│</Text>}
        {tool(
          'expand',
          isAllOpen ? mark('collapse', '⤡', false, isFiltered) : mark('expand', '⤢', false, isFiltered),
          isAllOpen ? 'Alle Gruppen zuklappen' : 'Alle Gruppen aufklappen',
          () => actions.toggleAll(!isAllOpen),
          isFiltered,
        )}
        {tool('close', mark('close', '✕'), 'Seitenleiste schließen', actions.close)}
      </Box>
    </Box>
  )

  // Band: telemetry and the filter tiles -----------------------------------
  const avg = files.length === 0 ? null : Math.round(files.reduce((sum, file) => sum + file.quality.score, 0) / files.length)
  const avgGrade = avg === null ? '—' : avg >= 85 ? 'A' : avg >= 70 ? 'B' : avg >= 55 ? 'C' : 'D'
  const idle = files.filter(isIdle).length
  const problems = files.filter(file => file.quality.problems.length > 0).length
  const contextTokens = files.filter(file => file.role === 'always').reduce((sum, file) => sum + file.quality.tokens, 0)

  const tile = (id: string, look: RenderElement | null, value: string, valueInk: string, caption: string, hasBadge = false) => {
    const isActive = filter === id
    const press = () => actions.setFilter(isActive || id === 'all' ? 'all' : id)
    const label = `${caption} ${value}`
    const shown = (
      <Text weight="semibold" tabular color={valueInk}>
        {value}
      </Text>
    )

    return (
      <Box
        key={`kpi:${id}`}
        flexDirection="column"
        alignItems="center"
        flexGrow={1}
        width={0}
        paddingX={step('xs', 0)}
        paddingY={step('sm', 0)}
        overflow="hidden"
        borderStyle="round"
        borderColor={isActive ? (isRich ? tint(HUE.brand, 0.6) : INK.brand) : undefined}
        backgroundColor={isActive ? wash(HUE.brand, 0.06) : undefined}
        hover={{ borderColor: isActive ? (isRich ? tint(HUE.brand, 0.85) : INK.brand) : 'promptBorder' }}
      >
        {isActive && isRich && (
          <Box position="absolute" top={0} left={0} right={0} flexDirection="column">
            {wideSvg(lineSvg(HUE.brand, 1), 'aktiver Filter', 2)}
          </Box>
        )}
        <Box flexDirection="row" alignItems="center" columnGap={step('xs', 1)}>
          {look}
          {face(`filter:${id}`, label, press, shown)}
        </Box>
        <Text size="caption" color={INK.secondary} wrap="truncate-end">
          {caption}
        </Text>
        {hasBadge &&
          (isRich ? (
            <Box position="absolute" top={0} right={0} marginTop={0.45} marginRight={0.6}>
              {svg(dotSvg({ hue: HUE.amber, ink: INK.warning, isRing: false, isGlow: false, label: 'Probleme' }, false), 'Probleme offen', 8, 8)}
            </Box>
          ) : (
            <Box position="absolute" top={0} right={1}>
              <Text color={INK.warning}>•</Text>
            </Box>
          ))}
        {hit(`filter:${id}`, label, press)}
      </Box>
    )
  }

  const band = (
    <Box flexDirection="column" paddingX={step('xs', 0)} paddingTop={step('sm', 0)} paddingBottom={step('md', 0)} rowGap={step('sm', 0)}>
      <Box flexDirection="row" alignItems="center" columnGap={step('sm', 1)}>
        <Box flexDirection="row" alignItems="center" columnGap={step('xs', 1)} flexGrow={1} flexShrink={1} minWidth={0}>
          {isRich ? svg(pulseSvg(HUE.green, false), 'aktuell', 10, 10) : <Text color={INK.success}>●</Text>}
          <Text size="caption" color={INK.secondary} wrap="truncate-end">
            ~{fmtK(contextTokens)} Tok/Session <Text color={INK.muted}>•</Text> {report.sessions} Sessions <Text color={INK.muted}>•</Text>{' '}
            <Text color={INK.text}>{fmtTime(report.scannedAt)}</Text>
          </Text>
        </Box>
        <Box key="tool:sync" flexDirection="row" alignItems="center" columnGap="xs" flexShrink={0} paddingX={step('xs', 0)} overflow="hidden" {...region}>
          {face(
            'rescan',
            'Neu scannen',
            actions.rescan,
            <Text size="caption" weight="medium" color={state.isScanning ? INK.brand : INK.secondary}>
              {state.isScanning ? 'Scannt …' : 'Sync'}
              {isRich ? '' : ' ⟳'}
            </Text>,
          )}
          {svg(iconSvg('refresh', state.isScanning ? HUE.brand : 'currentColor', 13, state.isScanning ? 1 : 0.7), '⟳', 13, 13)}
          {hit('rescan', 'Neu scannen', actions.rescan)}
        </Box>
      </Box>
      <Box flexDirection="row" columnGap={step('sm', 1)}>
        {tile('all', icon('file', HUE.brand, INK.brand, '📄'), String(files.length), INK.text, 'Dateien')}
        {tile('weak', isRich ? svg(starSvg(12), '⭐', 12, 12) : <Text>⭐</Text>, avgGrade, INK.text, `Ø Note ${avg ?? '—'}`)}
        {tile('idle', <Text size="caption">💤</Text>, String(idle), INK.text, 'Ungenutzt')}
        {tile('problems', icon('warning', HUE.amber, INK.warning, '⚠️'), String(problems), problems > 0 ? INK.warning : INK.text, 'Probleme', problems > 0)}
      </Box>
      {report.warnings.map(warning => (
        <Text color={INK.warning} size="caption" wrap="wrap">
          ⚠ {warning}
        </Text>
      ))}
    </Box>
  )

  // Search and settings ------------------------------------------------------
  const isSearching = state.isSearchOpen || state.query !== ''
  const search =
    isSearching && Input !== undefined ? (
      <Box flexDirection="row" alignItems="center" columnGap={step('sm', 1)} paddingX={step('xs', 0)} paddingBottom={step('md', 0)}>
        {mark('search', '⌕')}
        {/* No `value`: a field the hook redraws with every keystroke's echo drops typed characters. */}
        <Input key="search" placeholder="Datei suchen …" autoFocus onInput={value => actions.setQuery(value)} onSubmit={value => actions.setQuery(value)} />
        {tool('search-close', mark('close', '✕'), 'Suche schließen', actions.closeSearch)}
      </Box>
    ) : null

  const toggle = (key: keyof DocRadarSettings, label: string, detail: string) => {
    const isOn = settings[key]
    const press = () => actions.setSetting(key, !isOn)
    const name = `${label}: ${isOn ? 'an' : 'aus'}`

    return (
      <Box
        key={`setting-row:${key}`}
        flexDirection="row"
        alignItems="center"
        columnGap={step('sm', 1)}
        paddingX={step('xs', 0)}
        paddingY={step('xs', 0)}
        overflow="hidden"
        {...region}
      >
        {isRich ? pill(isOn ? 'An' : 'Aus', isOn ? INK.success : INK.muted, isOn ? HUE.green : HUE.gray) : null}
        {face(
          `setting:${key}`,
          name,
          press,
          <Text size="footnote">
            {isRich ? '' : isOn ? '[an]  ' : '[aus] '}
            {label}{' '}
            <Text size="caption" color={INK.muted}>
              {detail}
            </Text>
          </Text>,
        )}
        {hit(`setting:${key}`, name, press)}
      </Box>
    )
  }

  const settingsPanel = state.isSettingsOpen ? (
    <Box flexDirection="column" marginTop={step('sm', 0)} paddingX={step('md', 1)} paddingY={step('sm', 0)} rowGap={step('xs', 0)} borderStyle="round" backgroundColor={wash(HUE.gray, 0.05)}>
      <Text size="caption" weight="semibold" color={INK.secondary}>
        Einstellungen
      </Text>
      {toggle('autoScan', 'Auto-Scan', 'nach Claudes Änderungen')}
      {toggle('autoOpen', 'Beim Start öffnen', 'mit jeder Session')}
      {toggle('showHints', 'Hinweise ◇ zeigen', 'Stilfragen')}
    </Box>
  ) : null

  // One file -------------------------------------------------------------
  const hoverCard = (entry: DocEntry) => {
    const review = state.reviews[entry.path]
    const fact = useFact(entry)
    const width = Math.max(24, Math.min(40, state.columns - 6))
    const status =
      entry.quality.problems.length > 0 ? (
        <Text size="caption" color={INK.warning} wrap="truncate-end">
          ▲ {entry.quality.problems.join(' · ')}
        </Text>
      ) : review !== undefined && review.error === undefined ? (
        <Text size="caption" wrap="truncate-end">
          ✨ {Math.round(review.score / 10)}/10 · {review.verdict}
        </Text>
      ) : (
        <Text size="caption" color={INK.secondary} wrap="truncate-end">
          {dotOf(entry).label} · {STYLE[entry.quality.compression].short}
        </Text>
      )

    return (
      <Box
        position="absolute"
        top={-CARD_ROWS}
        right={1}
        width={width}
        display="none"
        hover={{ display: 'flex' }}
        flexDirection="column"
        // The popover sits over the rows, so it needs a ground of its own: the theme's raised surface.
        backgroundColor={isRich ? 'userMessageBackground' : undefined}
        borderStyle="round"
        borderColor="promptBorder"
        paddingX={step('md', 1)}
        paddingY={step('xs', 0)}
      >
        <Text size="caption" weight="semibold" wrap="truncate-end">
          {entry.name} <Text color={INK.secondary}>· {entry.roleLabel}</Text>
        </Text>
        <Text size="caption" color={INK.secondary} wrap="truncate-end">
          {fact.glyph} {fact.value} · 🕒 {shortAgo(lastUse(entry), now)} · 🔗 {entry.quality.inbound.length} · 📝 {fmtK(entry.quality.words)}
        </Text>
        {status}
      </Box>
    )
  }

  /** The marks right of a name: AI score, problem, hint, age. */
  const meta = (entry: DocEntry, isOnCard: boolean) => {
    const review = state.reviews[entry.path]
    const hasProblem = entry.quality.problems.length > 0
    const hasHint = settings.showHints && entry.quality.hints.length > 0
    const parts: RenderElement[] = []
    if (!isOnCard && review !== undefined && review.error === undefined) {
      parts.push(
        <Text size="caption" tabular color={hasProblem ? INK.warning : INK.brand}>
          ✨{Math.round(review.score / 10)}
        </Text>,
      )
    }
    if (!isOnCard && hasProblem) {
      parts.push(
        <Text size="caption" weight="bold" color={INK.warning}>
          ▲
        </Text>,
      )
    }
    if ((isOnCard || !hasProblem) && hasHint) {
      parts.push(
        <Text size="caption" color={isOnCard ? INK.brand : INK.secondary}>
          ◇
        </Text>,
      )
    }
    parts.push(
      <Text size="caption" tabular color={INK.muted}>
        {isRich ? shortAgo(lastUse(entry), now) : shortAgo(lastUse(entry), now).padStart(4)}
      </Text>,
    )

    return (
      <Box flexDirection="row" alignItems="center" columnGap={step('xs', 1)} flexShrink={0}>
        {parts}
      </Box>
    )
  }

  const row = (entry: DocEntry) => {
    const hasProblem = entry.quality.problems.length > 0
    const isFaded = entry.verdict === 'rare' || entry.verdict === 'unused'
    const press = () => actions.toggleFile(entry.path)
    const label = `${entry.name} aufklappen`

    // The keyed outer Box is the hover scope of both the row and its card; the
    // inner one clips the press layer, which must not clip the card.
    return (
      <Box key={`row:${entry.path}`} flexDirection="column">
        <Box
          flexDirection="row"
          alignItems="center"
          columnGap={step('sm', 1)}
          paddingX={step('sm', 0)}
          paddingY={step('xs', 0)}
          overflow="hidden"
          borderStyle={isRich ? 'single' : undefined}
          borderColor={isRich ? (hasProblem ? tint(HUE.amber, 0.4) : CLEAR) : undefined}
          backgroundColor={hasProblem ? wash(HUE.amber, 0.07) : undefined}
        >
          {dot(entry)}
          {chip(entry)}
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            {face(
              `file:${entry.path}`,
              label,
              press,
              <Text wrap="truncate-end" weight={hasProblem ? 'medium' : undefined} color={hasProblem ? INK.warning : isFaded ? INK.secondary : INK.text}>
                {entry.name}
              </Text>,
            )}
          </Box>
          {meta(entry, false)}
          {hit(`file:${entry.path}`, label, press)}
        </Box>
        {hoverCard(entry)}
      </Box>
    )
  }

  const metric = (name: IconName, hue: string, glyphText: string, value: string, caption: string) =>
    isRich ? (
      <Box flexDirection="column" alignItems="center" flexGrow={1} width={0} paddingX="xs" paddingY="xs" borderStyle="single" backgroundColor={tint(HUE.gray, 0.05)}>
        <Box flexDirection="row" alignItems="center" columnGap="xs">
          {svg(iconSvg(name, hue, 12), glyphText, 12, 12)}
          <Text size="footnote" weight="semibold" tabular>
            {value}
          </Text>
        </Box>
        <Text size="caption" color={INK.muted} wrap="truncate-end">
          {caption}
        </Text>
      </Box>
    ) : (
      <Text>
        {glyphText} {value}{'  '}
      </Text>
    )

  const card = (entry: DocEntry) => {
    const u = entry.usage
    const q = entry.quality
    const g = entry.git
    const review = state.reviews[entry.path]
    const isReviewing = state.reviewing === entry.path
    const isStale = review !== undefined && review.error === undefined && review.hash !== entry.hash
    const fact = useFact(entry)
    const style = STYLE[q.compression]
    const folder = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '/'
    // The gauge panel's inside: the body less the tree's, the card's and the panel's own frames.
    const chartPx = Math.max(120, bodyPx - 80)
    const isMemory = entry.path.startsWith('~memory/')
    const gitText =
      report.isGit && !isMemory
        ? g.isTracked
          ? `${g.commits} Commit${g.commits === 1 ? '' : 's'}${u.edits > 0 ? ` · ✎ ${u.edits}x Claude` : ''}${g.isDirty ? ' · ungespeichert' : ''}`
          : `nicht eingecheckt${u.edits > 0 ? ` · ✎ ${u.edits}x Claude` : ''}`
        : `geändert${u.edits > 0 ? ` · ✎ ${u.edits}x Claude` : ''}`
    const gitDate = g.lastCommit !== null && !isMemory ? fmtDate(g.lastCommit) : fmtDate(entry.mtimeMs)
    const close = () => actions.toggleFile(entry.path)
    const position = gaugePosition(q)

    return (
      <Box
        key={`card:${entry.path}`}
        flexDirection="column"
        rowGap={step('md', 0)}
        paddingX={step('md', 1)}
        paddingY={step('md', 0)}
        marginY={step('xs', 0)}
        overflow={isRich ? 'hidden' : undefined}
        borderStyle="round"
        borderColor={isRich ? tint(HUE.brand, 0.5) : INK.brand}
        backgroundColor={wash(HUE.gray, 0.03)}
      >
        {isRich && (
          // A glow of Claude's colour in the card's top right corner: centred on the corner, clipped by the card.
          <Box position="absolute" top={0} right={0}>
            {svg(
              `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><defs><radialGradient id="r" cx="1" cy="0" r="1"><stop offset="0" stop-color="${HUE.brand}" stop-opacity="0.16"/><stop offset="1" stop-color="${HUE.brand}" stop-opacity="0"/></radialGradient></defs><rect width="64" height="64" fill="url(#r)"/></svg>`,
              'Schein',
              64,
              64,
            )}
          </Box>
        )}
        <Box flexDirection="column" rowGap={step('sm', 0)}>
          <Box key={`head:${entry.path}`} flexDirection="row" alignItems="center" columnGap={step('sm', 1)} overflow="hidden" {...region}>
            {dot(entry, true)}
            {chip(entry, true)}
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              {face(
                `file:${entry.path}`,
                `${entry.name} zuklappen`,
                close,
                <Text weight="semibold" wrap="truncate-end">
                  {entry.name}
                </Text>,
              )}
            </Box>
            {meta(entry, true)}
            {hit(`file:${entry.path}`, `${entry.name} zuklappen`, close)}
          </Box>
          {hairline()}
        </Box>

        <Box flexDirection="row" alignItems="center" columnGap={step('sm', 1)}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text size="caption" color={INK.secondary} wrap="truncate-end">
              <Text color={INK.muted}>•</Text> {entry.roleLabel.replace(/ · /g, ' • ')}
            </Text>
          </Box>
          {pill(folder, INK.secondary, HUE.gray)}
        </Box>

        <Box flexDirection="row" flexWrap={isRich ? 'nowrap' : 'wrap'} columnGap={step('xs', 0)}>
          {metric(fact.icon, HUE.brand, fact.glyph, fact.value, fact.caption)}
          {metric('clock', HUE.green, '🕒', shortAgo(lastUse(entry), now), 'Alter')}
          {metric('link', HUE.violet, '🔗', String(q.inbound.length), 'Links')}
          {metric('lines', HUE.amber, '📝', fmtK(q.words), 'Wörter')}
        </Box>

        <Box flexDirection="column" rowGap={step('sm', 0)} paddingX={step('md', 1)} paddingY={step('sm', 0)} borderStyle="round" backgroundColor={wash(HUE.gray, 0.06)}>
          <Box flexDirection="column" rowGap={step('xs', 0)}>
            {isRich ? (
              <Box flexDirection="row" justifyContent="space-between" columnGap="xs">
                <Text size="caption" color={INK.muted}>
                  ausführlich
                </Text>
                <Text size="caption" weight="semibold" color={style.ink} wrap="truncate-end">
                  {style.label}
                </Text>
                <Text size="caption" color={INK.muted}>
                  komprimiert
                </Text>
              </Box>
            ) : (
              // The terminal has no room for the scale's two ends beside the label.
              <Text weight="semibold" color={style.ink} wrap="truncate-end">
                {style.label}
              </Text>
            )}
            {isRich ? (
              // The track stretches; the marker is drawn apart, so it stays round, at its share of the width.
              <Box flexDirection="column">
                {wideSvg(gaugeBarSvg(chartPx), `Kompression: ${style.label}`, 16)}
                <Box position="absolute" top={0} left={0} right={0} flexDirection="row">
                  <Box width={`${Math.round(Math.min(0.97, Math.max(0.03, position)) * 100)}%`} flexShrink={0} />
                  <Box marginLeft={-1.1} flexShrink={0}>
                    {svg(markerSvg(), `Markierung bei ${Math.round(position * 100)} %`, 16, 16)}
                  </Box>
                </Box>
              </Box>
            ) : (
              <Text color={style.ink}>{scaleText(position, Math.max(12, state.columns - 12))}</Text>
            )}
            <Box flexDirection="row" justifyContent="space-between">
              <Text size="caption" tabular color={INK.muted}>
                {Math.round(q.functionWordRatio * 100)}% Füllwörter
              </Text>
              <Text size="caption" tabular color={INK.muted}>
                Ø {q.avgSegmentWords.toFixed(1)} W./Satz
              </Text>
            </Box>
          </Box>
          {hairline()}
          <Box flexDirection="column" rowGap={step('xs', 0)}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text size="caption" color={INK.secondary}>
                14 Tage Aktivität
              </Text>
              <Text size="caption" tabular>
                {u.readSessions} Sess.
              </Text>
            </Box>
            {isRich ? wideSvg(sparkSvg(u.daily, chartPx), `Nutzung je Tag: ${u.daily.join(', ')}`, 24) : <Text color={INK.success}>{spark(u.daily)}</Text>}
          </Box>
          <Box flexDirection="row" alignItems="center" columnGap={step('sm', 1)}>
            <Box flexDirection="row" alignItems="center" columnGap={step('xs', 1)} flexGrow={1} flexShrink={1} minWidth={0}>
              {isRich ? svg(iconSvg('commit', 'currentColor', 12, 0.55), '⎇', 12, 12) : <Text color={INK.muted}>⎇</Text>}
              <Text size="caption" color={INK.muted} wrap="truncate-end">
                {gitText}
              </Text>
            </Box>
            <Text size="caption" tabular color={INK.muted}>
              {gitDate}
            </Text>
          </Box>
        </Box>

        {(q.problems.length > 0 || (settings.showHints && q.hints.length > 0)) && (
          <Box flexDirection="column" rowGap={step('xs', 0)}>
            {q.problems.map(problem => (
              <Text size="caption" color={INK.warning} wrap="wrap">
                ▲ {problem}
              </Text>
            ))}
            {q.brokenLinks.length > 0 && (
              <Text size="caption" color={INK.error} wrap="truncate-end">
                {'  '}↳ {q.brokenLinks.join(', ')}
              </Text>
            )}
            {settings.showHints &&
              q.hints.map(hint => (
                <Text size="caption" color={INK.secondary} wrap="wrap">
                  ◇ {hint}
                </Text>
              ))}
          </Box>
        )}

        {review?.error !== undefined && (
          <Text size="caption" color={INK.error}>
            ✨ {review.error}
          </Text>
        )}
        {review !== undefined && review.error === undefined && (
          <Box flexDirection="column" paddingX={step('md', 1)} paddingY={step('sm', 0)} borderStyle="round" borderColor={isRich ? tint(HUE.green, 0.35) : INK.success} backgroundColor={wash(HUE.green, 0.06)}>
            <Text size="caption">
              ✨ <Text weight="semibold">{Math.round(review.score / 10)}/10</Text> · {review.compression}
              <Text color={INK.muted}>{isStale ? ' · veraltet' : ''}</Text>
            </Text>
            <Text size="caption" color={INK.secondary} wrap="wrap">
              {review.verdict}
            </Text>
            {review.tips.map(tip => (
              <Text size="caption" color={INK.secondary} wrap="wrap">
                • {tip}
              </Text>
            ))}
          </Box>
        )}

        {/* The app's own buttons: on a graphical surface they look as every other button of the desktop. */}
        <Box flexDirection="row" flexWrap="wrap" columnGap={step('xs', 1)} rowGap={step('xs', 0)}>
          <Button key={`open:${entry.path}`} label="↗ Öffnen" onPress={() => actions.open(entry)} />
          <Button key={`mention:${entry.path}`} label="@ Prompt" onPress={() => actions.mention(entry)} />
          <Button
            key={`review:${entry.path}`}
            label={isReviewing ? '✨ läuft …' : review === undefined ? '✨ KI-Review' : '✨ Neu'}
            variant={review === undefined ? 'primary' : undefined}
            onPress={() => {
              if (!isReviewing) actions.review(entry)
            }}
          />
        </Box>
      </Box>
    )
  }

  const item = (entry: DocEntry) => (state.selected === entry.path ? card(entry) : row(entry))

  // The engine refuses a tree of more than 20,000 elements, and a row costs
  // about thirty: the tree draws this many rows at most, the rest summed up.
  let rowsLeft = ROW_BUDGET

  /** The members of a branch, hung from a faint line as the mockup's tree is. */
  const members = (entries: readonly DocEntry[]) => {
    const drawn = entries.slice(0, Math.max(0, rowsLeft))
    rowsLeft -= drawn.length
    const rest = entries.length - drawn.length
    const more =
      rest > 0 ? (
        <Box paddingX={step('sm', 1)} paddingY={step('xs', 0)}>
          <Text size="caption" color={INK.muted} wrap="wrap">
            … {rest} weitere: Suche oder Filter grenzen ein
          </Text>
        </Box>
      ) : null

    return isRich ? (
      <Box flexDirection="row" marginLeft={2} marginTop="xs">
        <Box width={0.14} flexShrink={0} backgroundColor={tint(HUE.gray, 0.25)} />
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} paddingLeft="md" rowGap={0.2}>
          {drawn.map(item)}
          {more}
        </Box>
      </Box>
    ) : (
      <Box flexDirection="column" paddingLeft={2}>
        {drawn.map(item)}
        {more}
      </Box>
    )
  }

  // The tree -------------------------------------------------------------
  const memory = memoryBadge(report.memory)

  const branch = (group: GroupDef) => {
    const all = files.filter(file => group.roles.includes(file.role))
    const shown = all.filter(file => matches(file, filter, state.query)).sort(byUse)
    // The memory branch keeps its header, and the index's badge, while MEMORY.md is the only memory file.
    const isBadgeOnly = shown.length === 0 && group.id === 'memory' && memory !== null && !isFiltered
    if (shown.length === 0 && !isBadgeOnly) return null
    const flagged = shown.filter(file => file.quality.problems.length > 0).length
    const isOpen = isFiltered || isOpenGroup(group)
    const tokens = all.reduce((sum, file) => sum + file.quality.tokens, 0)
    // Under a filter every branch shows open: the header neither shows nor changes the branch's own state.
    const isInert = isFiltered || isBadgeOnly
    const press = () => actions.toggleGroup(group.id, !isOpenGroup(group))
    const label = `${group.title} ${isOpen ? 'zuklappen' : 'aufklappen'}`
    const look = (
      <Text wrap="truncate-end">
        <Text size="caption" color={INK.muted}>
          {isBadgeOnly ? '•' : isOpen ? '▼' : '▶'}
        </Text>
        {'  '}
        {group.icon}
        {'  '}
        <Text weight="semibold" color={isOpen ? INK.text : INK.secondary}>
          {group.title}
        </Text>
      </Text>
    )

    return (
      <Box key={`branch:${group.id}`} flexDirection="column">
        <Box
          key={`head:${group.id}`}
          flexDirection="row"
          alignItems="center"
          columnGap={step('sm', 1)}
          paddingX={step('sm', 1)}
          paddingY={step('xs', 0)}
          overflow="hidden"
          {...region}
        >
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            {isInert ? look : face(`group:${group.id}`, label, press, look)}
          </Box>
          <Box flexDirection="row" alignItems="center" columnGap={step('xs', 1)} flexShrink={0}>
            {group.id === 'always' && tokens > 0 && pill(`~${fmtK(tokens)} tok`, INK.violet, HUE.violet)}
            {flagged > 0 && pill(`▲ ${flagged}`, INK.warning, HUE.amber)}
            {group.id === 'memory' &&
              memory !== null &&
              pill(memory.text, memory.isClean ? INK.success : INK.warning, memory.isClean ? HUE.green : HUE.amber)}
            <Text size="caption" tabular color={INK.muted}>
              {isRich ? String(shown.length) : String(shown.length).padStart(3)}
            </Text>
          </Box>
          {isInert ? null : hit(`group:${group.id}`, label, press)}
        </Box>
        {isOpen && shown.length > 0 && members(shown)}
      </Box>
    )
  }

  const listed = files.filter(file => matches(file, filter, state.query)).sort(byUse)
  const branches =
    state.layout === 'list'
      ? listed.length === 0
        ? []
        : [
            <Box key="branch:list" flexDirection="column">
              <Box flexDirection="row" alignItems="center" paddingX={step('sm', 1)} paddingY={step('xs', 0)}>
                <Box flexGrow={1}>
                  <Text weight="semibold">🕒{'  '}Nach letzter Nutzung</Text>
                </Box>
                <Text size="caption" tabular color={INK.muted}>
                  {listed.length}
                </Text>
              </Box>
              {members(listed)}
            </Box>,
          ]
      : GROUPS.map(branch).filter(found => found !== null)

  // Footer ---------------------------------------------------------------
  const footer = (
    <Box flexDirection="row" alignItems="center" columnGap={step('sm', 1)} paddingX={step('xs', 0)} paddingY={step('xs', 0)} marginTop={isRich ? 0 : 1}>
      <Box flexDirection="row" alignItems="center" columnGap={step('sm', 1)} flexGrow={1} flexShrink={1} minWidth={0}>
        {isRich ? svg(pulseSvg(HUE.green, true), 'aktiv', 10, 10) : <Text color={INK.success}>●</Text>}
        <Text size="caption" color={INK.secondary} wrap="truncate-end">
          doc-radar{state.version === '' ? '' : ` v${state.version}`}
        </Text>
      </Box>
      <Box flexDirection="row" alignItems="center" columnGap={step('sm', 1)} flexShrink={0}>
        {Input !== undefined &&
          tool(
            'open-search',
            isRich ? (
              <Box flexDirection="row" alignItems="center" columnGap="xs">
                {svg(iconSvg('search', 'currentColor', 12, 0.7), '⌕', 12, 12)}
                <Text size="caption" color={INK.secondary}>
                  Suche
                </Text>
              </Box>
            ) : (
              <Text size="caption" color={INK.secondary}>
                ⌕ Suche
              </Text>
            ),
            'Suche öffnen',
            actions.openSearch,
          )}
        {Input !== undefined && (
          <Text size="caption" color={INK.muted}>
            |
          </Text>
        )}
        {tool(
          'autoscan',
          isRich ? (
            <Box flexDirection="row" alignItems="center" columnGap="xs">
              {settings.autoScan && svg(iconSvg('check', HUE.green, 12), '✓', 12, 12)}
              <Text size="caption" weight="medium" color={settings.autoScan ? INK.success : INK.muted}>
                {settings.autoScan ? 'Auto-Scan aktiv' : '○ Auto-Scan aus'}
              </Text>
            </Box>
          ) : (
            <Text size="caption" weight="medium" color={settings.autoScan ? INK.success : INK.muted}>
              {settings.autoScan ? '✓ Auto-Scan aktiv' : '○ Auto-Scan aus'}
            </Text>
          ),
          settings.autoScan ? 'Auto-Scan ausschalten' : 'Auto-Scan einschalten',
          () => actions.setSetting('autoScan', !settings.autoScan),
        )}
      </Box>
    </Box>
  )

  // The pane's own ground shows through. On a graphical surface the drawing
  // fills the pane's height, so a short tree keeps the footer at the bottom.
  return (
    <Box flexDirection="column" minHeight={isRich ? Math.max(1, state.rows - 0.1) : undefined}>
      {titleBar}
      {hairline()}
      {band}
      {search}
      {hairline()}
      {settingsPanel}
      <Box flexDirection="column" flexGrow={1} paddingY={step('sm', 0)} rowGap={step('sm', 0)}>
        {branches.length === 0 ? (
          <Box marginTop={step('md', 1)} paddingX={step('sm', 1)}>
            <Text color={INK.secondary}>{isFiltered ? 'Nichts in diesem Filter.' : 'Keine Markdown-Dateien gefunden.'}</Text>
          </Box>
        ) : (
          branches
        )}
      </Box>
      {hairline()}
      {footer}
    </Box>
  )
}

const BARS = '▁▂▃▄▅▆▇█'

function spark(values: readonly number[]): string {
  const max = Math.max(...values, 1)

  return values.map(value => (value === 0 ? '·' : (BARS[Math.min(7, Math.ceil((value / max) * 7))] ?? '█'))).join('')
}

function scaleText(position: number, cells: number): string {
  const at = Math.round(Math.min(1, Math.max(0, position)) * (cells - 1))

  return `${'━'.repeat(at)}◆${'━'.repeat(cells - 1 - at)}`
}
