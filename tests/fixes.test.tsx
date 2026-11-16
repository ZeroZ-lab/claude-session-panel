import { expect, test } from 'claude-code/testing'

import { command, done, PANE, spawn, world } from './helpers'

type Ui = { find: (q: { type: 'Text'; text: RegExp }) => Promise<{ text?: string } | undefined> }

const has = async (ui: Ui, re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text ?? '<missing>'

const SEEN = [{ id: 'session-panel', title: '会话', isShown: true, isFocused: false, isPlaced: true }]

test('started in a subfolder, this session\'s changes are still told apart', async ($, on) => {
  const { settle, place, written } = world(on)
  place.root = '/Users/someone/work/app/hooks'
  // git names it from the repository's top: hooks/register.tsx.
  written.paths = ['/Users/someone/work/app/hooks/register.tsx']
  await $.command.run(command('panel', '概览'))
  await settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /本次 1 项/)).toMatch(/本次 1 项/)
  await ui.unmount()
})

test('a run without a person (-p, the SDK) opens no pane and starts no timers', async ($, on) => {
  const { clock, seen, runs } = world(on)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await clock.advance(60_000)
  expect(seen.opens).toBe(0)
  expect(runs.length).toBe(0)
})

test('git waits while no surface shows the pane, and runs again once it is seen', async ($, on) => {
  const { clock, panes, runs } = world(on)
  const statusRuns = () => runs.filter(argv => argv.includes('status')).length
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(1_000)
  const atStart = statusRuns()

  await clock.advance(60_000)
  expect(statusRuns()).toBe(atStart)

  panes.list = [...SEEN]
  await clock.advance(6_000)
  expect(statusRuns()).toBeGreaterThan(atStart)
})

test('a teammate the roster calls idle has landed', async ($, on) => {
  const { clock, roster } = world(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('panel', '编队'))
  await $.agent.spawn(spawn('review'))
  roster.push({ id: 'a1', status: 'idle', type: 'Explore', description: 'review' })
  await clock.advance(6_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /^1 完成$/)).toBe('1 完成')
  await ui.unmount()
})

test('a subagent woken again is timed from its new run', async ($, on) => {
  const { clock, settle } = world(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.command.run(command('panel', '编队'))
  await $.agent.spawn(spawn('review'))
  await clock.advance(30_000)
  await $.turn.complete(done('a1'))
  await settle()

  await clock.advance(10 * 60_000)
  await $.turn.start({ text: 'one more thing', turnId: 't2', agentId: 'a1' })
  await clock.advance(3_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /^0:0[34]$/)).toMatch(/^0:0[34]$/)
  await ui.unmount()
})
