import { expect, mock, test } from 'claude-code/testing'

import { analyzeMarkdown, measureIndex, scoreDoc } from '../hooks/analyze'

const PANE = {
  plugin: 'doc-radar',
  component: 'Pane',
  requestId: 'doc-radar',
  props: {
    title: 'Docs',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const GUIDE_WORDS = Array.from(
  { length: 12 },
  () => 'The build runs in Release on every pull request, and the tests must stay green before a merge.',
).join(' ')

const AGENT_WORDS = Array.from(
  { length: 8 },
  (_, n) => `Rule ${n}: an agent keeps every change small and explains in the commit why it was needed.`,
).join(' ')

const PROJECT: Record<string, string> = {
  'D:/proj/CLAUDE.md': '# Project\n\n@AGENTS.md\n',
  'D:/proj/AGENTS.md': `# Agents\n\nRead [the guide](docs/GUIDE.md) for the build, and [this](docs/NOPE.md) is gone.\n\n${AGENT_WORDS}\n`,
  'D:/proj/docs/GUIDE.md': `# Guide\n\n${GUIDE_WORDS}\n`,
  'D:/proj/docs/ORPHAN.md': '# Orphan\n\nTODO write this.\n',
}

const MEMORY_DIR = 'C:/Users/me/.claude/projects/D--proj/memory'

const MEMORY: Record<string, string> = {
  [`${MEMORY_DIR}/MEMORY.md`]: '- [Build](build.md) — how the build runs\n',
  [`${MEMORY_DIR}/build.md`]: '---\nname: build\n---\n\nThe build runs in Release and the tests must stay green.\n',
  [`${MEMORY_DIR}/stray.md`]: '---\nname: stray\n---\n\nA note that nothing in the index points to yet.\n',
}

const TRANSCRIPT = [
  { type: 'user', timestamp: '2026-11-03T10:00:00.000Z', message: { role: 'user', content: 'hello' } },
  {
    type: 'assistant',
    timestamp: '2026-11-03T10:01:00.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'D:\\proj\\docs\\GUIDE.md' } }] },
  },
  {
    type: 'assistant',
    timestamp: '2026-11-03T10:02:00.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'cat docs/GUIDE.md' } }] },
  },
]
  .map(line => JSON.stringify(line))
  .join('\n')

const TX_PATH = 'C:/Users/me/.claude/projects/D--proj/s1.jsonl'

function ran(stdout: string) {
  return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

const slash = (path: string) => path.replace(/\\/g, '/')

type On = Parameters<Parameters<typeof test>[1]>[1]

/** A project at D:\proj with git, one transcript and, when given, Claude memory files and more docs; returns the store. */
function project(on: On, memory: Record<string, string> = {}, more: Record<string, string> = {}): Map<string, unknown> {
  const files = { ...PROJECT, ...more, ...memory }
  const ALL = Object.keys({ ...PROJECT, ...more }).map(path => path.slice('D:/proj/'.length))
  const stored = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_, e) => {
    stored.set(e.key, e.value)

    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'doc-radar' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.focus', () => ({ value: {} }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: 'D:\\proj' }))
  on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined }))
  on('process.run', (_, e) => {
    const args = e.argv.slice(3)
    if (args[0] === 'rev-parse') return ran('\n')
    if (args[0] === 'ls-files') return ran(`${ALL.join('\0')}\0`)
    if (args[0] === 'log') return ran(`@@1793500000\n\n${ALL.join('\n')}\n`)

    return ran('')
  })
  on('fs.list', (_, e) => {
    const path = slash(e.path)
    const entry = (name: string, kind: 'file' | 'dir', size = 0) => ({ name, kind, size, mtimeMs: 1, isLink: false })
    if (path === 'C:/Users/me/.claude/projects') return { value: [entry('D--proj', 'dir')] }
    if (path === 'C:/Users/me/.claude/projects/D--proj') return { value: [entry('s1.jsonl', 'file', TRANSCRIPT.length), entry('memory', 'dir')] }
    if (path === MEMORY_DIR) {
      return { value: Object.keys(memory).map(file => entry(file.slice(MEMORY_DIR.length + 1), 'file', memory[file]?.length ?? 0)) }
    }

    return { value: [] }
  })
  on('fs.stat', (_, e) => {
    const text = files[slash(e.path)] ?? ''

    return { value: { kind: 'file', size: text.length, mtimeMs: 1_793_500_000_000, isLink: false } }
  })
  on('fs.read', (_, e) => {
    const path = slash(e.path)
    if (path.endsWith('/.claude-plugin/plugin.json')) return { value: '{ "name": "doc-radar", "version": "9.9.9" }' }

    return { value: path === TX_PATH ? TRANSCRIPT : (files[path] ?? '') }
  })
  on('fs.exists', () => ({ value: false }))

  return stored
}

/** Takes every prompt.fill, as the composer would; returns the texts filled. */
function fillsPrompt(on: On): string[] {
  const filled: string[] = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: true, text: e.text, cursor: e.text.length }
  })

  return filled
}

test('a scan lists every file with its use and its problems', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-03T12:00:00.000Z') })
  const stored = project(on)

  await $.session.start({ cwd: 'D:\\proj', surface: 'desktop', isInteractive: true })
  await clock.advance(1_000)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // The tiles count the files and those with problems; the version comes from plugin.json.
    const files = String((await ui.find({ key: 'filter:all' }))?.props['label'])
    expect(files).toMatch(/Dateien 4$/)
    // On the desktop the press layer's label must reach the surface untrimmed: its blanks are what shows.
    // The terminal draws its Buttons as they are, and no Svg.
    if (surface === 'desktop') expect(files.startsWith(' '.repeat(64))).toBe(true)
    // No drawing in a frame: the desktop patches a redraw around frames, which scrolls the pane to its end.
    if (surface === 'desktop') expect((await ui.findAll({ type: 'Svg' })).filter(found => found.props['isInteractive'] === true)).toHaveLength(0)
    if (surface === 'terminal') {
      expect(files.startsWith(' ')).toBe(false)
      expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
    }
    expect(String((await ui.find({ key: 'filter:problems' }))?.props['label'])).toMatch(/Probleme 2$/)
    expect(await ui.find({ type: 'Text', text: /doc-radar v9\.9\.9/ })).toBeDefined()
    expect(await ui.find({ key: 'file:CLAUDE.md' })).toBeDefined()
    expect(await ui.find({ key: 'file:AGENTS.md' })).toBeDefined()
    expect(await ui.find({ key: 'file:docs/GUIDE.md' })).toBeDefined()

    // The hover card counts one Read and one shell read.
    expect(await ui.find({ type: 'Text', text: /👁 2x/ })).toBeDefined()

    // The card lists each problem on its own line; the hidden hover card joins them on one.
    expect(await ui.find({ type: 'Text', text: /^▲ 1× TODO\/TBD\/FIXME$/ })).toBeUndefined()
    await ui.press({ key: 'file:docs/ORPHAN.md' })
    expect(await ui.find({ type: 'Text', text: /^▲ Verwaist, nirgends verlinkt$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^▲ 1× TODO\/TBD\/FIXME$/ })).toBeDefined()
    expect(await ui.find({ key: 'review:docs/ORPHAN.md' })).toBeDefined()
    await ui.press({ key: 'file:docs/ORPHAN.md' })

    await ui.press({ key: 'file:AGENTS.md' })
    expect(await ui.find({ type: 'Text', text: /docs\/NOPE\.md/ })).toBeDefined()
    await ui.press({ key: 'file:AGENTS.md' })

    // A tile filters: only files with problems stay, and the branches show open without a press of their own.
    await ui.press({ key: 'filter:problems' })
    expect(await ui.find({ key: 'file:docs/GUIDE.md' })).toBeUndefined()
    expect(await ui.find({ key: 'file:docs/ORPHAN.md' })).toBeDefined()
    expect(await ui.find({ key: 'group:docs' })).toBeUndefined()
    expect(await ui.find({ key: 'expand' })).toBeUndefined()
    await ui.press({ key: 'filter:problems' })

    // A closed branch hides its files and stays closed.
    await ui.press({ key: 'group:docs' })
    expect(await ui.find({ key: 'file:docs/GUIDE.md' })).toBeUndefined()
    expect(stored.get('ui:D--proj')).toEqual({ docs: false })
    await ui.press({ key: 'group:docs' })

    await ui.unmount()
  }
})

test('the search narrows the files to the matching paths', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-03T12:00:00.000Z') })
  project(on)
  await $.session.start({ cwd: 'D:\\proj', surface: 'desktop', isInteractive: true })
  await clock.advance(1_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ key: 'search' })).toBeUndefined()
  await ui.press({ key: 'open-search' })
  await ui.input({ key: 'search', text: 'guide', kind: 'change' })
  expect(await ui.find({ key: 'file:docs/GUIDE.md' })).toBeDefined()
  expect(await ui.find({ key: 'file:docs/ORPHAN.md' })).toBeUndefined()
  expect(await ui.find({ key: 'file:AGENTS.md' })).toBeUndefined()

  await ui.press({ key: 'search-close' })
  expect(await ui.find({ key: 'search' })).toBeUndefined()
  expect(await ui.find({ key: 'file:docs/ORPHAN.md' })).toBeDefined()
  await ui.unmount()
})

test('the title bar switches the layout, opens the settings and hands the problems to the prompt', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-03T12:00:00.000Z') })
  const stored = project(on)
  const filled = fillsPrompt(on)
  await $.session.start({ cwd: 'D:\\proj', surface: 'desktop', isInteractive: true })
  await clock.advance(1_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // One list by last use instead of the tree.
  await ui.press({ key: 'layout' })
  expect(await ui.find({ type: 'Text', text: /Nach letzter Nutzung/ })).toBeDefined()
  expect(await ui.find({ key: 'group:docs' })).toBeUndefined()
  await ui.press({ key: 'layout' })
  expect(await ui.find({ key: 'group:docs' })).toBeDefined()

  // Every branch starts open here (each holds a problem): one press closes all, the next opens all.
  await ui.press({ key: 'expand' })
  expect(await ui.find({ key: 'file:docs/GUIDE.md' })).toBeUndefined()
  expect(await ui.find({ key: 'file:CLAUDE.md' })).toBeUndefined()
  await ui.press({ key: 'expand' })
  expect(await ui.find({ key: 'file:docs/GUIDE.md' })).toBeDefined()

  // A setting is kept for every project.
  await ui.press({ key: 'settings' })
  await ui.press({ key: 'setting:showHints' })
  expect(stored.get('settings')).toEqual({ autoScan: true, autoOpen: true, showHints: false })
  await ui.press({ key: 'autoscan' })
  expect(stored.get('settings')).toEqual({ autoScan: false, autoOpen: true, showHints: false })
  expect(await ui.find({ type: 'Text', text: /Auto-Scan aus/ })).toBeDefined()

  // Every file with a problem goes to the prompt as one task.
  await ui.press({ key: 'handoff' })
  expect(filled).toHaveLength(1)
  expect(filled[0]).toContain('- docs/ORPHAN.md: 1× TODO/TBD/FIXME; Verwaist, nirgends verlinkt')
  expect(filled[0]).toContain('- AGENTS.md: 1 kaputter Link (Links: docs/NOPE.md)')
  expect(filled[0]).not.toContain('GUIDE.md:')
  await ui.unmount()
})

test('a memory file the index leaves out is flagged, one it lists is not', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-03T12:00:00.000Z') })
  project(on, MEMORY)
  const filled = fillsPrompt(on)
  await $.session.start({ cwd: 'D:\\proj', surface: 'desktop', isInteractive: true })
  await clock.advance(1_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // The Memory branch's badge, and the flagged file's own card.
  expect(await ui.find({ type: 'Text', text: /^1 ohne Index$/ })).toBeDefined()
  await ui.press({ key: 'file:~memory/stray.md' })
  expect(await ui.find({ key: 'review:~memory/stray.md' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^▲ Fehlt im MEMORY\.md-Index$/ })).toBeDefined()

  await ui.press({ key: 'handoff' })
  expect(filled[0]).toContain('stray.md: Fehlt im MEMORY.md-Index')
  expect(filled[0]).not.toContain('build.md')
  await ui.unmount()
})

test('an index that grew too long keeps its badge though it is the only memory file', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-03T12:00:00.000Z') })
  const index = Array.from({ length: 250 }, (_, n) => `- [Note ${n}](note-${n}.md) — one line`).join('\n')
  project(on, { [`${MEMORY_DIR}/MEMORY.md`]: index })
  await $.session.start({ cwd: 'D:\\proj', surface: 'desktop', isInteractive: true })
  await clock.advance(1_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /^trim 250\/200$/ })).toBeDefined()
  await ui.press({ key: 'file:~memory/MEMORY.md' })
  expect(await ui.find({ type: 'Text', text: /^▲ 250 Zeilen: nur 200 geladen$/ })).toBeDefined()
  await ui.unmount()
})

test('a project at the file limit still draws, its overflow summed up', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-03T12:00:00.000Z') })
  const many = Object.fromEntries(Array.from({ length: 599 }, (_, n) => [`D:/proj/docs/n${n}.md`, '# Note\n\nTODO\n']))
  project(on, {}, many)
  await $.session.start({ cwd: 'D:\\proj', surface: 'desktop', isInteractive: true })
  await clock.advance(1_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /^… \d+ weitere: Suche oder Filter grenzen ein$/ })).toBeDefined()
  await ui.unmount()
})

test('the hand-off is set apart from a draft, and the phone gets no search', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-03T12:00:00.000Z') })
  project(on)
  const filled = fillsPrompt(on)
  on('prompt.read', () => ({ value: { text: 'Bitte', cursor: 5 } }))
  await $.session.start({ cwd: 'D:\\proj', surface: 'desktop', isInteractive: true })
  await clock.advance(1_000)

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desktop.press({ key: 'handoff' })
  expect(filled[0]?.startsWith('\n\nDoc Radar meldet')).toBe(true)
  await desktop.unmount()

  const phone = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await phone.find({ key: 'open-search' })).toBeUndefined()
  expect(await phone.find({ key: 'file:docs/GUIDE.md' })).toBeDefined()
  await phone.unmount()
})

test('the memory index is measured as Claude Code loads it', async () => {
  const text = ['---', 'name: index', '---', '# Memory', '<!-- kept out', 'of the load -->', '- [Build](build.md) — the build', '', ''].join('\n')
  expect(measureIndex(text)).toEqual({ lines: 2, bytes: '# Memory\n- [Build](build.md) — the build'.length + 2 })

  const long = Array.from({ length: 201 }, (_, n) => `- [Note ${n}](note-${n}.md) — one line`).join('\n')
  const scored = scoreDoc({
    role: 'always',
    metrics: analyzeMarkdown(long),
    brokenLinks: 0,
    inbound: 0,
    duplicateShare: 0,
    duplicateWith: null,
    isEntryPoint: true,
    daysSinceChange: 0,
    indexLoad: { size: measureIndex(long), limit: { lines: 200, bytes: 25_000 } },
  })
  expect(scored.problems).toContain('201 Zeilen: nur 200 geladen')
})

test('the pane opens in a session the desktop app starts', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const opened: string[] = []
  on('command.register', () => ({ value: { command: 'doc-radar' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('session.root', () => ({ value: 'D:\\proj' }))
  on('session.surfaces', () => ({ value: [] }))

  await $.session.start({ cwd: 'D:\\proj', surface: null, isInteractive: false })
  expect(opened).toContain('doc-radar')

  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(opened.length).toBe(2)
})

test('with opening at start turned off, the pane waits for /doc-radar', async ($, on) => {
  mock.clock(on)
  const opened: string[] = []
  on('store.get', (_, e) => ({ value: e.key === 'settings' ? { autoScan: true, autoOpen: false, showHints: true } : undefined }))
  on('command.register', () => ({ value: { command: 'doc-radar' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('session.root', () => ({ value: 'D:\\proj' }))
  on('session.surfaces', () => ({ value: [] }))

  await $.session.start({ cwd: 'D:\\proj', surface: null, isInteractive: false })
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(opened).toHaveLength(0)
})

test('the pane offers a scan before the first one', async ($, on) => {
  mock.clock(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ type: 'Text' }))?.text).toBe('Noch kein Scan.')
  await ui.unmount()
})
