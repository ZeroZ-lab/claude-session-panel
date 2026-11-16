import { expect, test } from 'claude-code/testing'

import { command, done, PANE, spawn, SUMMARY, world } from './helpers'

type Ui = { find: (q: { type: 'Text'; text: RegExp }) => Promise<{ text?: string } | undefined> }

/** The text of the first Text matching `re`, or a line naming what was missing. */
const has = async (ui: Ui, re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text ?? '<missing>'
const lacks = async (ui: Ui, re: RegExp) => (await ui.find({ type: 'Text', text: re })) === undefined

test('the overview page shows the desktop overview, on every surface', async ($, on) => {
  const { settle } = world(on)
  await $.command.run(command('panel', '概览'))
  await settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await has(ui, /^会话$/)).toMatch(/^会话$/)
    expect(await has(ui, /app · main · 有未提交的改动/)).toMatch(/app · main/)
    // Context
    expect(await has(ui, /已用 65k \/ 200k/)).toMatch(/65k/)
    expect(await has(ui, /^消息$/)).toBe('消息')
    expect(await lacks(ui, /Free space/)).toBe(true)
    expect(await has(ui, /^96%$/)).toBe('96%')
    expect(await has(ui, /\$0\.68/)).toMatch(/0\.68/)
    // Changes: parsed from NUL-ended fields, a rename's old path skipped, a new directory one entry;
    // this session's apart from what was there before it began
    expect(await has(ui, /^工作区改动$/)).toBe('工作区改动')
    expect(await has(ui, /本次会话 2 项 · 共 4 项/)).toMatch(/本次会话 2 项/)
    expect(await has(ui, /灰色的是会话开始前就有的改动/)).toMatch(/会话开始前/)
    // How to switch pages, while the pane does not hold the keyboard
    expect(await has(ui, /ctrl\+x tab 聚焦面板/)).toMatch(/ctrl\+x tab/)
    expect(await has(ui, /^register\.tsx$/)).toBe('register.tsx')
    expect(await has(ui, /^new file\.ts$/)).toBe('new file.ts')
    expect(await has(ui, /^笔记\.md$/)).toBe('笔记.md')
    expect(await lacks(ui, /old\.md/)).toBe(true)
    expect(await has(ui, /^notes\/$/)).toBe('notes/')
    // Connectors, environment
    expect(await has(ui, /2 个已连接/)).toMatch(/2 个/)
    expect(await has(ui, /claude\.ai Gmail/)).toMatch(/Gmail/)
    expect(await has(ui, /main ↑2 ↓1/)).toMatch(/↑2/)
    expect(await has(ui, /acme\/app/)).toMatch(/acme/)
    await ui.unmount()
  }
})

test('the segmented control switches pages, and the formation shows a badge', async ($, on) => {
  world(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await $.agent.spawn(spawn('搜索状态栏实现'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /^ ●1$/)).toBe(' ●1')
  expect(await has(ui, /^上下文$/)).toBe('上下文')

  await ui.press({ key: 'page-fleet' })
  expect(await has(ui, /^Alpha$/)).toBe('Alpha')
  expect(await has(ui, /1 执行中/)).toMatch(/1 执行中/)
  expect(await lacks(ui, /^上下文$/)).toBe(true)

  await ui.press({ key: 'page-log' })
  expect(await has(ui, /^调用记录$/)).toBe('调用记录')
  await ui.unmount()
})

test('a subagent flies, reports its calls and lands; the log names it', async ($, on) => {
  const { settle } = world(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: 'done' }))
  await $.command.run(command('panel', '编队'))

  await $.agent.spawn(spawn('搜索状态栏实现'))
  await $.tool.call({ tool: 'Bash', command: 'git status', agentId: 'a1', tool_use_id: 'u1' })
  await settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /Bash git status/)).toMatch(/git status/)
  expect(await has(ui, /Explore · 搜索状态栏实现/)).toMatch(/搜索/)
  await ui.press({ key: 'page-log' })
  expect(await has(ui, /工具 1 · 技能 0/)).toMatch(/工具 1/)
  expect(await has(ui, /^Alpha$/)).toBe('Alpha')
  await ui.unmount()

  await $.turn.complete(done('a1'))
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await after.press({ key: 'page-fleet' })
  expect(await has(after, /1 已返航/)).toMatch(/已返航/)
  await after.unmount()
})

test('a subagent that errors is lost; one that ended before it was listed lands at once', async ($, on) => {
  world(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'haiku', agentId: `a${n++}` }))
  on('turn.complete', () => ({ text: '' }))
  await $.command.run(command('panel', '编队'))

  await $.agent.spawn(spawn('one'))
  await $.turn.complete(done('a0', 'error'))
  await $.turn.complete(done('a1'))
  await $.agent.spawn(spawn('two'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /1 已返航 · 1 失联/)).toMatch(/失联/)
  expect(await lacks(ui, /执行中/)).toBe(true)
  await ui.unmount()
})

test('a ship the roster stops listing lands only after it has been missing a while', async ($, on) => {
  const { clock } = world(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(command('panel', '编队'))
  await clock.advance(60_000)
  await $.agent.spawn(spawn('long task'))

  // The roster stops listing it now: 5 s later it is still in the air.
  await clock.advance(6_000)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /1 执行中/)).toMatch(/执行中/)
  await ui.unmount()

  await clock.advance(25_000)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /1 已返航/)).toMatch(/已返航/)
  await ui.unmount()
})

test('a failed call and a denied one are failed, each with its reason', async ($, on) => {
  const { settle } = world(on)
  on('tool.call', (_, e) =>
    e.tool === 'Read'
      ? { result: {}, isError: true, text: 'disk gone\n    at read (fs.ts:12)' }
      : { deny: 'not here' },
  )
  await $.command.run(command('panel', '记录'))

  await $.tool.call({ tool: 'Read', file_path: '/a/notes.md', tool_use_id: 'u1' })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf x', tool_use_id: 'u2' })
  await settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /Read notes\.md/)).toMatch(/notes/)
  expect(await has(ui, /Bash rm -rf x/)).toMatch(/rm/)
  expect(await lacks(ui, /^⠋$/)).toBe(true)
  expect(await has(ui, /^✕$/)).toBe('✕')
  // Each failure says why, in one line.
  expect(await has(ui, /^disk gone$/)).toBe('disk gone')
  expect(await has(ui, /^not here$/)).toBe('not here')
  await ui.unmount()
})

test('callsigns stay unique, and the log keeps the callsign a call was made under', async ($, on) => {
  world(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'haiku', agentId: `a${n++}` }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  await $.command.run(command('panel', '编队'))

  await $.agent.spawn(spawn('first'))
  await $.agent.spawn(spawn('second'))
  // Alpha lands while Bravo flies: the next ship takes Alpha's free number.
  await $.turn.complete(done('a0'))
  await $.agent.spawn(spawn('third'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /2 执行中 · 1 已返航/)).toMatch(/2 执行中/)
  await ui.unmount()
})

test('/panel clear keeps ships in the air and their running calls', async ($, on) => {
  world(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'haiku', agentId: `a${n++}` }))
  on('turn.complete', () => ({ text: '' }))
  await $.agent.spawn(spawn('stays'))
  await $.agent.spawn(spawn('goes'))
  await $.turn.complete(done('a1'))
  await $.command.run(command('panel', 'clear'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /^1 执行中$/)).toBe('1 执行中')
  expect(await lacks(ui, /goes/)).toBe(true)
  await ui.unmount()
})

test('the demo flies five ships', async ($, on) => {
  world(on)
  await $.command.run(command('panel', 'demo'))

  const docked = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(docked, /5 执行中/)).toMatch(/5 执行中/)
  expect(await has(docked, /^Echo$/)).toBe('Echo')
  await docked.unmount()
})

const INLINE = { ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'inline', bodyColumns: 70, scroll: { offset: 0, bodyRows: 30 } } } as const

test('opened unasked above the prompt, the panel is one line', async ($, on) => {
  world(on)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  await $.agent.spawn(spawn('task'))

  const ui = await $.ui.mount(INLINE)
  expect(await has(ui, /1\/1 在飞/)).toMatch(/1\/1/)
  expect(await lacks(ui, /^上下文$/)).toBe(true)
  await ui.unmount()
})

test('asked for above the prompt, the panel shows its page, cut down', async ($, on) => {
  world(on)
  await $.command.run(command('panel', '概览'))

  const ui = await $.ui.mount(INLINE)
  expect(await has(ui, /^上下文$/)).toBe('上下文')
  expect(await has(ui, /^工作区改动$/)).toBe('工作区改动')
  expect(await lacks(ui, /^上下文趋势$/)).toBe(true)
  expect(await lacks(ui, /^连接器$/)).toBe(true)
  expect(await has(ui, /终端全屏布局下/)).toMatch(/全屏/)
  await ui.press({ key: 'page-fleet' })
  expect(await has(ui, /^子代理$/)).toBe('子代理')
  await ui.unmount()
})

test('a file written inside the project is an output; a scratch file outside it is not', async ($, on) => {
  const { settle } = world(on)
  on('tool.call', () => ({ result: {}, text: '' }))
  await $.tool.call({ tool: 'Write', file_path: '/Users/someone/work/app/README.md', content: 'hi', tool_use_id: 'u1' })
  await $.tool.call({ tool: 'Write', file_path: '/tmp/scratch/fix.py', content: 'x', tool_use_id: 'u2' })
  await settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /^1 项$/)).toBe('1 项')
  expect(await has(ui, /^README\.md$/)).toBe('README.md')
  expect(await lacks(ui, /fix\.py/)).toBe(true)
  await ui.unmount()
})

test('a pane closed by hand in an earlier session is not opened unasked', async ($, on) => {
  const { clock, seen } = world(on)
  on('store.get', (_, e) => ({ value: (e as { key?: string }).key === 'isDismissed' ? true : undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  expect(seen.opens).toBe(0)

  await $.command.run(command('panel'))
  expect(seen.opens).toBe(1)
})

test('a short pane gives each ship fewer lines', async ($, on) => {
  world(on)
  await $.command.run(command('panel', 'demo'))

  const short = await $.ui.mount({
    ...PANE, surface: 'terminal', props: { ...PANE.props, scroll: { offset: 0, bodyRows: 20 } },
  })
  // One line a ship: the task sits beside the callsign; no type line, no action line.
  expect(await has(short, /^搜索状态栏相关实现$/)).toBe('搜索状态栏相关实现')
  expect(await lacks(short, /Explore · /)).toBe(true)
  await short.unmount()
})

test('a compaction is listed once, and a later drop still is', async ($, on) => {
  const { settle } = world(on, [10_000, 150_000, 140_000, 40_000])
  on('tool.call', () => ({ result: {}, text: '' }))
  on('session.compact', () => ({ messages: [SUMMARY], tokensBefore: 150_000, tokensAfter: 140_000 }))
  on('skill.prompt', (_, e) => ({ text: 'x'.repeat(12_000) + e.text }))
  on('turn.complete', () => ({ text: '' }))

  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'u1' })
  await settle()
  await $.tool.call({ tool: 'Bash', command: 'ls -la', tool_use_id: 'u2' })
  await settle()
  // A small compaction: less than a drop, still marked on the next reading.
  await $.session.compact({ trigger: 'auto', messages: [SUMMARY] })
  await settle()
  await $.tool.call({ tool: 'Bash', command: 'pwd', tool_use_id: 'u3' })
  await settle()
  // A later, unrelated drop is still listed.
  await $.tool.call({ tool: 'Bash', command: 'date', tool_use_id: 'u4' })
  await settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /^压缩$/)).toBe('压缩')
  expect(await has(ui, /^自动 · 150k → 140k$/)).toBe('自动 · 150k → 140k')
  expect(await has(ui, /^回收 10k$/)).toBe('回收 10k')
  expect(await has(ui, /^变小$/)).toBe('变小')
  expect(await has(ui, /可能清理了旧工具结果/)).toMatch(/旧工具结果/)
  expect(await has(ui, /^回收 100k$/)).toBe('回收 100k')
  expect(await has(ui, /^✂$/)).toBe('✂')
  expect(await has(ui, /4 次请求/)).toMatch(/4 次请求/)
  await ui.unmount()
})

test('a skill and a model switch are events; three show', async ($, on) => {
  const { settle } = world(on, [10_000, 20_000])
  on('tool.call', () => ({ result: {}, text: '' }))
  on('skill.prompt', (_, e) => ({ text: 'x'.repeat(12_000) + e.text }))
  on('turn.complete', () => ({ text: '' }))
  await $.skill.prompt({ skill: 'commit', text: 'Commit the work.' })
  await settle()
  await $.turn.complete({ answer: '', reason: 'answer', isAborted: false, turnId: 't1', durationMs: 5, usage: { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } as never)
  await settle()
  await $.turn.complete({ answer: '', reason: 'answer', isAborted: false, turnId: 't2', durationMs: 5, usage: { model: 'claude-haiku-5-5', input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } as never)
  await settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /^commit$/)).toBe('commit')
  expect(await has(ui, /^≈\+3k$/)).toBe('≈+3k')
  expect(await has(ui, /opus 5\.5 → haiku 5\.5/)).toMatch(/→/)
  await ui.unmount()
})

test('a jump is named after the call whose result brought it in', async ($, on) => {
  const { settle } = world(on, [10_000, 12_000, 70_000])
  on('tool.call', () => ({ result: {}, text: '' }))

  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'u1' })
  await settle()
  await $.tool.call({ tool: 'Read', file_path: '/repo/big.log', tool_use_id: 'u2' })
  await settle()
  // Its request comes back with the log in it: the jump is the Read's, not this Edit's.
  await $.tool.call({ tool: 'Edit', file_path: '/repo/x.ts', old_string: 'a', new_string: 'b', tool_use_id: 'u3' })
  await settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await has(ui, /^突增$/)).toBe('突增')
  expect(await has(ui, /^Read big\.log$/)).toBe('Read big.log')
  expect(await has(ui, /^\+58k$/)).toBe('+58k')
  expect(await has(ui, /^▲$/)).toBe('▲')
  await ui.press({ key: 'mode-delta' })
  expect(await has(ui, /最大变化 58k/)).toMatch(/58k/)
  await ui.unmount()
})
