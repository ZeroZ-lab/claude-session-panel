import { expect, test } from 'claude-code/testing'

import { command, PANE, SUMMARY, world } from './helpers'

type Ui = { find: (q: { type: 'Text'; text: RegExp }) => Promise<{ text?: string } | undefined> }

const has = async (ui: Ui, re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text ?? '<missing>'
const lacks = async (ui: Ui, re: RegExp) => (await ui.find({ type: 'Text', text: re })) === undefined
// Any Chinese but the changed file the world's repository holds: a name, not the pane's words.
const HAN = /^(?!笔记\.md$).*[一-鿿]/

test('on an English machine every page is in English, with no Chinese left', async ($, on) => {
  // The first reading is the one the session's start takes.
  const { locale, settle } = world(on, [10_000, 10_000, 150_000, 140_000, 40_000])
  locale.lang = 'en_US.UTF-8'
  on('tool.call', () => ({ result: {}, text: '' }))
  on('session.compact', () => ({ messages: [SUMMARY], tokensBefore: 150_000, tokensAfter: 140_000 }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()

  // A compaction, then a drop: both are named in the pane's words.
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'u1' })
  await settle()
  await $.tool.call({ tool: 'Bash', command: 'ls -la', tool_use_id: 'u2' })
  await settle()
  await $.session.compact({ trigger: 'auto', messages: [SUMMARY] })
  await settle()
  await $.tool.call({ tool: 'Bash', command: 'pwd', tool_use_id: 'u3' })
  await settle()
  await $.tool.call({ tool: 'Bash', command: 'date', tool_use_id: 'u4' })
  await settle()

  for (const [arg, re] of [['overview', /^Context$/], ['fleet', /^Subagents$/], ['log', /^Calls$/]] as const) {
    expect((await $.command.run(command('panel', arg)))?.text).toBe('Session panel opened.')
    await settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await has(ui, /^Session$/)).toBe('Session')
    expect(await has(ui, re)).toMatch(re)
    expect(await lacks(ui, HAN)).toBe(true)
    await ui.unmount()
  }

  await $.command.run(command('panel', 'overview'))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /^Messages$/)).toBe('Messages')
  expect(await has(ui, /^7-day limit$/)).toBe('7-day limit')
  expect(await has(ui, /2 this session · 2 before/)).toMatch(/2 before/)
  expect(await has(ui, /2 servers · 3 tools/)).toMatch(/3 tools/)
  expect(await has(ui, /^auto · 150k → 140k$/)).toBe('auto · 150k → 140k')
  expect(await has(ui, /old tool results probably cleared/)).toMatch(/cleared/)
  await ui.unmount()
})

test('/panel zh and /panel en switch the language, and the choice is kept for later sessions', async ($, on) => {
  const { locale, settle } = world(on)
  locale.lang = 'en_US.UTF-8'
  const kept = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: kept.get((e as { key: string }).key) }) as never)
  on('store.set', (_, e) => (kept.set((e as { key: string }).key, (e as { value: unknown }).value), { value: undefined }) as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()

  expect((await $.command.run(command('panel', 'zh')))?.text).toBe('面板语言：中文。')
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /^会话$/)).toBe('会话')
  expect(await has(ui, /^上下文$/)).toBe('上下文')
  await ui.unmount()
  expect(kept.get('lang')).toBe('zh')

  // A later session on the same English machine: the choice stands.
  await $.command.run(command('panel', 'en'))
  kept.set('lang', 'zh')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /^会话$/)).toBe('会话')
  await ui.unmount()

  // `auto` forgets it: the machine's language again.
  expect((await $.command.run(command('panel', 'auto')))?.text).toBe('Panel language: English.')
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /^Session$/)).toBe('Session')
  await ui.unmount()
})

test("Claude Code's own language setting comes before the locale", async ($, on) => {
  const { locale, settle } = world(on)
  locale.lang = 'en_US.UTF-8'
  locale.setting = 'chinese'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /^会话$/)).toBe('会话')
  await ui.unmount()
})
