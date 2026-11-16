import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Entry, Ship, ShipStatus } from '../types'
import { clip } from './text'

// The formation: every running subagent is a ship that takes off at
// `agent.spawn`, reports each tool call and lands at its `turn.complete`.
// And the call log: the session's recent tool calls and skills.

export const ships = atom({ plugin: 'session-panel', key: 'ships' } as const, [], { shape: 'ships-2' })
export const log = atom({ plugin: 'session-panel', key: 'log' } as const, [], { shape: 'log-4' })
export const totals = atom({ plugin: 'session-panel', key: 'totals' } as const, { tools: 0, skills: 0 }, { shape: 'totals-1' })
export const tick = atom({ plugin: 'session-panel', key: 'tick' } as const, 0)

export const CALLSIGNS = [
  'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot',
  'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima',
] as const
// Each ship's own color, by theme key so it follows the person's theme. None
// of them means anything else in the pane: not green, amber or red (landed,
// close, lost), nor the blue a running call and a skill are drawn in.
export const COLORS = ['merged', 'planMode', 'ide', 'permission', 'remember', 'autoAccept'] as const
export const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

const MAX_SHIPS = 12
const MAX_LOG = 60
const LINGER_MS = 12_000 // how long a formation that is all down stays
const MISSING_MS = 15_000 // a ship the roster stopped listing is down after this long
const STALE_CALL_MS = 10 * 60_000 // a call still running after this long never reported its end

export const DEMO = [
  { type: 'Explore', task: '搜索状态栏相关实现', ms: 9_000, status: 'landed' },
  { type: 'Plan', task: '设计编队面板的布局', ms: 15_000, status: 'landed' },
  { type: 'general-purpose', task: '核对 API 字段与文档', ms: 12_000, status: 'lost' },
  { type: 'code-reviewer', task: '审查改动并找潜在问题', ms: 19_000, status: 'landed' },
  { type: 'Explore', task: '统计各模块的测试覆盖', ms: 23_000, status: 'landed' },
] as const
const DEMO_ACTS = [
  'Grep statusLine', 'Read register.tsx', 'Bash git log --oneline',
  'Glob **/*.d.ts', 'Read reference.md', 'Grep AbovePrompt',
] as const

// Ends heard before the ship was listed (a subagent done at once), by id.
const early = new Map<string, ShipStatus>()
// When the roster first left a flying ship out, by id.
const missingSince = new Map<string, number>()
let beat = 0
let skillCount = 0

export const callOf = (seq: number): string => CALLSIGNS[seq % CALLSIGNS.length] ?? 'Ship'
export const tintOf = (seq: number): string => COLORS[seq % COLORS.length] ?? 'merged'

/** One short line for a tool call: the tool and the argument that names it. */
export const describeCall = (e: { tool: string }): string => {
  const input = e as unknown as Record<string, unknown>
  // An MCP tool goes by its own name: its server is the entry's source.
  const tool = e.tool.startsWith('mcp__') ? (e.tool.split('__')[2] ?? e.tool) : e.tool
  for (const key of ['file_path', 'pattern', 'command', 'query', 'url', 'description', 'skill', 'prompt']) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') {
      const short = key === 'file_path' ? (value.split('/').pop() ?? value) : value
      return clip(`${tool} ${short}`, 120)
    }
  }
  return tool
}

/** What a second does to the formation; the same list when nothing changed. */
const advance = (list: readonly Ship[], now: number): readonly Ship[] => {
  if (list.length === 0) return list
  let changed = false
  const next = list.map(ship => {
    if (ship.demoMs === 0 || ship.status !== 'flying') return ship
    changed = true
    const age = Math.max(0, now - ship.startedAt)
    const script = DEMO[Number(ship.id.slice(5)) % DEMO.length]
    if (age >= ship.demoMs) {
      return { ...ship, status: script?.status ?? 'landed', endedAt: now }
    }
    const tools = Math.floor(age / 1400)
    const isWaiting = ship.id === 'demo-1' && age > 4_000 && age < 9_000
    return { ...ship, tools, isWaiting, tokens: tools * 3_200, last: DEMO_ACTS[(tools + ship.seq) % DEMO_ACTS.length] ?? '' }
  })
  const isAllDown = next.every(ship => ship.status !== 'flying')
  const lastDown = Math.max(...next.map(ship => ship.endedAt))
  if (isAllDown && now - lastDown > LINGER_MS) return []
  return changed ? next : list
}

/**
 * Puts a ship in the air. `isFresh` says this run is a new one (a loop that
 * runs again), so an end heard for an earlier run is not applied to it.
 */
export async function takeOff(
  $: EngineInterface,
  one: { id: string; type: string; task: string; demoMs?: number },
  isFresh = false,
) {
  const now = await $.clock.now()
  const ended = isFresh ? undefined : early.get(one.id)
  early.delete(one.id)
  missingSince.delete(one.id)
  await update($, ships, list => {
    if (list.some(ship => ship.id === one.id)) {
      return list.map(ship =>
        // A new run: its clock, calls and tokens start again.
        ship.id === one.id
          ? { ...ship, status: 'flying' as const, startedAt: now, endedAt: 0, isWaiting: false, tools: 0, tokens: 0, last: '' }
          : ship,
      )
    }
    // Ships down a while make room; one that just landed or was lost stays to be seen.
    const base = list.filter(ship => ship.status === 'flying' || now - ship.endedAt <= LINGER_MS)
    // The lowest free number, so no two ships in the air share a callsign.
    const taken = new Set(base.map(ship => ship.seq))
    let seq = 0
    while (taken.has(seq)) seq += 1
    const ship: Ship = {
      id: one.id, seq, type: one.type, task: one.task,
      status: ended ?? 'flying', startedAt: now, endedAt: ended === undefined ? 0 : now,
      tools: 0, last: '', demoMs: one.demoMs ?? 0, tokens: 0, isWaiting: false,
    }
    // Over the cap, the ships that are down go first, oldest first.
    let fleet = [...base, ship]
    while (fleet.length > MAX_SHIPS) {
      const down = fleet.findIndex(s => s.status !== 'flying')
      fleet = fleet.filter((_, i) => i !== (down === -1 ? 0 : down))
    }
    return fleet
  })
}

export async function touchDown($: EngineInterface, id: string, status: ShipStatus) {
  const now = await $.clock.now()
  let isKnown = false
  missingSince.delete(id)
  await update($, ships, list => {
    isKnown = list.some(ship => ship.id === id)
    return list.map(ship =>
      ship.id === id && ship.status === 'flying' ? { ...ship, status, endedAt: now, isWaiting: false } : ship,
    )
  })
  if (!isKnown) {
    early.set(id, status)
    if (early.size > 50) early.delete(early.keys().next().value ?? id)
  }
}

/** Each second: the demo moves, a formation long down goes, the frame turns, the roster is checked. */
export async function step($: EngineInterface) {
  const list = await read($, ships)
  const now = await $.clock.now()
  if (list.length > 0 && advance(list, now) !== list) {
    // Applied to the list as it stands at the write, never to the one read above.
    await update($, ships, current => [...advance(current, now)])
  }
  const flying = list.filter(ship => ship.status === 'flying')
  const entries = await read($, log)
  // A call whose end never came (a reload while it ran) does not spin for ever.
  if (entries.some(entry => entry.status === 'running' && now - entry.startedAt > STALE_CALL_MS)) {
    await update($, log, all => all.map(entry =>
      entry.status === 'running' && now - entry.startedAt > STALE_CALL_MS
        ? { ...entry, status: 'failed' as const, error: '没有收到结束' }
        : entry))
  }
  const isRunning = entries.some(entry => entry.status === 'running' && now - entry.startedAt <= STALE_CALL_MS)
  if (flying.length > 0 || isRunning) await update($, tick, n => (n + 1) % 3600)
  if (flying.length === 0) return

  // Every few seconds, land a ship whose end this mod did not hear.
  beat += 1
  if (beat % 5 !== 0 || flying.every(ship => ship.demoMs > 0)) return
  const agents = await $.agent.list()
  for (const ship of flying) {
    if (ship.demoMs > 0) continue
    const agent = agents.find(one => one.id === ship.id)
    if (agent === undefined) {
      // Counted from when the roster first left it out, not from take-off.
      const since = missingSince.get(ship.id) ?? now
      missingSince.set(ship.id, since)
      if (now - since > MISSING_MS) await touchDown($, ship.id, 'landed')
      continue
    }
    missingSince.delete(ship.id)
    // Waiting on someone (an approval, a question) is what the person most needs to see.
    const isWaiting = agent.status === 'waiting'
    if (isWaiting !== ship.isWaiting) {
      await update($, ships, list => list.map(one => (one.id === ship.id ? { ...one, isWaiting } : one)))
    }
    // Idle is between turns: a teammate in a pane of its own never ends its turn here.
    if (agent.status === 'completed' || agent.status === 'idle') await touchDown($, ship.id, 'landed')
    else if (agent.status === 'failed' || agent.status === 'killed') await touchDown($, ship.id, 'lost')
  }
}

/** The ship a call came from, as the log shows it then. */
export async function shipOf($: EngineInterface, agentId: string | undefined) {
  if (agentId === undefined) return { seq: -1, who: '' }
  const ship = (await read($, ships)).find(one => one.id === agentId)
  return ship === undefined ? { seq: -1, who: '' } : { seq: ship.seq, who: callOf(ship.seq) }
}

export async function addEntry($: EngineInterface, entry: Entry) {
  await update($, log, list => [...list, entry].slice(-MAX_LOG))
  await update($, totals, t =>
    entry.kind === 'skill' ? { ...t, skills: t.skills + 1 } : { ...t, tools: t.tools + 1 },
  )
}

export async function finishEntry($: EngineInterface, id: string, status: 'ok' | 'failed', error = '') {
  const reason = clip(error.split('\n').find(line => line.trim() !== '')?.trim() ?? '', 160)
  await update($, log, list => list.map(entry => (entry.id === id ? { ...entry, status, error: reason } : entry)))
}

export async function logSkill($: EngineInterface, skill: string, agentId: string | undefined) {
  skillCount += 1
  const at = await $.clock.now()
  const owner = await shipOf($, agentId)
  await addEntry($, { id: `skill-${skillCount}-${at}`, kind: 'skill', label: skill, ...owner, status: 'ok', error: '', source: 'skill', startedAt: at })
}

/** A ship's tool call: one more on its count, and its latest line. */
export async function noteShipCall($: EngineInterface, agentId: string, label: string) {
  await update($, ships, list =>
    list.some(ship => ship.id === agentId)
      ? list.map(ship => (ship.id === agentId ? { ...ship, tools: ship.tools + 1, last: label } : ship))
      : list,
  )
}

/** A turn of a ship's ended: what it spent joins its count. */
export async function noteShipUsage($: EngineInterface, agentId: string, tokens: number) {
  if (tokens <= 0) return
  await update($, ships, list =>
    list.map(ship => (ship.id === agentId ? { ...ship, tokens: ship.tokens + tokens } : ship)),
  )
}

export async function launchDemo($: EngineInterface) {
  await update($, ships, list => list.filter(ship => ship.demoMs === 0))
  for (const [i, script] of DEMO.entries()) {
    await takeOff($, { id: `demo-${i}`, type: script.type, task: script.task, demoMs: script.ms }, true)
  }
}

/** Clears what is over: ships still in the air and calls still running stay, and so does their count. */
export async function clearFleet($: EngineInterface) {
  await update($, ships, list => list.filter(ship => ship.status === 'flying' && ship.demoMs === 0))
  let tools = 0
  await update($, log, list => {
    const kept = list.filter(entry => entry.status === 'running')
    tools = kept.filter(entry => entry.kind === 'tool').length
    return kept
  })
  await update($, totals, () => ({ tools, skills: 0 }))
}
