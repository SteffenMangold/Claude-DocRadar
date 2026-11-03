import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AiReview, DocEntry, DocRadarSettings, DocReport } from '../types'
import { hashText } from './analyze'
import { REVIEW_MODEL, reviewDoc } from './review'
import { scanProject } from './scan'
import { GROUPS, handOffText, renderPane } from './view'

const PANE = 'doc-radar'
const TITLE = 'Docs'
const PANE_COLUMNS = 46
const SEARCH_KEY = 'search'
const SETTINGS_KEY = 'settings'
const DEFAULT_SETTINGS: DocRadarSettings = { autoScan: true, autoOpen: true, showHints: true }

// Change a tag when the stored value's fields change: an earlier version's
// value is then read as the initial instead of in the wrong shape.
const report = atom({ plugin: 'doc-radar', key: 'report' } as const, null, { shape: 'report-4' })
const reviews = atom({ plugin: 'doc-radar', key: 'reviews' } as const, {}, { shape: 'reviews-1' })
const selected = atom({ plugin: 'doc-radar', key: 'selected' } as const, '')
const filter = atom({ plugin: 'doc-radar', key: 'filter' } as const, 'all')
const groups = atom({ plugin: 'doc-radar', key: 'groups' } as const, {})
const isScanning = atom({ plugin: 'doc-radar', key: 'isScanning' } as const, false)
const reviewing = atom({ plugin: 'doc-radar', key: 'reviewing' } as const, '')
const query = atom({ plugin: 'doc-radar', key: 'query' } as const, '')
const isSearchOpen = atom({ plugin: 'doc-radar', key: 'isSearchOpen' } as const, false)
const isSettingsOpen = atom({ plugin: 'doc-radar', key: 'isSettingsOpen' } as const, false)
const layout = atom({ plugin: 'doc-radar', key: 'layout' } as const, 'tree')
const settings = atom({ plugin: 'doc-radar', key: 'settings' } as const, DEFAULT_SETTINGS, { shape: 'settings-1' })
const version = atom({ plugin: 'doc-radar', key: 'version' } as const, '')

// Scan scheduling lives in the module: a reload starts it over, which is fine.
let timer: Timer | undefined
let isRunning = false
let isQueued = false

function schedule($: EngineInterface, delayMs: number): void {
  timer?.cancel()
  timer = $.clock.after(delayMs, () => {
    void runScan($)
  })
}

async function runScan($: EngineInterface): Promise<void> {
  if (isRunning) {
    isQueued = true

    return
  }
  isRunning = true
  await update($, isScanning, () => true)
  try {
    const result = await scanProject($)
    await update($, report, () => result)
  } catch (error) {
    $.ui.log(`doc-radar: scan failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  } finally {
    isRunning = false
    await update($, isScanning, () => false)
    if (isQueued) {
      isQueued = false
      schedule($, 500)
    }
  }
}

async function openPane($: EngineInterface, isLoud: boolean): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
  if (!opened.isPlaced) {
    $.ui.log(`doc-radar: Seitenleiste wartet: ${opened.reason}`, isLoud ? undefined : { to: 'debug' })
  }
}

/** Store keys are per project, so each project keeps its own reviews and layout. */
function projectKey(root: string): string {
  return root.replace(/[^a-zA-Z0-9]/g, '-')
}

/** The settings as stored, each one missing or of the wrong type at its default. */
function readSettings(stored: unknown): DocRadarSettings {
  const value = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {}
  const flag = (key: keyof DocRadarSettings) => (typeof value[key] === 'boolean' ? value[key] : DEFAULT_SETTINGS[key])

  return { autoScan: flag('autoScan'), autoOpen: flag('autoOpen'), showHints: flag('showHints') }
}

async function loadStored($: EngineInterface): Promise<DocRadarSettings> {
  const key = projectKey(await $.session.root())
  const stored = await $.store.get(`ai:${key}`).catch(() => undefined)
  if (typeof stored === 'object' && stored !== null) {
    await update($, reviews, () => stored as Record<string, AiReview>)
  }
  const kept = await $.store.get(`ui:${key}`).catch(() => undefined)
  if (typeof kept === 'object' && kept !== null) {
    await update($, groups, () => kept as Record<string, boolean>)
  }
  // The wheel diagnosis of 0.2.0's development left its log here.
  await $.store.delete('debug:scroll').catch(() => undefined)
  const chosen = readSettings(await $.store.get(SETTINGS_KEY).catch(() => undefined))
  await update($, settings, () => chosen)
  const manifest = await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`).catch(() => '')
  const stated = /"version"\s*:\s*"([^"]+)"/.exec(manifest)?.[1]
  if (stated !== undefined) await update($, version, () => stated)

  return chosen
}

async function toggleGroup($: EngineInterface, id: string, isOpen: boolean, root: string): Promise<void> {
  const next = await update($, groups, current => ({ ...current, [id]: isOpen }))
  await $.store.set(`ui:${projectKey(root)}`, next).catch(() => undefined)
}

async function toggleAll($: EngineInterface, isOpen: boolean, root: string): Promise<void> {
  const next = await update($, groups, () => Object.fromEntries(GROUPS.map(group => [group.id, isOpen])))
  await $.store.set(`ui:${projectKey(root)}`, next).catch(() => undefined)
}

async function setSetting($: EngineInterface, key: keyof DocRadarSettings, value: boolean): Promise<void> {
  const next = await update($, settings, current => ({ ...current, [key]: value }))
  await $.store.set(SETTINGS_KEY, next).catch(() => undefined)
  if (key === 'autoScan' && value) schedule($, 0)
}

async function openSearch($: EngineInterface): Promise<void> {
  await update($, isSearchOpen, () => true)
  await $.ui.focus({ requestId: PANE, key: SEARCH_KEY }).catch(() => undefined)
}

async function closeSearch($: EngineInterface): Promise<void> {
  await update($, query, () => '')
  await update($, isSearchOpen, () => false)
}

async function handOff($: EngineInterface, data: DocReport): Promise<void> {
  const text = handOffText(data.files)
  if (text === null) {
    $.ui.toast('Keine Probleme zu übergeben')

    return
  }
  // Set apart from a draft the person has already typed.
  const draft = (await $.prompt.read().catch(() => null))?.text ?? ''
  const filled = await $.prompt.fill({ text: draft.trim() === '' ? text : `\n\n${text}`, mode: 'append' }).catch(() => null)
  if (filled?.isFilled !== true) $.ui.toast('Der Prompt nimmt gerade keinen Text an')
}

async function startReview($: EngineInterface, entry: DocEntry, root: string): Promise<void> {
  if ((await read($, reviewing)) !== '') return
  await update($, reviewing, () => entry.path)
  try {
    const text = await $.fs.read(entry.absPath)
    const review = await reviewDoc($, entry, text, hashText(text))
    const all = await update($, reviews, current => ({ ...current, [entry.path]: review }))
    await $.store.set(`ai:${projectKey(root)}`, all).catch(() => undefined)
  } catch (error) {
    const at = await $.clock.now()
    const message = error instanceof Error ? error.message : String(error)
    await update($, reviews, current => ({
      ...current,
      [entry.path]: { hash: '', at, model: REVIEW_MODEL, score: 0, compression: '', verdict: '', tips: [], error: message },
    }))
  } finally {
    await update($, reviewing, () => '')
  }
}

async function openFile($: EngineInterface, entry: DocEntry): Promise<void> {
  const isWindows = /^[A-Za-z]:\\/.test(entry.absPath)
  const argv = isWindows ? ['explorer.exe', entry.absPath] : [(await $.env.get('OSTYPE'))?.startsWith('darwin') === true ? 'open' : 'xdg-open', entry.absPath]
  const ran = await $.process.run(argv).catch(() => null)
  if (ran === null) $.ui.toast(`Konnte ${entry.name} nicht öffnen`)
}

/** Whether a tool call may change what the sidebar shows. */
function touchesDocs(e: { tool: unknown }): boolean {
  const input = e as unknown as Record<string, unknown>
  const tool = String(e.tool)
  const file = input['file_path']
  const command = input['command']
  if (typeof file === 'string' && /\.(md|mdx|markdown)$/i.test(file)) return true
  if (typeof command === 'string' && /\.(md|mdx|markdown)\b/i.test(command)) return true

  return tool === 'Skill' || tool === 'Agent' || tool === 'Task'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'doc-radar',
      description: 'Seitenleiste: alle Markdown-Dateien des Projekts mit Nutzung und Qualität',
    })
    const chosen = await loadStored($)
    if (chosen.autoOpen) {
      // Opened whatever the host: the desktop app starts sessions non-interactive,
      // and a pane opened before a surface attaches waits for one.
      const surfaces = await $.session.surfaces().catch(() => [])
      void openPane($, surfaces.length > 0)
      schedule($, 800)
    }

    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    if ((await read($, settings)).autoOpen) void openPane($, true)

    return attached
  })

  on('command.run', { command: 'doc-radar' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
    schedule($, 0)

    return { text: opened.isPlaced ? 'Docs-Seitenleiste geöffnet.' : `Docs-Seitenleiste wartet: ${opened.reason}` }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (touchesDocs(e) && (await read($, settings)).autoScan) schedule($, 2500)

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if ((await read($, settings)).autoScan && (await $.ui.panes()).some(pane => pane.id === PANE)) schedule($, 1500)

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const data: DocReport | null = await read($, report)
    const scanning = await read($, isScanning)

    if (data === null) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>{scanning ? 'Scanne Markdown-Dateien und Transkripte …' : 'Noch kein Scan.'}</Text>
          <Button key="scan" label="Jetzt scannen" variant="primary" onPress={() => schedule($, 0)} />
        </Box>
      )
    }

    return renderPane(
      ui,
      {
        report: data,
        now: await $.clock.now(),
        selected: await read($, selected),
        filter: await read($, filter),
        groups: await read($, groups),
        reviews: await read($, reviews),
        reviewing: await read($, reviewing),
        isScanning: scanning,
        columns: e.props.bodyColumns,
        rows: e.props.scroll.bodyRows,
        surface: e.surface,
        query: await read($, query),
        isSearchOpen: await read($, isSearchOpen),
        isSettingsOpen: await read($, isSettingsOpen),
        layout: await read($, layout),
        settings: await read($, settings),
        version: await read($, version),
      },
      {
        toggleFile: path => void update($, selected, current => (current === path ? '' : path)),
        toggleGroup: (id, isOpen) => void toggleGroup($, id, isOpen, data.root),
        toggleAll: isOpen => void toggleAll($, isOpen, data.root),
        setFilter: value => void update($, filter, () => value),
        rescan: () => schedule($, 0),
        review: entry => void startReview($, entry, data.root),
        open: entry => void openFile($, entry),
        mention: entry =>
          void $.prompt.fill({ text: `@${entry.path.startsWith('~memory/') ? entry.absPath : entry.path} `, mode: 'insert' }),
        toggleLayout: () => void update($, layout, current => (current === 'tree' ? 'list' : 'tree')),
        handOff: () => void handOff($, data),
        toggleSettings: () => void update($, isSettingsOpen, current => !current),
        setSetting: (key, value) => void setSetting($, key, value),
        close: () => {
          // The search field starts empty when the pane comes back, so its filter goes too.
          void closeSearch($)
          void $.ui.close({ id: PANE }).catch(() => undefined)
        },
        setQuery: value => void update($, query, () => value),
        openSearch: () => void openSearch($),
        closeSearch: () => void closeSearch($),
      },
    )
  })
}
