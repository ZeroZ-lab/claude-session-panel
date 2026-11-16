import { expect, test } from 'claude-code/testing'

import { command, PANE, spawn, world } from './helpers'

type Ui = { find: (q: { type: 'Text'; text: RegExp }) => Promise<{ text?: string } | undefined> }

const has = async (ui: Ui, re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text ?? '<missing>'
const lacks = async (ui: Ui, re: RegExp) => (await ui.find({ type: 'Text', text: re })) === undefined

test('the context card says how far compaction is, draws its reserve, and opens its detail', async ($, on) => {
  const { settle } = world(on, [65_000])
  await $.command.run(command('panel', '概览'))
  await settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // 160k threshold − 65k used
  expect(await has(ui, /^距压缩 95k$/)).toBe('距压缩 95k')
  expect(await has(ui, /虚线段是压缩预留/)).toMatch(/压缩预留/)
  expect(await has(ui, /^╍+$/)).toMatch(/╍/)
  expect(await has(ui, /每次请求固定 8k · 对话 57k/)).toMatch(/固定 8k/)
  expect(await lacks(ui, /CLAUDE\.md/)).toBe(true)
  expect(await lacks(ui, /MCP 服务器的工具说明/)).toBe(true)

  await ui.press({ key: 'ctx-detail' })
  expect(await has(ui, /MCP 服务器的工具说明/)).toMatch(/MCP/)
  expect(await has(ui, /^4k$/)).toBe('4k')
  expect(await has(ui, /CLAUDE\.md/)).toMatch(/CLAUDE/)
  await ui.unmount()
})

test('near the threshold the card warns and points at /compact', async ($, on) => {
  const { settle } = world(on, [150_000])
  await $.command.run(command('panel', '概览'))
  await settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /^距压缩 10k$/)).toBe('距压缩 10k')
  expect(await has(ui, /\/compact/)).toMatch(/compact/)
  await ui.unmount()
})

test('a jump names its source and the size of the result that brought it in', async ($, on) => {
  const { settle } = world(on, [10_000, 12_000, 70_000])
  on('tool.call', (_, e) => ({ result: {}, text: e.tool.startsWith('mcp__') ? 'x'.repeat(200_000) : '' }))

  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'u1' })
  await settle()
  await $.tool.call({ tool: 'mcp__context7__query-docs', query: 'react hooks', tool_use_id: 'u2' } as never)
  await settle()
  await $.tool.call({ tool: 'Bash', command: 'pwd', tool_use_id: 'u3' })
  await settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /^query-docs react hooks · 结果约 50k$/)).toMatch(/结果约 50k/)
  expect(await has(ui, /^mcp:context7$/)).toBe('mcp:context7')
  await ui.unmount()
})

test('the trend steps by turn, says what grew since the last one, and draws the compaction line', async ($, on) => {
  // The first plain read is the panel's own refresh as it opens.
  const { settle, turns } = world(on, [40_000, 40_000, 60_000, 90_000, 120_000])
  on('tool.call', () => ({ result: {}, text: '' }))
  await $.command.run(command('panel', '概览'))
  await settle()
  turns.turn = 1

  await $.tool.call({ tool: 'Bash', command: 'a', tool_use_id: 'u1' })
  await settle()
  await $.tool.call({ tool: 'Bash', command: 'b', tool_use_id: 'u2' })
  await settle()
  turns.turn = 2
  await $.tool.call({ tool: 'Bash', command: 'c', tool_use_id: 'u3' })
  await settle()
  await $.tool.call({ tool: 'Bash', command: 'd', tool_use_id: 'u4' })
  await settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Against the end of turn 1 (60k): +60k. Which part grew is named only when a
  // fresh estimate came in between; here none did, so none is named.
  expect(await has(ui, /^比上一轮 \+60k$/)).toBe('比上一轮 +60k')
  // 160k is within reach of a 120k peak: the line is drawn and named.
  expect(await has(ui, /┄ 压缩线/)).toMatch(/压缩线/)
  expect(await has(ui, /┄{3,}/)).toMatch(/┄/)
  expect(await has(ui, /^最高 /)).toBe('最高 160k')

  await ui.press({ key: 'grain-turn' })
  expect(await has(ui, /^2 轮 · 现在 120k/)).toMatch(/2 轮/)
  await ui.unmount()
})

test('a ship waiting on someone comes first, with its tokens; many ships fall into groups', async ($, on) => {
  const { clock, roster } = world(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'haiku', agentId: `a${n++}` }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('panel', '编队'))
  for (const task of ['one', 'two', 'three', 'four']) await $.agent.spawn(spawn(task))
  for (let i = 0; i < 4; i++) roster.push({ id: `a${i}`, status: i === 2 ? 'waiting' : 'running', type: 'Explore', description: '' })
  // A turn of the first ship spent some tokens.
  await $.turn.complete({
    answer: '', reason: 'answer', isAborted: false, turnId: 't', agentId: 'a0', durationMs: 5,
    usage: { model: 'haiku', input_tokens: 20_000, output_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as never)
  await clock.advance(6_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /^1 等待处理 · 2 执行中 · 1 已返航$/)).toBe('1 等待处理 · 2 执行中 · 1 已返航')
  expect(await has(ui, /^需要处理 · 1$/)).toBe('需要处理 · 1')
  expect(await has(ui, /^运行中 · 2$/)).toBe('运行中 · 2')
  expect(await has(ui, /^已结束 · 1$/)).toBe('已结束 · 1')
  expect(await has(ui, /等待处理：审批或回答问题/)).toMatch(/审批/)
  expect(await has(ui, /^21k · /)).toMatch(/21k/)
  await ui.unmount()
})

test('the log folds runs of one call, and filters by kind', async ($, on) => {
  const { settle } = world(on)
  on('tool.call', (_, e) => (e.tool === 'Edit' ? { result: {}, isError: true, text: 'no match' } : { result: {} }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
  await $.command.run(command('panel', '记录'))

  for (const [i, file] of ['a.ts', 'b.ts', 'c.ts'].entries()) {
    await $.tool.call({ tool: 'Read', file_path: `/repo/${file}`, tool_use_id: `r${i}` })
  }
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'x', new_string: 'y', tool_use_id: 'e1' })
  await $.tool.call({ tool: 'mcp__context7__query-docs', query: 'hooks', tool_use_id: 'm1' } as never)
  await $.skill.prompt({ skill: 'commit', text: 'Commit the work.' })
  await settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /^Read ×3$/)).toBe('Read ×3')
  expect(await has(ui, /^query-docs hooks$/)).toBe('query-docs hooks')
  expect(await has(ui, /^mcp:context7$/)).toBe('mcp:context7')

  await ui.press({ key: 'filter-failed' })
  expect(await has(ui, /^Edit a\.ts$/)).toBe('Edit a.ts')
  expect(await has(ui, /^no match$/)).toBe('no match')
  expect(await lacks(ui, /Read/)).toBe(true)

  await ui.press({ key: 'filter-mcp' })
  expect(await has(ui, /^query-docs hooks$/)).toBe('query-docs hooks')
  expect(await lacks(ui, /Edit/)).toBe(true)

  await ui.press({ key: 'filter-skill' })
  expect(await has(ui, /^commit$/)).toBe('commit')
  expect(await lacks(ui, /query-docs/)).toBe(true)
  await ui.unmount()
})
