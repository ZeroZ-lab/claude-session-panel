// ---- The formation: running subagents, and the call log ----

export type ShipStatus = 'flying' | 'landed' | 'lost'

export type Ship = {
  /** The subagent's id, or `demo-N` for a ship of the demo. */
  id: string
  /** Its number in the formation, the lowest free one: it picks the callsign and color. */
  seq: number
  /** The agent type it was spawned as. */
  type: string
  /** The few words the spawn described the task in. */
  task: string
  status: ShipStatus
  startedAt: number
  /** When it landed or was lost; 0 while flying. */
  endedAt: number
  /** Tool calls so far. */
  tools: number
  /** The last tool call, as one short line. */
  last: string
  /** How long a demo ship flies, in ms; 0 for a real subagent. */
  demoMs: number
  /** Tokens its turns have used so far, input and output. */
  tokens: number
  /** True while the roster says it waits on someone: an approval, a question. */
  isWaiting: boolean
}

/** One row of the call log: a tool call, or a skill as it was loaded. */
export type Entry = {
  /** The tool call's id; `skill-N-time` for a skill. */
  id: string
  kind: 'tool' | 'skill'
  /** `Bash git status`, or the skill's name. */
  label: string
  /** The callsign of the ship that made it, as it was then; empty for the main conversation. */
  who: string
  /** That ship's number then, for its color; -1 for the main conversation. */
  seq: number
  status: 'running' | 'ok' | 'failed'
  /** Why it failed, as one short line: the refusal, the error, or the start of the tool's error text; `NO_END` for a call whose end never came. */
  error: string
  /** Where the tool comes from: '' built in, `mcp:<server>` for an MCP server's, `skill` for a skill. */
  source: string
  /** When it began, by the session's clock. */
  startedAt: number
}

export type Totals = { tools: number; skills: number }

// ---- The overview: environment, context, connectors, outputs, changes ----

/** Where the session runs and on what. */
export type Env = {
  root: string
  /** Empty outside a git repository. */
  branch: string
  ahead: number
  behind: number
  /** `owner/name` when known, else the remote URL, else empty. */
  remote: string
  model: string
  version: string
}

export type Category = { name: string; tokens: number; color: string }
export type Limit = { kind: string; percent: number; resetsAt: string }

/** The context window and what the session has used. */
export type Ctx = {
  tokens: number
  window: number
  percent: number
  /** The biggest parts of the window, largest first. */
  categories: Category[]
  limits: Limit[]
  usd: number
  /** Where auto-compaction runs, in tokens; 0 when it is off or not known yet. */
  threshold: number
  /** The compaction reserve kept free at the end of the window, in tokens. */
  buffer: number
  /** What the session carries on every request (system prompt, tools, memory, skills), and what the conversation adds. */
  fixed: number
  conversation: number
  /** The MCP servers whose tool schemas are in the window, biggest first. */
  servers: { name: string; tokens: number }[]
  /** The memory files in the window, biggest first. */
  memory: { path: string; tokens: number }[]
}

/** One connected MCP server and how many tools it gives the model. */
export type Connector = { name: string; tools: number }

/** Something the session made: a file written, a page published, a pull request. */
export type Output = {
  key: string
  kind: 'file' | 'artifact' | 'pr'
  label: string
  at: number
}

/** One entry of the working tree's changes, as git sees it. */
export type Change = {
  /** A file; for untracked files, a whole new directory may stand as one entry (`dir/`). */
  path: string
  /** `M`, `A`, `D`, `R`, `U`, or `?` for untracked. */
  status: string
  added: number
  removed: number
  /** Changed since this session began: its file was written after the session started. */
  isSession: boolean
}

export type Changes = {
  isRepo: boolean
  /** How many entries git reported, of which `files` keeps the first few. */
  count: number
  /** Of those, how many this session changed. */
  sessionCount: number
  added: number
  removed: number
  files: Change[]
}

/** One reading of the context, taken as a model request goes out. */
export type Sample = {
  /** Its place in the session's readings, counting from 1. */
  n: number
  at: number
  turn: number
  /** Tokens in the window, as the status line counts them. */
  total: number
  window: number
  /** The latest estimate of what those tokens are, in /context's order. */
  parts: Category[]
}

/** Something that moved the context: what the trend marks and the list names. */
export type CtxEvent = {
  at: number
  turn: number
  kind: 'compact' | 'drop' | 'jump' | 'model' | 'skill'
  /** Tokens it added (positive) or took back (negative); 0 when it says nothing of size. */
  tokens: number
  /** What it was, when that is a name (a call, a skill, a model); empty when the pane has its own words for it. */
  label: string
  /** The reading it shows under, by `n`; none for one the trend does not mark. */
  n?: number
  /** For a compaction: what started it (`auto`, `plugin`, `manual`); the pane says it in its language. */
  trigger?: string
  /** For a jump: where the call that brought it in comes from ('' built in, `mcp:<server>`, `skill`). */
  source?: string
  /** For a jump: about how many tokens that call's result held. */
  size?: number
}

/** The language the pane is drawn in. */
export type Lang = 'zh' | 'en'

/** The pane's three pages, chosen with its segmented control. */
export type Page = 'overview' | 'fleet' | 'log'

declare module 'claude-code' {
  interface PluginState {
    'session-panel': {
      page: Page
      /** The pane's language: the one chosen with `/panel zh|en`, else the machine's. */
      lang: Lang
      /** True once the person closed the pane by hand: nothing reopens it unasked. */
      isDismissed: boolean
      /** True while the pane is open because the person asked for it, not because the session started. */
      isAsked: boolean

      ships: Shaped<Ship[]>
      log: Shaped<Entry[]>
      totals: Shaped<Totals>
      /** The animation's frame, moved each second while something runs. */
      tick: number

      env: Shaped<Env | null>
      ctx: Shaped<Ctx | null>
      connectors: Shaped<Connector[]>
      outputs: Shaped<Output[]>
      changes: Shaped<Changes>
      samples: Shaped<Sample[]>
      events: Shaped<CtxEvent[]>
      /** The trend's view: what each request held, or what it changed. */
      trendMode: 'total' | 'delta'
      /** The trend's step: one bar per request, or per turn. */
      trendGrain: 'step' | 'turn'
      /** Whether the context card shows its detail: fixed and conversation, MCP servers, memory files. */
      isCtxOpen: boolean
      /** Which calls the log shows. */
      logFilter: 'all' | 'failed' | 'skill' | 'mcp'
    }
  }
}
