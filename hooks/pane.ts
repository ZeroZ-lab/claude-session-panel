import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

// The one pane, which of its pages shows, and whether the person wants it.

export const PANE = 'session-panel'
export const PANE_ARGS = { id: PANE, title: '会话', columns: 46 } as const

export const page = atom({ plugin: 'session-panel', key: 'page' } as const, 'overview')
export const isDismissed = atom({ plugin: 'session-panel', key: 'isDismissed' } as const, false)
export const isAsked = atom({ plugin: 'session-panel', key: 'isAsked' } as const, false)

// Kept in the store, so a pane closed by hand stays closed in later sessions too.
const DISMISSED_KEY = 'isDismissed'

/** At the session's start: a pane the person closed in an earlier session stays closed. */
export async function restoreDismissal($: EngineInterface) {
  const stored = await $.store.get(DISMISSED_KEY).catch(() => undefined)
  if (stored === true) await update($, isDismissed, () => true)
}

/** The person closed the pane (`true`) or asked for it back (`false`): for this session and the next ones. */
export async function setDismissed($: EngineInterface, value: boolean) {
  await update($, isDismissed, () => value)
  await $.store.set(DISMISSED_KEY, value).catch(() => {})
}

/**
 * Opens the pane unasked, unless the person closed it by hand or it is open
 * already: a second open could bring it to the front over what they are on.
 * When the open panes cannot be listed it does nothing. Never throws.
 */
export async function showPane($: EngineInterface) {
  try {
    if (await read($, isDismissed)) return
    const panes = await $.ui.panes()
    if (!panes.some(pane => pane.id === PANE)) await $.ui.open(PANE_ARGS)
  } catch {
    // The pane is a view: a refused open costs nothing else.
  }
}
