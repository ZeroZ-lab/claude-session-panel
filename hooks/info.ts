import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Category, Change, Changes, Connector, Ctx, CtxEvent, Env, Output, Sample } from '../types'
import { describeCall } from './fleet'
import { baseName, clip, homeShort, same, shortTokens } from './text'

// The overview: where the session runs, how full its context is and how that
// moved, which connectors it has, what it made, and what it changed.

export const env = atom({ plugin: 'session-panel', key: 'env' } as const, null, { shape: 'env-1' })
export const ctx = atom({ plugin: 'session-panel', key: 'ctx' } as const, null, { shape: 'ctx-2' })
export const connectors = atom({ plugin: 'session-panel', key: 'connectors' } as const, [], { shape: 'connectors-1' })
export const outputs = atom({ plugin: 'session-panel', key: 'outputs' } as const, [], { shape: 'outputs-1' })
export const changes = atom(
  { plugin: 'session-panel', key: 'changes' } as const,
  { isRepo: false, count: 0, sessionCount: 0, added: 0, removed: 0, files: [] },
  { shape: 'changes-2' },
)
export const samples = atom({ plugin: 'session-panel', key: 'samples' } as const, [], { shape: 'samples-1' })
export const events = atom({ plugin: 'session-panel', key: 'events' } as const, [], { shape: 'events-2' })
export const trendMode = atom({ plugin: 'session-panel', key: 'trendMode' } as const, 'total')

const MAX_OUTPUTS = 30
const MAX_CHANGES_KEPT = 30
// How many changed entries are looked at to tell this session's from earlier ones.
const MAX_CHANGES_STATED = 200
// How many files are looked at at once.
const STAT_BATCH = 20
const MAX_SAMPLES = 200
const MAX_EVENTS = 40
// The per-category estimate is worked out on this machine: often enough to
// colour the bars, not on every tool call.
const BREAKDOWN_EVERY_MS = 20_000
const EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g
const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/

export const CHART_ROWS = 6
// Eighths of a cell, from empty to full, for the tops of the bars.
export const BLOCKS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const
export const EVENT_LOOK = {
  compact: { glyph: '✂', color: 'success' },
  drop: { glyph: '↓', color: 'success' },
  jump: { glyph: '▲', color: 'warning' },
  model: { glyph: '⇄', color: 'suggestion' },
  skill: { glyph: '✦', color: 'suggestion' },
} as const
// The rows /context lists that the conversation itself fills; every other used row is carried on each request.
const CONVERSATION_ROWS = new Set(['Messages', 'Summarized conversation', 'Conversation'])

// Colors a part takes when /context gave it one an earlier part already has.
const SPARE_COLORS = ['claude', 'suggestion', 'merged', 'planMode', 'ide', 'permission', 'remember', 'autoAccept', 'warning']

/**
 * The used rows of /context, each with a color no other row has, so the bar
 * and its legend can be told apart. Rows keep /context's order, and so the
 * same rows always get the same colors.
 */
const usedRows = (rows: readonly { name: string; tokens: number; color: string; kind: string }[]): Category[] => {
  const taken = new Set<string>()
  return rows
    .filter(row => row.kind === 'used' && row.tokens > 0)
    .map(row => {
      const color = taken.has(row.color) ? (SPARE_COLORS.find(one => !taken.has(one)) ?? row.color) : row.color
      taken.add(color)
      return { name: row.name, tokens: row.tokens, color }
    })
}

/** Where a tool comes from, as the log and the trend tag it. */
export const sourceOf = (tool: string): string =>
  tool.startsWith('mcp__') ? `mcp:${tool.split('__')[1] ?? ''}` : tool === 'Skill' ? 'skill' : ''

export const STATUS_COLORS: Record<string, string> = {
  M: 'warning', A: 'success', '?': 'success', D: 'error', R: 'suggestion', U: 'error',
}

let isChangesStale = true
// Each refresh takes a number; one that finishes after a later one wrote is dropped.
let envRun = 0
let envWritten = 0
let ctxRun = 0
let ctxWritten = 0
let isSampling = false
let isSamplePending = false
let isPendingDetailed = false
let isEnvRunning = false
// The top of the repository each session folder is in: git names changed files from there.
const tops = new Map<string, string>()
// Files known to be this session's, by when the session began and the path: a later write keeps them so.
const sessionFiles = new Set<string>()
let pendingCause: { label: string; source: string; size: number } = { label: '', source: '', size: 0 }
// The main conversation's last finished tool call: what the next reading's growth came from.
let lastTool = ''
let lastToolSource = ''
let lastToolSize = 0
let lastModel = ''
// A compaction this mod heard about, so the reading after it is marked with it.
let isCompactNoted = false
let lastParts: Category[] = []
let lastBreakdownAt = 0
let beat = 0

/** Runs git in `cwd`; null when it fails, times out, or this is not a repository. */
async function git($: EngineInterface, cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const run = await $.process.run(['git', '--no-optional-locks', ...args], { cwd, timeoutMs: 8_000 })
    return run.exitCode === 0 ? run.stdout : null
  } catch {
    return null
  }
}

/**
 * Reads `git status --porcelain=v2 -z --branch`. Every field ends in NUL, so
 * no path comes quoted or escaped, whatever characters it holds.
 */
const parseStatus = (out: string) => {
  let branch = ''
  let ahead = 0
  let behind = 0
  const files: Change[] = []
  const fields = out.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? ''
    if (field.startsWith('# branch.head ')) branch = field.slice(14)
    else if (field.startsWith('# branch.ab ')) {
      const [a, b] = field.slice(12).split(' ')
      ahead = Math.abs(Number(a) || 0)
      behind = Math.abs(Number(b) || 0)
    } else if (field.startsWith('? ')) {
      files.push({ path: field.slice(2), status: '?', added: 0, removed: 0, isSession: false })
    } else if (field.startsWith('1 ') || field.startsWith('2 ') || field.startsWith('u ')) {
      const parts = field.split(' ')
      const xy = parts[1] ?? '..'
      // Fields before the path: 8 for a change, 9 for a rename or copy, 10 for a conflict.
      const skip = field.startsWith('1 ') ? 8 : field.startsWith('2 ') ? 9 : 10
      const status = field.startsWith('u ') ? 'U' : (xy.replace(/\./g, '')[0] ?? 'M')
      files.push({ path: parts.slice(skip).join(' '), status, added: 0, removed: 0, isSession: false })
      // A rename's old path follows as a field of its own.
      if (field.startsWith('2 ')) i += 1
    }
  }
  return { branch, ahead, behind, files }
}

/** Adds `git diff --numstat` line counts to the tracked files. */
const addLineCounts = (files: Change[], out: string) => {
  for (const record of out.split('\0')) {
    const [a, r, ...rest] = record.split('\t')
    const file = files.find(one => one.path === rest.join('\t'))
    if (file !== undefined) {
      file.added = Number(a) || 0
      file.removed = Number(r) || 0
    }
  }
}

/** The repository's top folder, `''` outside one. Asked once per folder that answers. */
async function topOf($: EngineInterface, root: string): Promise<string> {
  const known = tops.get(root)
  if (known !== undefined) return known
  const out = await git($, root, ['rev-parse', '--show-toplevel'])
  const top = out?.trim() ?? ''
  if (top !== '') tops.set(root, top)
  return top
}

/** Whether a surface draws the pane now: git and the file reads wait while nobody can see them. */
async function isPaneSeen($: EngineInterface): Promise<boolean> {
  const panes = await $.ui.panes().catch(() => undefined)
  // Nothing to ask: work as before.
  if (panes === undefined) return true
  return panes.some(pane => pane.id === 'session-panel' && pane.isPlaced && pane.isShown)
}

export async function refreshEnv($: EngineInterface) {
  // One at a time: git may take seconds in a big repository.
  if (isEnvRunning) return
  isEnvRunning = true
  try {
    await readEnv($)
  } finally {
    isEnvRunning = false
  }
}

async function readEnv($: EngineInterface) {
  const run = ++envRun
  // Cleared first: an edit while this runs marks it again for the next one.
  isChangesStale = false
  const root = await $.session.root()
  const [startedAt, model, version, repo, status] = await Promise.all([
    // Read each time: /clear starts the session's count again.
    $.session.usage().then(usage => usage.startedAt).catch(() => 0),
    $.session.model().catch(() => ''),
    $.session.version().then(v => v.version).catch(() => ''),
    $.session.repo().catch(() => null),
    // Untracked directories stand as one entry: listing every file in them
    // is what makes a big repository slow.
    git($, root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal']),
  ])
  const state = status === null ? null : parseStatus(status)
  if (state !== null && state.files.some(file => file.status !== '?')) {
    const numstat = await git($, root, ['diff', '-z', '--numstat', '--no-renames', 'HEAD'])
    if (numstat !== null) addLineCounts(state.files, numstat)
  }
  // git names files from the repository's top, which a session started in a subfolder is not.
  const top = await topOf($, root)
  // A status that failed is not proof of no repository: the top answering is.
  const isRepo = state !== null || top !== ''
  // A file written since the session began is this session's change; the rest were there before.
  if (state !== null && startedAt > 0 && top !== '') {
    const looked = state.files.slice(0, MAX_CHANGES_STATED)
    for (let i = 0; i < looked.length; i += STAT_BATCH) {
      await Promise.all(looked.slice(i, i + STAT_BATCH).map(async file => {
        const key = `${startedAt}:${file.path}`
        if (sessionFiles.has(key)) {
          file.isSession = true
          return
        }
        const stat = await $.fs.stat(`${top}/${file.path.replace(/\/$/, '')}`).catch(() => undefined)
        file.isSession = stat !== undefined && stat.mtimeMs >= startedAt
        if (file.isSession) sessionFiles.add(key)
      }))
    }
    if (sessionFiles.size > 2_000) sessionFiles.clear()
  }

  if (run < envWritten) return
  envWritten = run

  const previous = await read($, env)
  const next: Env = {
    root,
    branch: state?.branch ?? (isRepo ? (previous?.branch ?? '') : ''),
    ahead: state?.ahead ?? (isRepo ? (previous?.ahead ?? 0) : 0),
    behind: state?.behind ?? (isRepo ? (previous?.behind ?? 0) : 0),
    remote: repo?.name ?? repo?.remote?.replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '') ?? '',
    model,
    version,
  }
  if (!same(previous, next)) await update($, env, () => next)

  // git is in a repository but failed this time (slow, busy): keep what the pane shows.
  if (state === null && isRepo) return
  // This session's first, each part in git's order.
  const files = [...(state?.files ?? [])].sort((a, b) => Number(b.isSession) - Number(a.isSession))
  const nextChanges: Changes = {
    isRepo,
    count: files.length,
    sessionCount: files.filter(file => file.isSession).length,
    added: files.reduce((sum, f) => sum + f.added, 0),
    removed: files.reduce((sum, f) => sum + f.removed, 0),
    files: files.slice(0, MAX_CHANGES_KEPT),
  }
  if (!same(await read($, changes), nextChanges)) await update($, changes, () => nextChanges)
}

export async function refreshCtx($: EngineInterface, withBreakdown: boolean) {
  const run = ++ctxRun
  const usage = await $.session.usage(withBreakdown ? { breakdown: 'summary' } : undefined)
  if (run < ctxWritten) return
  ctxWritten = run

  const previous = await read($, ctx)
  const breakdown = usage.context.breakdown
  const used = usedRows(breakdown?.categories ?? [])
  const serverTokens = new Map<string, number>()
  // Older engines may leave the detail lists out: read them as empty.
  const mcpTools: readonly { serverName: string; tokens: number }[] = breakdown?.mcpTools ?? []
  for (const tool of mcpTools) {
    serverTokens.set(tool.serverName, (serverTokens.get(tool.serverName) ?? 0) + tool.tokens)
  }
  // Without a breakdown this time, the last one's detail stands.
  const detail = breakdown === undefined
    ? {
        categories: previous?.categories ?? [],
        threshold: previous?.threshold ?? 0,
        buffer: previous?.buffer ?? 0,
        fixed: previous?.fixed ?? 0,
        conversation: previous?.conversation ?? 0,
        servers: previous?.servers ?? [],
        memory: previous?.memory ?? [],
      }
    : {
        categories: [...used]
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, 5)
          .map(row => ({ name: row.name, tokens: row.tokens, color: row.color })),
        threshold: breakdown.isAutoCompactEnabled ? (breakdown.autoCompactThreshold ?? 0) : 0,
        buffer: breakdown.categories.filter(row => row.kind === 'buffer').reduce((sum, row) => sum + row.tokens, 0),
        fixed: used.filter(row => !CONVERSATION_ROWS.has(row.name)).reduce((sum, row) => sum + row.tokens, 0),
        conversation: used.filter(row => CONVERSATION_ROWS.has(row.name)).reduce((sum, row) => sum + row.tokens, 0),
        servers: [...serverTokens.entries()]
          .map(([name, tokens]) => ({ name, tokens }))
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, 5),
        memory: [...((breakdown.memoryFiles as typeof breakdown.memoryFiles | undefined) ?? [])]
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, 5)
          .map(file => ({ path: homeShort(file.path), tokens: file.tokens })),
      }
  const next: Ctx = {
    tokens: usage.context.tokens ?? 0,
    window: usage.context.window,
    percent: usage.context.percent ?? 0,
    limits: usage.rateLimits.map(limit => ({
      kind: limit.kind, percent: limit.percentUsed, resetsAt: limit.resetsAt ?? '',
    })),
    usd: usage.cost?.usd ?? 0,
    ...detail,
  }
  if (!same(previous, next)) await update($, ctx, () => next)
}

export async function refreshConnectors($: EngineInterface) {
  const tools = await $.tool.list()
  const byServer = new Map<string, number>()
  for (const tool of tools) {
    if (!tool.mcp) continue
    const server = tool.name.split('__')[1] ?? tool.name
    byServer.set(server, (byServer.get(server) ?? 0) + 1)
  }
  const next: Connector[] = [...byServer.entries()]
    .map(([name, count]) => ({ name: name.replace(/^claude_ai_/, 'claude.ai ').replace(/_/g, ' '), tools: count }))
    .sort((a, b) => a.name.localeCompare(b.name))
  if (!same(await read($, connectors), next)) await update($, connectors, () => next)
}

export async function refreshAll($: EngineInterface) {
  await Promise.all([
    refreshEnv($).catch(() => {}),
    refreshCtx($, true).catch(() => {}),
    refreshConnectors($).catch(() => {}),
  ])
}

/**
 * Every 5 s: the context; every 15 s, or soon after an edit: git; every
 * minute: the connectors. While no surface shows the pane, only the free
 * reading of the context runs, and git waits until it is seen again.
 */
export async function tickInfo($: EngineInterface) {
  beat += 1
  const isSeen = await isPaneSeen($)
  await refreshCtx($, isSeen && beat % 6 === 0).catch(() => {})
  if (!isSeen) {
    isChangesStale = true
    return
  }
  if (isChangesStale || beat % 3 === 0) await refreshEnv($).catch(() => {})
  if (beat % 12 === 0) await refreshConnectors($).catch(() => {})
}

async function addEvent($: EngineInterface, event: CtxEvent) {
  await update($, events, list => [...list, event].slice(-MAX_EVENTS))
}

async function eventNow($: EngineInterface) {
  return {
  at: await $.clock.now(),
  turn: await $.session.turns().catch(() => 0),
}
}

/** One reading of the context, when it changed since the last. */
async function takeReading($: EngineInterface, cause: Cause, withBreakdown: boolean) {
  const usage = await $.session.usage()
  const total = usage.context.tokens ?? 0
  const list = await read($, samples)
  const last = list[list.length - 1]
  const isAfterCompact = isCompactNoted
  if (total === 0 || (last !== undefined && last.total === total && !isAfterCompact)) return

  const at = await $.clock.now()
  if (withBreakdown || lastParts.length === 0 || at - lastBreakdownAt >= BREAKDOWN_EVERY_MS) {
    const detailed = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)
    const rows = detailed?.context.breakdown?.categories
    if (rows !== undefined) {
      lastParts = usedRows(rows)
      lastBreakdownAt = at
    }
  }
  const turn = await $.session.turns().catch(() => 0)
  const n = (last?.n ?? 0) + 1
  const reading: Sample = { n, at, turn, total, window: usage.context.window, parts: lastParts }
  await update($, samples, all => [...all, reading].slice(-MAX_SAMPLES))

  if (isAfterCompact) {
    // The first reading after a compaction carries its mark, however much it took back.
    isCompactNoted = false
    await update($, events, all => {
      const i = all.findLastIndex(ev => ev.kind === 'compact' && ev.n === undefined)
      return i === -1 ? all : all.map((ev, j) => (j === i ? { ...ev, n } : ev))
    })
    return
  }
  if (last === undefined) return
  const change = total - last.total
  if (change < -Math.max(5_000, last.total * 0.3)) {
    // Not a compaction this mod heard of: most likely old tool results cleared, or a /clear.
    await addEvent($, { at, turn, kind: 'drop', tokens: change, label: '', n })
  } else if (change > Math.max(20_000, usage.context.window * 0.04)) {
    await addEvent($, {
      at, turn, kind: 'jump', tokens: change, n,
      // Empty when no call came before it: the person's prompt, or the reply.
      label: cause.label,
      source: cause.source,
      size: cause.size,
    })
  }
}

/**
 * Takes a reading, naming `cause` as what any jump came from. One that comes
 * while another runs is not dropped: it runs once that one is done.
 */
/** What a reading's growth came from: the main conversation's last finished call. */
type Cause = { label: string; source: string; size: number }
const lastCause = (): Cause => ({ label: lastTool, source: lastToolSource, size: lastToolSize })

export async function sample($: EngineInterface, cause: Cause, withBreakdown = false) {
  if (isSampling) {
    isSamplePending = true
    pendingCause = cause
    // A detailed reading asked for while one ran stays detailed.
    isPendingDetailed ||= withBreakdown
    return
  }
  isSampling = true
  try {
    await takeReading($, cause, withBreakdown)
  } finally {
    isSampling = false
  }
  if (isSamplePending) {
    isSamplePending = false
    const isDetailed = isPendingDetailed
    isPendingDetailed = false
    void sample($, pendingCause, isDetailed).catch(() => {})
  }
}

/** Before a main-conversation tool call: the request that made it is back, so read the context. */
export function beforeToolCall($: EngineInterface, agentId: string | undefined) {
  if (agentId === undefined) void sample($, lastCause()).catch(() => {})
}

async function addOutput($: EngineInterface, output: Omit<Output, 'at'>) {
  const at = await $.clock.now()
  await update($, outputs, list =>
    [...list.filter(one => one.key !== output.key), { ...output, at }].slice(-MAX_OUTPUTS),
  )
}

/** After a tool call: what it made, whether it touched the tree, and what the next growth came from. */
export async function afterToolCall(
  $: EngineInterface,
  e: { tool: string; agentId?: string },
  ran: { deny?: unknown; isError?: boolean; text?: string } | undefined,
) {
  const input = e as unknown as Record<string, unknown>
  const path = typeof input.file_path === 'string' ? input.file_path : ''
  if (e.agentId === undefined) {
    // Named as the log names it: the tool, and the argument that says what it was for.
    lastTool = clip(describeCall(e), 48)
    lastToolSource = sourceOf(e.tool)
    // About four characters a token.
    lastToolSize = Math.round((typeof ran?.text === 'string' ? ran.text.length : 0) / 4)
  }
  if (ran === undefined || ran.deny !== undefined || ran.isError === true) return

  const text = typeof ran.text === 'string' ? ran.text : ''
  if (EDITING_TOOLS.has(e.tool)) isChangesStale = true
  if (e.tool === 'Write' && path !== '') {
    // A file the session made for its own work (a scratch script, a temp file) is not an output.
    const root = await $.session.root().catch(() => '')
    if (root === '' || path.startsWith(`${root.replace(/\/$/, '')}/`)) {
      await addOutput($, { key: `file:${path}`, kind: 'file', label: homeShort(path) })
    }
  }
  if (e.tool === 'Artifact') {
    const url = text.match(ARTIFACT_URL)?.[0]
    if (url !== undefined || path !== '') {
      await addOutput($, {
        key: `artifact:${url ?? path}`, kind: 'artifact', label: path === '' ? (url ?? '') : baseName(path),
      })
    }
  }
  if (e.tool === 'Bash' && typeof input.command === 'string' && /\bgh\s+pr\s+create\b/.test(input.command)) {
    for (const url of text.match(PR_URL) ?? []) {
      const [, repo = '', number = ''] = url.match(/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/) ?? []
      await addOutput($, { key: `pr:${url}`, kind: 'pr', label: `${repo} #${number}` })
    }
  }
}

const shortModel = (model: string): string =>
  model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2')

/** The end of a main-conversation turn: refresh, read, and note a change of model. */
export async function onTurnEnd($: EngineInterface, model: string) {
  void refreshCtx($, true).catch(() => {})
  await sample($, lastCause(), true)
  // A new turn's growth starts with the person's prompt, not a tool.
  lastTool = ''
  lastToolSource = ''
  lastToolSize = 0
  if (model !== '' && lastModel !== '' && model !== lastModel) {
    await addEvent($, { ...(await eventNow($)), kind: 'model', tokens: 0, label: `${shortModel(lastModel)} → ${shortModel(model)}` })
  }
  if (model !== '') lastModel = model
}

export async function onCompacted($: EngineInterface, trigger: string, before?: number, after?: number) {
  isCompactNoted = true
  await addEvent($, {
    ...(await eventNow($)),
    kind: 'compact',
    tokens: before !== undefined && after !== undefined ? after - before : 0,
    trigger: trigger === 'auto' || trigger === 'plugin' ? trigger : 'manual',
    label: before !== undefined && after !== undefined ? `${shortTokens(before)} → ${shortTokens(after)}` : '',
  })
}

export async function onSkillLoaded($: EngineInterface, skill: string, text: string) {
  // About four characters a token: an estimate, shown as one.
  await addEvent($, { ...(await eventNow($)), kind: 'skill', tokens: Math.round(text.length / 4), label: skill })
}

export type Cell = { glyph: string; color: string }
export const EMPTY: Cell = { glyph: ' ', color: 'subtle' }

/** Eighths of a cell for a value: never none for a value that is not zero. */
const unitsOf = (value: number, scale: number): number =>
  value === 0 ? 0 : Math.max(1, Math.round(Math.abs(value) * scale))

/** One bar of the total view, bottom cell first: each cell takes the part that fills most of it. */
export const stackColumn = (reading: Sample, scale: number): Cell[] => {
  const units = unitsOf(reading.total, scale)
  const estimated = reading.parts.reduce((sum, part) => sum + part.tokens, 0)
  // The parts are estimates: spread them over the counted total.
  const bounds: { color: string; to: number }[] = []
  let reach = 0
  for (const part of reading.parts) {
    reach += estimated > 0 ? (part.tokens / estimated) * units : 0
    bounds.push({ color: part.color, to: reach })
  }
  const cells: Cell[] = []
  for (let row = 0; row < CHART_ROWS; row++) {
    const low = row * 8
    const filled = Math.max(0, Math.min(8, units - low))
    if (filled === 0) {
      cells.push(EMPTY)
      continue
    }
    let color = 'suggestion'
    let most = -1
    let from = 0
    for (const bound of bounds) {
      const overlap = Math.min(bound.to, low + filled) - Math.max(from, low)
      if (overlap > most) {
        most = overlap
        color = bound.color
      }
      from = bound.to
    }
    cells.push({ glyph: BLOCKS[filled] ?? '█', color })
  }
  return cells
}

/** One bar of the change view, bottom cell first: growth rises above the middle, a drop falls below. */
export const deltaColumn = (change: number, scale: number): Cell[] => {
  const half = CHART_ROWS / 2
  const units = unitsOf(change, scale)
  const cells: Cell[] = []
  for (let row = 0; row < CHART_ROWS; row++) {
    if (row >= half) {
      const filled = change > 0 ? Math.max(0, Math.min(8, units - (row - half) * 8)) : 0
      cells.push(filled === 0 ? EMPTY : { glyph: BLOCKS[filled] ?? '█', color: 'suggestion' })
    } else {
      // Below the middle the bar hangs from the top of each cell: only eighths that start there exist.
      const filled = change < 0 ? Math.max(0, Math.min(8, units - (half - 1 - row) * 8)) : 0
      cells.push(filled === 0 ? EMPTY : { glyph: filled >= 8 ? '█' : filled >= 4 ? '▀' : '▔', color: 'success' })
    }
  }
  return cells
}
