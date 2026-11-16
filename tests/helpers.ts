import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

export const PANE = {
  plugin: 'session-panel',
  component: 'Pane',
  requestId: 'session-panel',
  props: {
    title: '会话',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
} as const

export const STATUS = [
  '# branch.oid abc',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -1',
  '1 .M N... 100644 100644 100644 aaa bbb hooks/register.tsx',
  '1 A. N... 000000 100644 100644 000 ccc types/new file.ts',
  '2 R. N... 100644 100644 100644 ddd eee R100 docs/笔记.md',
  'docs/old.md',
  '? notes/',
  '',
].join('\0')
export const NUMSTAT = '12\t3\thooks/register.tsx\0' + '40\t0\ttypes/new file.ts\0' + '0\t0\tdocs/笔记.md\0'

export const command = (name: string, args = '') => ({
  command: name,
  args,
  origin: { kind: 'composer' } as const,
  presentation: { isFullscreen: true, columns: 160 },
})

export const spawn = (description: string, subagentType = 'Explore') => ({
  prompt: 'look', description, subagentType,
  tool_use_id: 'toolu_spawn', provider: { plugin: 'engine', tier: 'core' } as const,
  parentModel: 'claude-test', background: true, fork: false,
})

export const done = (agentId: string, reason: 'answer' | 'error' = 'answer') => ({
  answer: '', reason, isAborted: false, turnId: `t-${agentId}`, agentId, durationMs: 5,
})

export const SUMMARY = { role: 'user' as const, text: 'The story so far.', toolUses: [] }

/**
 * The world beneath the plugin: a repository with changes, a session whose
 * context reads `readings` in turn (one per request), two MCP servers.
 */
export const world = (on: On, readings: number[] = [65_000]) => {
  const clock = mock.clock(on)
  const seen = { opens: 0 }
  let i = 0
  let now = readings[0] ?? 0
  on('ui.open', () => ((seen.opens += 1), { value: { isPlaced: true } }))
  // The panes a surface shows: none, unless a test places this one.
  const panes = { list: [] as { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[] }
  on('ui.panes', () => ({ value: panes.list }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  // Where the session runs, and the repository's top folder: a test may start it in a subfolder.
  const place = { root: '/Users/someone/work/app', top: '/Users/someone/work/app' }
  on('session.root', () => ({ value: place.root }))
  // The machine's language, as its locale says it: a test may set another.
  const locale = { lang: 'zh_CN.UTF-8' as string | undefined, setting: undefined as string | undefined }
  on('env.get', (_, e) => ({ value: e.name === 'LANG' ? locale.lang : undefined }))
  on('settings.read', () => ({ value: locale.setting === undefined ? {} : { language: locale.setting } }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.version', () => ({ value: { version: '2.1.325' } }))
  const turns = { turn: 3 }
  on('session.turns', () => ({ value: turns.turn }))
  on('session.repo', () => ({
    value: { root: '/Users/someone/work/app', remote: 'git@github.com:acme/app.git', internal: false, name: null },
  }))
  on('session.usage', (_, e) => {
    const breakdown = (e as { breakdown?: string } | undefined)?.breakdown
    // A plain read is a request going out: the next reading.
    if (breakdown === undefined) now = readings[Math.min(i++, readings.length - 1)] ?? 0
    return {
      value: {
        startedAt: 1_000,
        context: {
          tokens: now,
          window: 200_000,
          percent: Math.round((now / 200_000) * 100),
          breakdown: breakdown === undefined ? undefined : {
            categories: [
              { name: 'System prompt', tokens: 8_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
              { name: 'Messages', tokens: Math.max(0, now - 8_000), color: 'claude', isDeferred: false, kind: 'used' },
              { name: 'Free space', tokens: 100_000, color: 'inactive', isDeferred: false, kind: 'free' },
              { name: 'Autocompact buffer', tokens: 33_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
            ],
            autoCompactThreshold: 160_000,
            isAutoCompactEnabled: true,
            mcpTools: [
              { name: 'query-docs', serverName: 'context7', tokens: 3_000 },
              { name: 'resolve-library-id', serverName: 'context7', tokens: 1_000 },
            ],
            memoryFiles: [{ path: '/Users/someone/work/app/CLAUDE.md', tokens: 2_500, type: 'Project' }],
          },
        },
        rateLimits: [{ kind: 'seven_day', percentUsed: 96 }],
        cost: { usd: 0.68 },
      },
    } as never
  })
  // Every command the plugin ran, by its arguments.
  const runs: string[][] = []
  on('process.run', (_, e) => (runs.push([...e.argv]), {
    value: {
      exitCode: 0,
      stdout: e.argv.includes('status') ? STATUS : e.argv.includes('diff') ? NUMSTAT
        : e.argv.includes('--show-toplevel') ? `${place.top}\n` : 'true\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('tool.list', () => ({
    value: [
      { name: 'Bash', description: '', mcp: false },
      { name: 'mcp__context7__query-docs', description: '', mcp: true },
      { name: 'mcp__context7__resolve-library-id', description: '', mcp: true },
      { name: 'mcp__claude_ai_Gmail__create_draft', description: '', mcp: true },
    ],
  }))
  // What the roster lists: a test puts agents in it.
  const roster: { id: string; status: string; type: string; description: string }[] = []
  on('agent.list', () => ({ value: roster }) as never)
  // Two of the changed files were written in this session, the rest before it began.
  const written = { paths: ['/Users/someone/work/app/hooks/register.tsx', '/Users/someone/work/app/types/new file.ts'] }
  on('fs.stat', (_, e) => {
    const path = (e as { path?: string }).path ?? ''
    const isNew = written.paths.includes(path)
    return { value: { kind: 'file', size: 1, mtimeMs: isNew ? 2_000 : 500, isLink: false } } as never
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // Lets work a call started finish before the next, as the seconds between real requests do.
  return { clock, seen, roster, turns, place, panes, runs, written, locale, settle: () => clock.advance(0) }
}
