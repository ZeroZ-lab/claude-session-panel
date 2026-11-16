// Small text helpers the pages share.

export const shortTokens = (n: number): string =>
  n >= 999_500 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
    : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n))

export const homeShort = (path: string): string => path.replace(/^\/Users\/[^/]+/, '~')

export const baseName = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

export const dirName = (path: string): string => {
  const parts = path.replace(/\/$/, '').split('/')
  return parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : ''
}

export const clockText = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** Green while there is room, amber when close, red when over. */
export const levelColor = (pct: number): string => (pct >= 80 ? 'error' : pct >= 60 ? 'warning' : 'success')

/** Whether two plain values hold the same data: a write that changes nothing redraws nothing. */
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** At most `n` characters, by code point, so no character is cut in half. */
export const clip = (text: string, n: number): string => [...text].slice(0, n).join('')
