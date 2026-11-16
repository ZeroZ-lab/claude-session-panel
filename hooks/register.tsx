import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { CtxEvent, Entry, Page, Ship } from '../types'
import {
  addEntry, callOf, clearFleet, describeCall, finishEntry, launchDemo, logSkill, NO_END,
  noteShipCall, noteShipUsage, shipOf, SPIN, step, takeOff, tintOf, touchDown,
} from './fleet'
import {
  afterToolCall, beforeToolCall, CHART_ROWS, deltaColumn, EMPTY, EVENT_LOOK,
  onCompacted, onSkillLoaded, onTurnEnd, refreshAll, sourceOf, stackColumn, STATUS_COLORS, tickInfo,
} from './info'
import type { Cell } from './info'
import { chooseLang, LANG_WORDS, restoreLang, WORDS } from './i18n'
import { PANE, paneArgs, restoreDismissal, setDismissed, showPane } from './pane'
import { baseName, clockText, dirName, homeShort, levelColor, shortTokens } from './text'

// Session panel: one pane beside the chat, three pages under a segmented
// control. The overview, the session at a glance (the desktop app's overview,
// and a trend of the context). The formation, the running subagents. The log,
// the recent tool calls and skills. Its words are in `i18n.ts`, in Chinese and
// in English.
//
// The look is a grouped list: a large title, a quiet caption over each card,
// labels in the primary text and values in the secondary, and color kept
// for meaning (green fine, amber close, red over).

const PAGES: readonly { page: Page; hotkey: string }[] = [
  { page: 'overview', hotkey: '1' },
  { page: 'fleet', hotkey: '2' },
  { page: 'log', hotkey: '3' },
]
// What `/panel` takes: a page, or what the formation's demo and clean-up were.
const PAGE_WORDS: Record<string, Page> = {
  'overview': 'overview', '概览': 'overview',
  'fleet': 'fleet', 'formation': 'fleet', '编队': 'fleet',
  'log': 'log', '记录': 'log',
}

// The state this module reads and writes. Each file that touches a value
// declares its reference itself, with the same key, initial value and shape:
// a shape changed in one file and not here reads as the initial value, which
// the tests catch, since every page is drawn there from values other files wrote.
const page = atom({ plugin: 'session-panel', key: 'page' } as const, 'overview')
const lang = atom({ plugin: 'session-panel', key: 'lang' } as const, 'zh')
const isDismissed = atom({ plugin: 'session-panel', key: 'isDismissed' } as const, false)
const isAsked = atom({ plugin: 'session-panel', key: 'isAsked' } as const, false)
const ships = atom({ plugin: 'session-panel', key: 'ships' } as const, [], { shape: 'ships-2' })
const log = atom({ plugin: 'session-panel', key: 'log' } as const, [], { shape: 'log-4' })
const totals = atom({ plugin: 'session-panel', key: 'totals' } as const, { tools: 0, skills: 0 }, { shape: 'totals-1' })
const tick = atom({ plugin: 'session-panel', key: 'tick' } as const, 0)
const env = atom({ plugin: 'session-panel', key: 'env' } as const, null, { shape: 'env-1' })
const ctx = atom({ plugin: 'session-panel', key: 'ctx' } as const, null, { shape: 'ctx-2' })
const connectors = atom({ plugin: 'session-panel', key: 'connectors' } as const, [], { shape: 'connectors-1' })
const outputs = atom({ plugin: 'session-panel', key: 'outputs' } as const, [], { shape: 'outputs-1' })
const changes = atom(
  { plugin: 'session-panel', key: 'changes' } as const,
  { isRepo: false, count: 0, sessionCount: 0, added: 0, removed: 0, files: [] },
  { shape: 'changes-2' },
)
const samples = atom({ plugin: 'session-panel', key: 'samples' } as const, [], { shape: 'samples-1' })
const events = atom({ plugin: 'session-panel', key: 'events' } as const, [], { shape: 'events-2' })
const trendMode = atom({ plugin: 'session-panel', key: 'trendMode' } as const, 'total')
const trendGrain = atom({ plugin: 'session-panel', key: 'trendGrain' } as const, 'step')
const isCtxOpen = atom({ plugin: 'session-panel', key: 'isCtxOpen' } as const, false)
const logFilter = atom({ plugin: 'session-panel', key: 'logFilter' } as const, 'all')

const LOG_FILTERS = [
  { value: 'all', hotkey: 'a' },
  { value: 'failed', hotkey: 'x' },
  { value: 'skill', hotkey: 's' },
  { value: 'mcp', hotkey: 'm' },
] as const

let hasTimers = false

/** Asked for by the person: the pane is theirs again, at any width, on the page they named. */
async function openOn($: EngineInterface, to: Page | undefined) {
  await setDismissed($, false)
  await update($, isAsked, () => true)
  if (to !== undefined) await update($, page, () => to)
  await $.ui.open(await paneArgs($)).catch(() => {})
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      // First, so the command and the pane's title are in the person's language.
      const words = WORDS[await restoreLang($).catch(() => 'en' as const)]
      await $.command.register({
        name: 'panel',
        description: words.commandDescription,
        argumentHint: '[overview|fleet|log|demo|clear|zh|en|auto]',
      })
      await restoreDismissal($)
      // A `-p` run or the SDK: nobody looks at a pane, so nothing is drawn or kept up.
      if (!e.isInteractive) return next(e)
      if (!hasTimers) {
        hasTimers = true
        $.clock.every(1000, () => {
          void step($).catch(() => {})
        })
        $.clock.every(5000, () => {
          void tickInfo($).catch(() => {})
        })
      }
      void refreshAll($)
      void showPane($)
    } catch {
      // The session starts whether or not this mod set itself up.
    }

    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await update($, isAsked, () => false)
      if (e.origin.kind === 'person') await setDismissed($, true)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'panel' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const choice = LANG_WORDS[arg]
    if (choice !== undefined) {
      const said = WORDS[await chooseLang($, choice)].said.lang
      // Opened again: the pane's title is in that language too.
      await openOn($, undefined)
      return { text: said }
    }
    const said = WORDS[await read($, lang)].said
    if (arg === 'demo') {
      await openOn($, 'fleet')
      await launchDemo($)
      return { text: said.demo }
    }
    if (arg === 'clear') {
      await openOn($, 'fleet')
      await clearFleet($)
      return { text: said.cleared }
    }
    await openOn($, PAGE_WORDS[arg])
    void refreshAll($)
    return { text: said.opened }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started?.deny === undefined && started?.agentId !== undefined) {
      // Awaited, so the ship is listed before its first tool call is logged.
      await takeOff($, { id: started.agentId, type: e.subagentType, task: e.description }).catch(() => {})
    }

    return started
  })

  on('turn.start', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      // Not awaited: the turn does not wait on the pane.
      void (async () => {
        const known = (await read($, ships)).find(ship => ship.id === id)
        if (known === undefined) {
          // Spawned where no `agent.spawn` hook heard it: ask the roster.
          const info = (await $.agent.list()).find(agent => agent.id === id)
          if (info !== undefined) await takeOff($, { id, type: info.type, task: info.description })
        } else if (known.status !== 'flying') {
          // Its loop runs again: a new run, which no earlier end applies to.
          await takeOff($, { id, type: known.type, task: known.task }, true)
        }
      })().catch(() => {})
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('skill.prompt', async ($, e, next) => {
    const loaded = await next(e)
    const agentId = (e as { agentId?: string }).agentId
    void logSkill($, e.skill, agentId).catch(() => {})
    void onSkillLoaded($, e.skill, loaded.text).catch(() => {})

    return loaded
  })

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    const label = describeCall(e)
    // A skill is logged once, by `skill.prompt`, however it was started.
    const isLogged = e.tool !== 'Skill' && typeof id === 'string'
    beforeToolCall($, e.agentId)
    // Written beside the call, not before it: the call never waits on the pane.
    // Its end is written after its start, whichever comes back first.
    const logged = (async () => {
      if (isLogged) {
        const owner = await shipOf($, e.agentId)
        const startedAt = await $.clock.now()
        await addEntry($, { id, kind: 'tool', label, ...owner, status: 'running', error: '', source: sourceOf(e.tool), startedAt })
      }
      if (e.agentId !== undefined) await noteShipCall($, e.agentId, label)
    })().catch(() => {
      // The panel is a view: the call goes on without it.
    })
    const finish = (status: 'ok' | 'failed', reason: string) => {
      if (isLogged) void logged.then(() => finishEntry($, id, status, reason)).catch(() => {})
    }

    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } catch (error) {
      // A call that threw is over too: never left running in the log.
      finish('failed', error instanceof Error ? error.message : String(error))
      throw error
    }
    const isFailed = ran?.deny !== undefined || ran?.isError === true
    const reason = ran?.deny !== undefined ? String(ran.deny) : ran?.isError === true ? (ran.text ?? '') : ''
    finish(isFailed ? 'failed' : 'ok', reason)
    void afterToolCall($, e, ran).catch(() => {})

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined) {
      const isOk = e.reason === 'answer' && !e.isAborted
      const usage = e.usage
      const spent = usage === undefined ? 0
        : usage.input_tokens + usage.output_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
      // In order, and beside the turn's end rather than before it.
      void noteShipUsage($, id, spent)
        .then(() => touchDown($, id, isOk ? 'landed' : 'lost'))
        .catch(() => {})
    } else {
      void onTurnEnd($, e.usage?.model ?? '').catch(() => {})
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && done.skip === undefined) {
      void onCompacted($, e.trigger, done.tokensBefore, done.tokensAfter).catch(() => {})
    }

    return done
  })

  on('ui.render', { component: 'Pane', requestId: 'session-panel' }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    // Read together; each value read is one this drawing redraws on, so the
    // call log and its counts are read by the log page alone.
    const [shown, fleet, where, window, tree, asked, now, tongue] = await Promise.all([
      read($, page), read($, ships), read($, env), read($, ctx), read($, changes), read($, isAsked), $.clock.now(),
      read($, lang),
    ])
    const t = WORDS[tongue]

    const up = fleet.filter(ship => ship.status === 'flying').length
    const landed = fleet.filter(ship => ship.status === 'landed').length
    const lost = fleet.filter(ship => ship.status === 'lost').length
    const pct = Math.min(100, Math.max(0, window?.percent ?? 0))
    const project = where === null ? '' : baseName(where.root)
    const isDirty = tree.count > 0
    // Unasked above the prompt, or a desktop widget: a glance. Asked above the
    // prompt: the page, cut down. Any other seat is the dock.
    const isGlance = e.props.placement === 'widget' || (e.props.placement === 'inline' && !asked)
    const isCompact = e.props.placement === 'inline' && asked

    /** A ship's mark: its own color in the air, a check once home, a cross when lost. */
    const markOf = (ship: Ship) =>
      ship.isWaiting
        ? { glyph: '!', color: 'warning' }
        : ship.status === 'flying'
        ? { glyph: '◆', color: tintOf(ship.seq) }
        : ship.status === 'landed'
          ? { glyph: '✓', color: 'success' }
          : { glyph: '✕', color: 'error' }

    // One quiet line that reads at a glance.
    if (isGlance) {
      const parts = [
        where?.branch ? `${where.branch}${isDirty ? '*' : ''}` : project,
        window ? t.glanceContext(Math.round(pct)) : '',
        window ? `$${window.usd.toFixed(2)}` : '',
        isDirty ? t.glanceChanges(tree.count) : '',
        fleet.length > 0 ? t.glanceFlying(up, fleet.length) : '',
      ].filter(part => part !== '')
      return (
        <Box gap={1}>
          <Text weight="semibold">{t.title}</Text>
          {fleet.map(ship => {
            const mark = markOf(ship)
            return <Text color={mark.color}>{mark.glyph}</Text>
          })}
          <Text dimColor wrap="truncate-end">{parts.join(' · ')}</Text>
        </Box>
      )
    }

    // Only the pages that animate read the frame: the overview and the glance are not redrawn each second.
    const frame = shown === 'overview' ? 0 : await read($, tick)
    const spin = (i: number) => SPIN[(frame + i) % SPIN.length] ?? '·'

    // ---- Shared pieces ----

    /** The room inside a card: the pane's body less its padding, the round border and the card's own. */
    const inner = Math.max(10, e.props.bodyColumns - 6)
    const room = Math.max(12, e.props.scroll.bodyRows)

    /** A caption over a card, and the card: a hairline round border, one cell of air. */
    const group = (title: string, note: string, rows: RenderChildren[]) => (
      <Box flexDirection="column" marginTop={1}>
        <Box justifyContent="space-between" paddingX={1}>
          <Text dimColor size="footnote">{title}</Text>
          <Text dimColor size="footnote">{note}</Text>
        </Box>
        <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
          {rows}
        </Box>
      </Box>
    )

    /** A row of a card: the label in the primary text, the value at the right in the secondary. */
    const row = (label: string, value: string, color?: string) => (
      <Box justifyContent="space-between">
        <Box flexShrink={0} marginRight={2}>
          <Text>{label}</Text>
        </Box>
        <Box flexShrink={1}>
          <Text color={color} dimColor={color === undefined} wrap="truncate-start">{value}</Text>
        </Box>
      </Box>
    )

    const empty = (text: string) => <Text dimColor>{text}</Text>

    /** A slim meter: the used part in its color, the rest a hairline. */
    const meter = (percent: number, width: number, color: string) => {
      const filled = Math.min(width, Math.max(percent > 0 ? 1 : 0, Math.round((percent / 100) * width)))
      return (
        <Box>
          <Text color={color}>{'━'.repeat(filled)}</Text>
          <Text color="subtle">{'━'.repeat(width - filled)}</Text>
        </Box>
      )
    }

    // ---- The segmented control ----

    const segment = (one: (typeof PAGES)[number]) => {
      const isOn = one.page === shown
      return (
        <Button key={`page-${one.page}`} plain hotkey={one.hotkey} onPress={() => update($, page, () => one.page)}>
          <Text weight={isOn ? 'semibold' : 'regular'} dimColor={!isOn}>{t.pages[one.page]}</Text>
          {one.page === 'fleet' && up > 0 && <Text color="suggestion">{` ●${up}`}</Text>}
        </Button>
      )
    }
    const segments = (
      <Box flexDirection="column" marginTop={1}>
        <Box borderStyle="round" borderColor="subtle" paddingX={1} justifyContent="space-around">
          {PAGES.map((one, i) => [
            i > 0 && <Text color="subtle">│</Text>,
            segment(one),
          ])}
        </Box>
        {e.surface === 'terminal' && (
          <Box justifyContent="center">
            <Text dimColor size="caption">
              {e.props.isFocused ? t.hintFocused : t.hintUnfocused}
            </Text>
          </Box>
        )}
        {isCompact && (
          <Box justifyContent="center">
            <Text dimColor size="caption">{t.hintCompact}</Text>
          </Box>
        )}
      </Box>
    )

    // ---- The overview ----

    const overviewPage = async () => {
      const servers = await read($, connectors)
      const made = await read($, outputs)
      const readings = await read($, samples)
      const happened = await read($, events)
      const mode = await read($, trendMode)
      const grain = await read($, trendGrain)
      const isOpen = await read($, isCtxOpen)

      // How near the window is to where compaction runs (to its end when compaction is off).
      const threshold = window?.threshold ?? 0
      const toCompact = window === null || threshold === 0 ? 0 : Math.max(0, threshold - window.tokens)
      const nearness = window === null ? 0
        : threshold > 0 ? window.tokens / threshold : window.tokens / Math.max(1, window.window)
      const nearColor = nearness >= 0.9 ? 'error' : nearness >= 0.7 ? 'warning' : 'success'

      // The context bar, as a storage bar: one segment per part, then the free
      // room, then the reserve kept free for compaction, drawn apart.
      const storage = (() => {
        if (window === null || window.window === 0) return null
        const cellsOf = (tokens: number) => Math.round((tokens / window.window) * inner)
        const reserve = window.buffer > 0 ? Math.min(inner, Math.max(1, cellsOf(window.buffer))) : 0
        let used = 0
        const parts = window.categories.map(part => {
          const width = Math.max(1, cellsOf(part.tokens))
          used += width
          return { color: part.color, width }
        })
        return (
          <Box>
            {parts.map(part => <Text color={part.color}>{'━'.repeat(part.width)}</Text>)}
            <Text color="subtle">{'━'.repeat(Math.max(0, inner - used - reserve))}</Text>
            {reserve > 0 && <Text color="warning" dimColor>{'╍'.repeat(reserve)}</Text>}
          </Box>
        )
      })()

      const detailRow = (name: string, tokens: number, isPath = false) => (
        <Box justifyContent="space-between">
          <Box flexShrink={1} paddingLeft={2}>
            <Text wrap={isPath ? 'truncate-start' : 'truncate-end'}>{name}</Text>
          </Box>
          <Box flexShrink={0} marginLeft={2}>
            <Text dimColor>{shortTokens(tokens)}</Text>
          </Box>
        </Box>
      )

      const context = window === null
        ? [empty(t.reading)]
        : [
            <Box justifyContent="space-between">
              <Box gap={1}>
                <Text color={window.tokens === 0 ? undefined : nearColor} dimColor={window.tokens === 0} weight="bold" size="heading">
                  {window.tokens === 0 ? '—' : `${Math.round(pct)}%`}
                </Text>
                <Text dimColor>
                  {window.tokens === 0 ? t.beforeFirst(shortTokens(window.window)) : t.used(shortTokens(window.tokens), shortTokens(window.window))}
                </Text>
              </Box>
              {threshold > 0
                ? <Text color={nearColor}>{t.toCompact(shortTokens(toCompact))}</Text>
                : <Text dimColor>{t.compactOff}</Text>}
            </Box>,
            storage,
            <Text dimColor size="caption">{window.buffer > 0 ? t.countedByWithReserve : t.countedBy}</Text>,
            threshold > 0 && nearness >= 0.85 && (
              <Text color={nearColor}>{t.nearCompact}</Text>
            ),
            ...window.categories.map(part => (
              <Box justifyContent="space-between">
                <Box gap={1}>
                  <Text color={part.color}>●</Text>
                  <Text>{t.categories[part.name] ?? part.name}</Text>
                </Box>
                <Text dimColor>{shortTokens(part.tokens)}</Text>
              </Box>
            )),
            window.fixed + window.conversation > 0 && (
              <Box justifyContent="space-between" marginTop={1}>
                <Text dimColor>{t.fixedAndConversation(shortTokens(window.fixed), shortTokens(window.conversation))}</Text>
                <Button key="ctx-detail" label={isOpen ? t.less : t.detail} hotkey="d" plain dimColor onPress={() => update($, isCtxOpen, open => !open)} />
              </Box>
            ),
            ...(isOpen
              ? [
                  window.servers.length > 0 && <Text dimColor size="footnote">{t.serverSchemas}</Text>,
                  ...window.servers.map(server => detailRow(server.name, server.tokens)),
                  window.memory.length > 0 && <Text dimColor size="footnote">{t.memoryFiles}</Text>,
                  ...window.memory.map(file => detailRow(file.path, file.tokens, true)),
                  window.servers.length === 0 && window.memory.length === 0 && empty(t.noDetail),
                ]
              : []),
            // Plan use and cost, one group under a caption of its own.
            <Box marginTop={1}>
              <Text dimColor size="footnote">{t.limits}</Text>
            </Box>,
            ...window.limits.map(limit => (
              <Box justifyContent="space-between">
                <Text>{t.limitNames[limit.kind] ?? limit.kind}</Text>
                <Box gap={1}>
                  {meter(limit.percent, 8, levelColor(limit.percent))}
                  <Text color={levelColor(limit.percent)}>{`${Math.round(limit.percent)}%`}</Text>
                </Box>
              </Box>
            )),
            row(t.cost, `$${window.usd.toFixed(2)}`),
          ]

      // The trend: one bar per request, or per turn (its last reading), newest at the right.
      const series = grain === 'step' ? readings : readings.filter((one, i) => readings[i + 1]?.turn !== one.turn)
      const view = series.slice(-inner)
      const previousOf = (i: number) => (i > 0 ? view[i - 1] : series[series.length - view.length - 1])
      const peak = readings.reduce((max, one) => Math.max(max, one.total), 0)
      const viewPeak = view.reduce((max, one) => Math.max(max, one.total), 0)
      const changesOf = view.map((one, i) => {
        const before = previousOf(i)
        return before === undefined ? 0 : one.total - before.total
      })
      const biggest = changesOf.reduce((max, one) => Math.max(max, Math.abs(one)), 0)
      // The compaction line, drawn when it is near enough to matter: the bars then scale to it.
      const hasLine = mode === 'total' && threshold > 0 && threshold <= viewPeak * 1.5
      const top = hasLine ? Math.max(viewPeak, threshold) : viewPeak
      const scale = top > 0 ? (CHART_ROWS * 8) / top : 0
      const lineRow = hasLine ? Math.min(CHART_ROWS - 1, Math.floor((threshold * scale) / 8)) : -1
      const columns = view.map((one, i) =>
        mode === 'total'
          ? stackColumn(one, scale)
          : deltaColumn(changesOf[i] ?? 0, biggest > 0 ? ((CHART_ROWS / 2) * 8) / biggest : 0),
      )
      const padding = Math.max(0, inner - columns.length)
      const LINE: Cell = { glyph: '┄', color: 'warning' }

      /** One row of the chart, with runs of one color drawn as one Text; the compaction line fills its row's gaps. */
      const chartRow = (level: number) => {
        const isLine = level === lineRow
        const runs: Cell[] = [isLine ? { ...LINE, glyph: '┄'.repeat(padding) } : { glyph: ' '.repeat(padding), color: 'subtle' }]
        for (const column of columns) {
          const own = column[level] ?? EMPTY
          const cell = isLine && own === EMPTY ? LINE : own
          const last = runs[runs.length - 1]
          if (last !== undefined && last.color === cell.color) last.glyph += cell.glyph
          else runs.push({ ...cell })
        }
        return (
          <Box>
            {runs.filter(run => run.glyph !== '').map(run => <Text color={run.color}>{run.glyph}</Text>)}
          </Box>
        )
      }

      // Under each bar, the mark of what happened in it.
      const marks = view.map((one, i) => {
        const after = previousOf(i)?.n ?? 0
        const here = happened.find(ev => ev.n !== undefined && ev.n > after && ev.n <= one.n)
        return here === undefined ? EMPTY : { glyph: EVENT_LOOK[here.kind].glyph, color: EVENT_LOOK[here.kind].color }
      })

      // Against the end of the turn before: how much more, and which part grew most.
      const latest = readings[readings.length - 1]
      const lastTurnEnd = latest === undefined ? undefined : [...readings].reverse().find(one => one.turn < latest.turn)
      const growth = (() => {
        if (latest === undefined || lastTurnEnd === undefined) return ''
        const change = latest.total - lastTurnEnd.total
        let most = ''
        let mostBy = 0
        for (const part of latest.parts) {
          const by = part.tokens - (lastTurnEnd.parts.find(one => one.name === part.name)?.tokens ?? 0)
          if (by > mostBy) {
            mostBy = by
            most = t.categories[part.name] ?? part.name
          }
        }
        const sign = change >= 0 ? '+' : '-'
        return t.growth(`${sign}${shortTokens(Math.abs(change))}`, change > 0 ? most : '')
      })()

      /** A switch between two views: the one on in full, the other dim; its letter presses it. */
      const flip = (key: string, hotkey: string, names: readonly [string, string], isFirst: boolean, press: () => unknown) => (
        <Button key={key} hotkey={hotkey} plain onPress={press}>
          <Text dimColor={!isFirst}>{names[0]}</Text>
          <Text color="subtle">/</Text>
          <Text dimColor={isFirst}>{names[1]}</Text>
        </Button>
      )

      const sizeOf = (event: CtxEvent) =>
        event.kind === 'model' ? ''
          : event.tokens < 0 ? t.freed(shortTokens(-event.tokens))
          : event.tokens > 0 ? `${event.kind === 'skill' ? '≈' : ''}+${shortTokens(event.tokens)}`
          : ''

      /** What an event was: its own name, or the pane's words where it kept none. */
      const labelOf = (event: CtxEvent) =>
        event.kind === 'compact' ? [t.triggers[event.trigger ?? ''] ?? '', event.label].filter(Boolean).join(' · ')
          : event.label !== '' ? event.label
          : event.kind === 'drop' ? t.dropCause
          : event.kind === 'jump' ? t.jumpCause
          : ''

      const trend = readings.length < 2
        ? [empty(t.trendEmpty)]
        : [
            <Box justifyContent="space-between">
              <Text dimColor>{mode === 'total' ? t.top(shortTokens(top)) : t.maxChange(shortTokens(biggest))}</Text>
              <Box gap={2}>
                {flip('trend-mode', 't', t.modes, mode === 'total', () => update($, trendMode, m => (m === 'total' ? 'delta' : 'total')))}
                {flip('trend-grain', 'g', t.grains, grain === 'step', () => update($, trendGrain, g => (g === 'step' ? 'turn' : 'step')))}
              </Box>
            </Box>,
            ...Array.from({ length: CHART_ROWS }, (_, i) => chartRow(CHART_ROWS - 1 - i)),
            marks.some(mark => mark !== EMPTY) && (
              <Box>
                <Text>{' '.repeat(padding)}</Text>
                {marks.map(mark => <Text color={mark.color}>{mark.glyph}</Text>)}
              </Box>
            ),
            <Text dimColor wrap="truncate-end">
              {[
                grain === 'step' ? t.requests(readings.length) : t.turns(series.length),
                t.now(shortTokens(latest?.total ?? 0)),
                t.peak(shortTokens(peak)),
                hasLine ? t.compactLine : '',
              ].filter(Boolean).join(' · ')}
            </Text>,
            growth !== '' && <Text dimColor wrap="truncate-end">{growth}</Text>,
            ...(happened.length === 0
              ? []
              : [
                  <Box marginTop={1}>
                    <Text dimColor size="footnote">{t.events}</Text>
                  </Box>,
                  ...[...happened].reverse().slice(0, 3).map(event => {
                    const look = EVENT_LOOK[event.kind]
                    const note = event.kind === 'jump' && (event.size ?? 0) > 0 ? ` · ${t.resultSize(shortTokens(event.size ?? 0))}` : ''
                    return (
                      <Box justifyContent="space-between">
                        <Box gap={1} flexShrink={1}>
                          <Text color={look.color}>{look.glyph}</Text>
                          <Text>{t.eventNames[event.kind]}</Text>
                          <Text dimColor wrap="truncate-end">{labelOf(event) + note}</Text>
                          {event.source !== undefined && event.source !== '' && <Text dimColor>{event.source}</Text>}
                        </Box>
                        <Box flexShrink={0} marginLeft={2} gap={1}>
                          {sizeOf(event) !== '' && <Text color={event.tokens < 0 ? 'success' : undefined}>{sizeOf(event)}</Text>}
                          <Text dimColor>{t.turn(event.turn)}</Text>
                        </Box>
                      </Box>
                    )
                  }),
                ]),
          ]

      const shownFiles = tree.files.slice(0, isCompact ? 5 : 10)
      const changed = !tree.isRepo
        ? [empty(t.notRepo)]
        : tree.count === 0
          ? [empty(t.clean)]
          : [
              ...shownFiles.map(file => (
                <Box justifyContent="space-between">
                  <Box gap={1} flexShrink={1}>
                    <Text color={STATUS_COLORS[file.status] ?? 'warning'} weight="bold" dimColor={!file.isSession}>
                      {file.status === '?' ? 'N' : file.status}
                    </Text>
                    <Text dimColor={!file.isSession} wrap="truncate-end">{baseName(file.path) + (file.path.endsWith('/') ? '/' : '')}</Text>
                    <Text dimColor wrap="truncate-start">{dirName(file.path)}</Text>
                  </Box>
                  <Box flexShrink={0} marginLeft={2} gap={1}>
                    {file.status === '?'
                      ? null
                      : [
                          <Text color="success" dimColor={!file.isSession}>{`+${file.added}`}</Text>,
                          <Text color="error" dimColor={!file.isSession}>{`-${file.removed}`}</Text>,
                        ]}
                  </Box>
                </Box>
              )),
              tree.count > shownFiles.length && empty(t.more(tree.count - shownFiles.length)),
              tree.sessionCount < tree.count && (
                <Box marginTop={1}>
                  <Text dimColor size="caption">{t.grayNote}</Text>
                </Box>
              ),
            ]
      const changesNote = !isDirty ? ''
        : tree.sessionCount === tree.count ? t.changesAllSession(tree.count, tree.added, tree.removed)
        : tree.sessionCount === 0 ? t.changesAllBefore(tree.count)
        : t.changesMixed(tree.sessionCount, tree.count - tree.sessionCount)

      const produced = made.length === 0
        ? [empty(t.noOutputs)]
        : [...made].reverse().slice(0, 8).map(output => (
            <Box justifyContent="space-between">
              <Box flexShrink={1}>
                <Text wrap="truncate-start">{output.kind === 'file' ? baseName(output.label) : output.label}</Text>
              </Box>
              <Box flexShrink={0} marginLeft={2}>
                <Text dimColor>{t.outputKinds[output.kind]}</Text>
              </Box>
            </Box>
          ))

      // They rarely change: one paragraph of names, the counts in the caption.
      const connected = servers.length === 0
        ? [empty(t.noConnectors)]
        : [<Text dimColor>{servers.map(server => `${server.name} ${server.tools}`).join(' · ')}</Text>]
      const toolCount = servers.reduce((sum, server) => sum + server.tools, 0)

      const environment = where === null
        ? [empty(t.reading)]
        : [
            row(t.rows.root, homeShort(where.root)),
            where.branch !== '' &&
              row(t.rows.branch, `${where.branch}${where.ahead > 0 ? ` ↑${where.ahead}` : ''}${where.behind > 0 ? ` ↓${where.behind}` : ''}`),
            where.remote !== '' && row(t.rows.remote, where.remote),
            row(t.rows.model, where.model),
            where.version !== '' && row(t.rows.version, where.version),
          ]

      // Above the prompt the page is cut to what matters most: how full the context is, and what changed.
      if (isCompact) {
        return [
          group(t.groups.context, '', context.slice(0, 2)),
          group(t.groups.changes, changesNote, changed),
        ]
      }
      return [
        group(t.groups.context, '', context),
        group(t.groups.trend, mode === 'total' ? t.trendTotal : t.trendDelta, trend),
        group(t.groups.changes, changesNote, changed),
        group(t.groups.outputs, made.length > 0 ? t.outputCount(made.length) : '', produced),
        group(t.groups.connectors, servers.length === 0 ? '' : t.connectorCount(servers.length, toolCount), connected),
        group(t.groups.environment, '', environment),
      ]
    }

    // ---- The formation ----

    const fleetPage = () => {
      if (fleet.length === 0) {
        return [group(t.groups.subagents, '', [empty(t.fleetEmpty)])]
      }

      // Waiting on someone first, then the ones at work, then the ones down.
      const rank = (ship: Ship) => (ship.isWaiting ? 0 : ship.status === 'flying' ? 1 : 2)
      const ordered = [...fleet].sort((a, b) => rank(a) - rank(b) || a.seq - b.seq)
      const waiting = fleet.filter(ship => ship.isWaiting).length

      // How much each card says, by the room there is and how many there are.
      const header = 12 + (fleet.length >= 4 ? 3 : 0)
      const isMany = fleet.length > 8
      const lines = isCompact || isMany ? 1
        : room - header >= fleet.length * 4 ? 3 : room - header >= fleet.length * 3 ? 2 : 1
      const wedgeRows = Math.ceil((fleet.length + 1) / 2) + 1
      const shipRows = fleet.length * (lines + (lines > 1 ? 1 : 0))
      const hasWedge = !isCompact && !isMany && room - header - shipRows >= wedgeRows

      // The formation itself: the lead ship at the point, the rest in pairs behind it.
      // In the list's order, so the point is the ship listed first.
      const ranks: Ship[][] = [ordered.slice(0, 1)]
      for (let i = 1; i < ordered.length; i += 2) ranks.push(ordered.slice(i, i + 2))
      const wedge = hasWedge && (
        <Box flexDirection="column" alignItems="center" marginBottom={1}>
          {ranks.map((rankShips, depth) => (
            <Box justifyContent="center">
              {rankShips.map((ship, side) => {
                const mark = markOf(ship)
                const gap = side === 1 ? ' '.repeat(depth * 4 - 1) : ''
                return <Text color={mark.color} dimColor={ship.status !== 'flying'}>{gap + mark.glyph}</Text>
              })}
            </Box>
          ))}
        </Box>
      )

      const card = (ship: Ship, i: number, isFirst: boolean) => {
        const mark = markOf(ship)
        const isUp = ship.status === 'flying'
        const time = clockText((isUp ? now : ship.endedAt) - ship.startedAt)
        const spent = ship.tokens > 0 ? `${shortTokens(ship.tokens)} · ` : ''
        const act = ship.isWaiting ? t.waitingLong
          : isUp ? `${spin(i)} ${ship.last === '' ? t.takingOff : ship.last}`
          : t.ended(ship.status === 'landed', ship.tools)
        const actColor = ship.isWaiting ? 'warning'
          : ship.status === 'lost' ? 'error' : ship.status === 'landed' ? 'success' : undefined

        return (
          <Box flexDirection="column" marginTop={!isFirst && lines > 1 ? 1 : 0}>
            <Box justifyContent="space-between">
              <Box gap={1} flexShrink={1}>
                <Text color={mark.color}>{mark.glyph}</Text>
                <Text color={tintOf(ship.seq)} dimColor={!isUp}>{callOf(ship.seq)}</Text>
                <Text weight={isUp ? 'semibold' : 'regular'} dimColor={!isUp} wrap="truncate-end">
                  {lines === 1 && ship.isWaiting ? t.waiting : ship.task}
                </Text>
              </Box>
              <Box flexShrink={0} marginLeft={2}>
                <Text dimColor tabular>{spent + time}</Text>
              </Box>
            </Box>
            {lines >= 3 && (
              <Box paddingLeft={2}>
                <Text dimColor wrap="truncate-end">{ship.type}</Text>
              </Box>
            )}
            {lines >= 2 && (
              <Box paddingLeft={2}>
                <Text color={actColor} dimColor={actColor === undefined} wrap="truncate-end">{act}</Text>
              </Box>
            )}
          </Box>
        )
      }

      // With a few ships, one list; with more, a caption over each group.
      const sections: { name: string; ships: Ship[] }[] = fleet.length < 4
        ? [{ name: '', ships: ordered }]
        : [
            { name: t.sections.waiting, ships: ordered.filter(ship => rank(ship) === 0) },
            { name: t.sections.running, ships: ordered.filter(ship => rank(ship) === 1) },
            { name: t.sections.over, ships: ordered.filter(ship => rank(ship) === 2) },
          ].filter(section => section.ships.length > 0)
      let index = 0
      const cards = sections.flatMap(section => [
        section.name !== '' && (
          <Box marginTop={index > 0 ? 1 : 0}>
            <Text dimColor size="footnote">{`${section.name} · ${section.ships.length}`}</Text>
          </Box>
        ),
        ...section.ships.map((ship, j) => card(ship, index++, j === 0)),
      ])

      const summary = [
        waiting > 0 ? t.sumWaiting(waiting) : '',
        // The ones waiting are counted once, as waiting.
        up - waiting > 0 ? t.sumRunning(up - waiting) : '',
        landed > 0 ? t.sumLanded(landed) : '',
        lost > 0 ? t.sumLost(lost) : '',
      ].filter(Boolean).join(' · ')

      return [group(t.groups.subagents, summary, [wedge, ...cards])]
    }

    // ---- The log ----

    const logPage = async () => {
      const [filter, entries, sums] = await Promise.all([read($, logFilter), read($, log), read($, totals)])
      const kept = entries.filter(entry =>
        filter === 'all' ? true
          : filter === 'failed' ? entry.status === 'failed'
          : filter === 'skill' ? entry.kind === 'skill'
          : entry.source.startsWith('mcp:'),
      )

      // Runs of the same finished call by the same caller fold into one row: `Read ×5`.
      type Row = { entry: Entry; count: number }
      const rows: Row[] = []
      for (const entry of [...kept].reverse()) {
        const last = rows[rows.length - 1]
        const toolOf = (one: Entry) => one.label.split(' ')[0] ?? one.label
        const isFoldable = (one: Entry) => one.kind === 'tool' && one.status === 'ok'
        if (last !== undefined && isFoldable(entry) && isFoldable(last.entry)
          && toolOf(entry) === toolOf(last.entry) && entry.who === last.entry.who) {
          last.count += 1
        } else {
          rows.push({ entry, count: 1 })
        }
      }
      const shownRows = rows.slice(0, isCompact ? 6 : Math.max(5, room - 11))

      const filters = (
        <Box gap={2} marginBottom={1}>
          {LOG_FILTERS.map(one => (
            <Button
              key={`filter-${one.value}`}
              label={t.filters[one.value]}
              hotkey={one.hotkey}
              plain
              dimColor={filter !== one.value}
              onPress={() => update($, logFilter, () => one.value)}
            />
          ))}
        </Box>
      )

      const calls = shownRows.length === 0
        ? [empty(filter === 'all' ? t.noCalls : t.noMatch)]
        : shownRows.map(({ entry, count }, i) => {
            const isSkill = entry.kind === 'skill'
            const mark = isSkill
              ? { glyph: '✦', color: 'suggestion' }
              : entry.status === 'running'
                ? { glyph: spin(i), color: 'suggestion' }
                : entry.status === 'ok'
                  ? { glyph: '✓', color: 'success' }
                  : { glyph: '✕', color: 'error' }
            const isQuiet = !isSkill && entry.status === 'ok'
            const label = count > 1 ? `${entry.label.split(' ')[0] ?? entry.label} ×${count}` : entry.label
            const tag = isSkill ? t.skillTag : entry.source

            return (
              <Box flexDirection="column">
                <Box justifyContent="space-between">
                  <Box gap={1} flexShrink={1}>
                    <Text color={mark.color}>{mark.glyph}</Text>
                    <Text dimColor={isQuiet} wrap="truncate-end">{label}</Text>
                  </Box>
                  {(tag !== '' || entry.who !== '') && (
                    <Box flexShrink={0} marginLeft={2} gap={1}>
                      {entry.who !== '' && <Text color={tintOf(entry.seq)}>{entry.who}</Text>}
                      {tag !== '' && <Text dimColor>{tag}</Text>}
                    </Box>
                  )}
                </Box>
                {entry.status === 'failed' && entry.error !== '' && (
                  <Box paddingLeft={2}>
                    <Text color="error" dimColor wrap="truncate-end">{entry.error === NO_END ? t.noEnd : entry.error}</Text>
                  </Box>
                )}
              </Box>
            )
          })
      return [group(t.groups.calls, t.callTotals(sums.tools, sums.skills), [filters, ...calls])]
    }

    const body = shown === 'overview' ? await overviewPage() : shown === 'fleet' ? fleetPage() : await logPage()

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text weight="bold" size="title">{t.title}</Text>
        <Text dimColor size="footnote">
          {[project, where?.branch ? `${where.branch}${isDirty ? '*' : ''}` : ''].filter(Boolean).join(' · ') || ' '}
        </Text>
        {segments}
        {body}
      </Box>
    )
  })
}
