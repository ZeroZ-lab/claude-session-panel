# Changelog

## 0.3.0 — 2026-11-16

**Added**
- The pane is in English or Chinese. It follows Claude Code's `language` setting when one is set, else the system locale (`LC_ALL`, `LC_MESSAGES`, `LANG`), and is English when neither says Chinese.
- `/panel zh`, `/panel en` pick the language for this session and later ones; `/panel auto` follows the machine again.
- `/panel formation` opens the formation page, as `/panel fleet` does.

**Changed**
- The words of a context event are no longer kept with it, so events already listed change language with the pane.
- `/panel`'s replies and its description are in the pane's language.

## 0.2.1 — 2026-11-16

**Fixed**
- Claude Code versions without mods refused to install the plugin (`expected record, received undefined` at `hooks`): `hooks/hooks.json` now carries an empty `hooks` record. Those versions still do not run the mod; the README says to update.

## 0.2.0 — 2026-11-16

Fixes from a review of 0.1.0.

**Fixed**
- A session started in a subfolder of a repository told none of its changes apart from earlier ones: file times are now read from the repository's top.
- After `/clear`, changes made before it still counted as this session's.
- A teammate in a terminal pane of its own stayed "flying" for ever: the roster's `idle` now lands it.
- A subagent woken again was timed from its first run; its time, calls and tokens now start again.
- A call whose end never came (a reload while it ran) spun for ever; after 10 minutes it is marked as ended without a result.
- A detailed context reading asked for while another ran could be dropped.

**Faster**
- git and file reads run only while a surface shows the pane, one run at a time, in batches, and remember files already known to be this session's.
- Tool calls, turn starts and turn ends no longer wait for the pane's state to be written.
- The overview no longer redraws on every tool call; the one-line glance no longer redraws each second.
- Nothing runs in `-p` runs or the SDK.

**Changed**
- Context: "—" until the first request; plan limits and cost grouped under 额度; bar and legend colors are always distinct.
- Overview order: context, trend, changes, outputs, connectors, environment. Connectors are one line.
- Working-tree caption reads plainly ("本次 2 项 · 另有 1 项在会话前"); the note on gray rows shows whenever there are any.
- Formation: the task leads each card, the callsign is a colored prefix; "已返航 / 失联" are now "完成 / 出错".
- Buttons have letters: `d` detail, `t` `g` trend views, `a` `x` `s` `m` log filters. The terminal key hint shows only in the terminal.
- Source tags are gray; "变小" is now "回落".

## 0.1.0 — 2026-11-15

First release.
