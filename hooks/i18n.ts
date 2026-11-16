import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Lang } from '../types'

// The pane's two languages. Every word the pane draws is here, once per
// language; what is kept in the state holds no words, so a change of language
// redraws all of it.

export const lang = atom({ plugin: 'session-panel', key: 'lang' } as const, 'zh')

// Kept in the store: the language the person chose with `/panel zh|en`. None kept: follow the machine.
const LANG_KEY = 'lang'

/** What `/panel` takes for a language; `auto` follows the machine again. */
export const LANG_WORDS: Record<string, Lang | 'auto'> = {
  'zh': 'zh', '中文': 'zh', 'chinese': 'zh',
  'en': 'en', 'english': 'en', '英文': 'en',
  'auto': 'auto', '自动': 'auto',
}

const isChinese = (name: string): boolean => /^zh\b|^zh[_-]|chinese|中文|简体|繁體|繁体/i.test(name.trim())

/**
 * The machine's language: Claude Code's own `language` setting when set, else
 * the locale variables, else the runtime's locale; English when none says Chinese.
 */
async function detect($: EngineInterface): Promise<Lang> {
  const setting = await $.settings.read({ key: 'language' }).catch(() => undefined)
  if (typeof setting === 'string' && setting.trim() !== '') return isChinese(setting) ? 'zh' : 'en'
  const named = [
    await $.env.get('LC_ALL').catch(() => undefined),
    await $.env.get('LC_MESSAGES').catch(() => undefined),
    await $.env.get('LANG').catch(() => undefined),
  ].find(value => value !== undefined && value !== '' && !/^(C|POSIX)(\.|$)/.test(value))
  if (named !== undefined) return isChinese(named) ? 'zh' : 'en'
  try {
    return isChinese(new Intl.DateTimeFormat().resolvedOptions().locale) ? 'zh' : 'en'
  } catch {
    return 'en'
  }
}

/** At the session's start: the language the person chose, else the machine's. */
export async function restoreLang($: EngineInterface): Promise<Lang> {
  const stored = await $.store.get(LANG_KEY).catch(() => undefined)
  const next: Lang = stored === 'zh' || stored === 'en' ? stored : await detect($)
  await update($, lang, () => next)
  return next
}

/** The person named a language, for this session and the next ones; `auto` forgets the choice. */
export async function chooseLang($: EngineInterface, choice: Lang | 'auto'): Promise<Lang> {
  await $.store.set(LANG_KEY, choice).catch(() => {})
  const next = choice === 'auto' ? await detect($) : choice
  await update($, lang, () => next)
  return next
}

const zh = {
  title: '会话',
  pages: { overview: '概览', fleet: '编队', log: '记录' },
  filters: { all: '全部', failed: '失败', skill: '技能', mcp: 'MCP' },
  commandDescription: '打开会话面板：概览、子代理编队和调用记录',
  said: {
    opened: '会话面板已打开。',
    demo: '编队演示：五架子代理会飞大约 25 秒。',
    cleared: '已清除结束的部分；还在飞的子代理和还在运行的调用会保留。',
    lang: '面板语言：中文。',
  },

  glanceContext: (pct: number) => `上下文 ${pct}%`,
  glanceChanges: (n: number) => `${n} 处改动`,
  glanceFlying: (up: number, all: number) => `${up}/${all} 在飞`,
  hintFocused: '按 1 2 3 切换页面，按钮前的字母是它的键',
  hintUnfocused: 'ctrl+x tab 聚焦面板，再按 1 2 3 切换',
  hintCompact: '终端全屏布局下，面板会停靠在对话旁边',

  reading: '正在读取…',
  beforeFirst: (window: string) => `首个请求后统计 · 窗口 ${window}`,
  used: (tokens: string, window: string) => `已用 ${tokens} / ${window}`,
  toCompact: (tokens: string) => `距压缩 ${tokens}`,
  compactOff: '自动压缩已关闭',
  countedBy: '按输入 token 计',
  countedByWithReserve: '按输入 token 计 · 虚线段是压缩预留',
  nearCompact: '快到自动压缩了。想保留要点，可以先输入 /compact 并写明要保留什么。',
  // The words /context uses for its rows, in the pane's language.
  categories: {
    'Messages': '消息',
    'System prompt': '系统提示',
    'System tools': '系统工具',
    'MCP tools': 'MCP 工具',
    'MCP server instructions': 'MCP 服务器说明',
    'Memory files': '记忆文件',
    'Custom agents': '自定义代理',
    'Skills': '技能',
  } as Record<string, string>,
  fixedAndConversation: (fixed: string, conversation: string) => `每次请求固定 ${fixed} · 对话 ${conversation}`,
  less: '收起',
  detail: '详情',
  serverSchemas: 'MCP 服务器的工具说明',
  memoryFiles: '记忆文件',
  noDetail: '没有 MCP 工具或记忆文件占用',
  limits: '额度',
  limitNames: { five_hour: '5 小时限额', seven_day: '7 天限额' } as Record<string, string>,
  cost: '本次花费',

  growth: (change: string, most: string) => `比上一轮 ${change}${most !== '' ? ` · ${most}增长最多` : ''}`,
  freed: (tokens: string) => `回收 ${tokens}`,
  trendEmpty: '再发几次请求后，这里会画出上下文的变化。',
  top: (tokens: string) => `最高 ${tokens}`,
  maxChange: (tokens: string) => `最大变化 ${tokens}`,
  modes: ['总量', '变化'] as readonly [string, string],
  grains: ['按请求', '按轮'] as readonly [string, string],
  requests: (n: number) => `${n} 次请求`,
  turns: (n: number) => `${n} 轮`,
  now: (tokens: string) => `现在 ${tokens}`,
  peak: (tokens: string) => `峰值 ${tokens}`,
  compactLine: '┄ 压缩线',
  events: '事件',
  resultSize: (tokens: string) => `结果约 ${tokens}`,
  turn: (n: number) => `第 ${n} 轮`,
  eventNames: { compact: '压缩', drop: '回落', jump: '突增', model: '切换模型', skill: '技能' },
  triggers: { auto: '自动', plugin: '插件', manual: '手动' } as Record<string, string>,
  dropCause: '可能清理了旧工具结果',
  jumpCause: '你的输入或回复',

  notRepo: '不在 git 仓库中',
  clean: '工作区是干净的',
  more: (n: number) => `还有 ${n} 项`,
  grayNote: '灰色的是会话开始前就有的改动',
  changesAllSession: (n: number, added: number, removed: number) => `本次会话 ${n} 项 · +${added} -${removed}`,
  changesAllBefore: (n: number) => `${n} 项，都在会话开始前`,
  changesMixed: (session: number, before: number) => `本次 ${session} 项 · 另有 ${before} 项在会话前`,
  noOutputs: '本次会话还没有产出',
  outputKinds: { file: '文件', artifact: '页面', pr: 'PR' },
  noConnectors: '没有已连接的 MCP 服务器',
  rows: { root: '位置', branch: '分支', remote: '远程', model: '模型', version: '版本' },
  groups: {
    context: '上下文', trend: '上下文趋势', changes: '工作区改动', outputs: '产出',
    connectors: '连接器', environment: '环境', subagents: '子代理', calls: '调用记录',
  },
  trendTotal: '每次请求的构成',
  trendDelta: '每次请求的变化',
  outputCount: (n: number) => `${n} 项`,
  connectorCount: (servers: number, tools: number) => `${servers} 个 · ${tools} 个工具`,

  fleetEmpty: '子代理起飞后会出现在这里。输入 /panel demo 预览。',
  waitingLong: '等待处理：审批或回答问题',
  waiting: '等待处理',
  takingOff: '起飞中',
  ended: (isOk: boolean, calls: number) => `${isOk ? '完成' : '出错或中止'} · ${calls} 次调用`,
  sections: { waiting: '需要处理', running: '运行中', over: '已结束' },
  sumWaiting: (n: number) => `${n} 等待处理`,
  sumRunning: (n: number) => `${n} 执行中`,
  sumLanded: (n: number) => `${n} 完成`,
  sumLost: (n: number) => `${n} 出错`,

  noCalls: '还没有调用',
  noMatch: '没有符合条件的调用',
  skillTag: '技能',
  callTotals: (tools: number, skills: number) => `工具 ${tools} · 技能 ${skills}`,
  noEnd: '没有收到结束',

  demoTasks: ['搜索状态栏相关实现', '设计编队面板的布局', '核对 API 字段与文档', '审查改动并找潜在问题', '统计各模块的测试覆盖'] as readonly string[],
}

export type Words = typeof zh

const en: Words = {
  title: 'Session',
  pages: { overview: 'Overview', fleet: 'Formation', log: 'Log' },
  filters: { all: 'All', failed: 'Failed', skill: 'Skills', mcp: 'MCP' },
  commandDescription: 'Open the session panel: overview, subagent formation and call log',
  said: {
    opened: 'Session panel opened.',
    demo: 'Formation demo: five ships are up for about 25 seconds.',
    cleared: 'Cleared what is over; ships still in the air and calls still running stay.',
    lang: 'Panel language: English.',
  },

  glanceContext: pct => `context ${pct}%`,
  glanceChanges: n => `${n} changed`,
  glanceFlying: (up, all) => `${up}/${all} flying`,
  hintFocused: '1 2 3: pages · letters press buttons',
  hintUnfocused: 'ctrl+x tab to focus, then 1 2 3',
  hintCompact: 'In the fullscreen layout the pane docks beside the chat',

  reading: 'Reading…',
  beforeFirst: window => `no requests yet · ${window} window`,
  used: (tokens, window) => `${tokens} / ${window} used`,
  toCompact: tokens => `${tokens} to compact`,
  compactOff: 'auto-compact off',
  countedBy: 'input tokens',
  countedByWithReserve: 'input tokens · dashes: compact reserve',
  nearCompact: 'Auto-compaction is near. To keep the key points, run /compact and say what to keep.',
  // /context's own words are English already.
  categories: {},
  fixedAndConversation: (fixed, conversation) => `fixed ${fixed} · conversation ${conversation}`,
  less: 'Less',
  detail: 'Detail',
  serverSchemas: 'MCP server tool schemas',
  memoryFiles: 'Memory files',
  noDetail: 'No MCP tools or memory files in the window',
  limits: 'Limits',
  limitNames: { five_hour: '5-hour limit', seven_day: '7-day limit' },
  cost: 'Session cost',

  growth: (change, most) => `${change} since last turn${most !== '' ? ` · ${most} grew most` : ''}`,
  freed: tokens => `freed ${tokens}`,
  trendEmpty: 'After a few more requests, the context trend is drawn here.',
  top: tokens => `top ${tokens}`,
  maxChange: tokens => `max ±${tokens}`,
  modes: ['total', 'change'],
  grains: ['req', 'turn'],
  requests: n => `${n} ${n === 1 ? 'request' : 'requests'}`,
  turns: n => `${n} ${n === 1 ? 'turn' : 'turns'}`,
  now: tokens => `now ${tokens}`,
  peak: tokens => `peak ${tokens}`,
  compactLine: '┄ compact line',
  events: 'Events',
  resultSize: tokens => `result ≈${tokens}`,
  turn: n => `turn ${n}`,
  eventNames: { compact: 'Compact', drop: 'Drop', jump: 'Jump', model: 'Model', skill: 'Skill' },
  triggers: { auto: 'auto', plugin: 'plugin', manual: 'manual' },
  dropCause: 'old tool results probably cleared',
  jumpCause: 'your prompt or the reply',

  notRepo: 'Not in a git repository',
  clean: 'The working tree is clean',
  more: n => `${n} more`,
  grayNote: 'Gray rows changed before this session',
  changesAllSession: (n, added, removed) => `${n} this session · +${added} -${removed}`,
  changesAllBefore: n => `${n}, all before this session`,
  changesMixed: (session, before) => `${session} this session · ${before} before`,
  noOutputs: 'Nothing made in this session yet',
  outputKinds: { file: 'file', artifact: 'page', pr: 'PR' },
  noConnectors: 'No MCP servers connected',
  rows: { root: 'Folder', branch: 'Branch', remote: 'Remote', model: 'Model', version: 'Version' },
  groups: {
    context: 'Context', trend: 'Context trend', changes: 'Changes', outputs: 'Outputs',
    connectors: 'Connectors', environment: 'Environment', subagents: 'Subagents', calls: 'Calls',
  },
  trendTotal: 'what each request held',
  trendDelta: 'change per request',
  outputCount: n => String(n),
  connectorCount: (servers, tools) =>
    `${servers} ${servers === 1 ? 'server' : 'servers'} · ${tools} ${tools === 1 ? 'tool' : 'tools'}`,

  fleetEmpty: 'Subagents show here once they take off. Run /panel demo for a preview.',
  waitingLong: 'Waiting on you: an approval or a question',
  waiting: 'Waiting on you',
  takingOff: 'taking off',
  ended: (isOk, calls) => `${isOk ? 'done' : 'failed or stopped'} · ${calls} ${calls === 1 ? 'call' : 'calls'}`,
  sections: { waiting: 'Needs you', running: 'Running', over: 'Finished' },
  sumWaiting: n => `${n} waiting`,
  sumRunning: n => `${n} running`,
  sumLanded: n => `${n} done`,
  sumLost: n => `${n} failed`,

  noCalls: 'No calls yet',
  noMatch: 'No calls match',
  skillTag: 'skill',
  callTotals: (tools, skills) => `tools ${tools} · skills ${skills}`,
  noEnd: 'ended without a result',

  demoTasks: [
    'Find the status line code', 'Design the formation layout', 'Check API fields against the docs',
    'Review the change for problems', 'Count test coverage per module',
  ],
}

export const WORDS: Record<Lang, Words> = { zh, en }
