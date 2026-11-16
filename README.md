# Claude Session Panel

[中文说明](README.zh-CN.md)

A side pane for Claude Code in the terminal: what the desktop app's session overview shows, plus a per-request context trend, your subagents drawn as a formation, and a log of tool and skill calls.

| Overview | Formation |
|---|---|
| ![Overview page](docs/overview.png) | ![Formation page](docs/formation.png) |

## Requirements

- Claude Code with mods (hooks modules) support. Tested on 2.1.325.
- `git` on your `PATH`, for the working-tree card. Without it the rest of the pane still works.
- The pane docks beside the chat in the terminal's fullscreen layout. In other layouts it shows above the prompt as a one-line glance, or a cut-down page once you ask for it.

## Install

In a Claude Code terminal session:

```
/plugin install session-panel --marketplace ZeroZ-lab/claude-session-panel
```

Answer `y` to add the marketplace, then pick a scope.

**Update:** `claude plugin marketplace update claude-session-panel`, then `claude plugin update session-panel@claude-session-panel`.
**Uninstall:** `claude plugin uninstall session-panel@claude-session-panel`.

## Use

- The pane opens beside the chat on its own in the terminal's fullscreen layout (from 144 columns; 110 once you have opened it yourself). Elsewhere, open it with `/panel`.
- Three pages: **概览 Overview**, **编队 Formation**, **记录 Log**. Focus the pane with `ctrl+x tab`, then press `1` `2` `3`.
- With the pane focused, a button with a letter in front of it is pressed by that letter: `d` context detail, `t` trend total/change, `g` trend per request/turn, `a` `x` `s` `m` log filters (all, failed, skills, MCP).
- `/panel [overview|fleet|log]` (or `概览|编队|记录`) opens a page, `/panel demo` flies a five-ship demo, `/panel clear` clears finished ships and calls.
- Close the pane by hand and it stays closed in later sessions until you run `/panel` again.

## What it shows

- **Context**: usage, tokens left before auto-compaction, the compaction reserve, what fills the window (fixed per request vs. conversation, MCP servers, memory files), plan limits, cost.
- **Context trend**: one stacked bar per request or per turn, total or change; marks for compactions (with tokens before → after), drops and jumps, each jump named after the call whose result brought it in and its source (built-in, `mcp:<server>`, skill).
- **Working-tree changes**: this session's changes apart from those made before it began.
- **Outputs, connectors, environment**.
- **Formation**: each running subagent with its task, latest call, tokens and time; ones waiting on you come first.
- **Log**: tool and skill calls, runs folded (`Read ×5`), filters for failed / skill / MCP, and why each failure failed.

The text of the pane is in Chinese.

## Privacy

Everything stays on your machine; the mod makes no network calls of its own.

- While a surface shows the pane, it runs `git status`, `git diff --numstat` and `git rev-parse` (read only, with `--no-optional-locks`) in the session's folder: every 15 seconds, and soon after an edit. While the pane is hidden, git does not run.
- It reads the modification time of changed files, to tell this session's changes from earlier ones. It does not read file contents.
- It watches tool calls in the session to log them, and reads PR links (from `gh pr create`) and artifact links from their results, for the outputs card.
- It stores one value across sessions: whether you closed the pane by hand.

## Troubleshooting

- **The pane does not appear.** Make the terminal wider (144 columns for a pane that opens on its own), or run `/panel`. If you closed it by hand earlier, `/panel` brings it back.
- **Something looks wrong.** Start Claude Code with `claude --debug`: the debug log has a line for every hook of the mod that failed.
- **In `-p` runs and the SDK** the mod does nothing: there is no pane to draw.

## Development

```
claude plugin validate .
claude plugin test .
```

To try a change, start a session with `claude --plugin-dir <this folder>`.

## License

MIT
