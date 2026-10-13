/**
 * alphavantage.js — live quotes and daily prices from Alpha Vantage.
 *
 * Key: set ALPHAVANTAGE_API_KEY, or put {"alphaVantageKey": "..."} in
 * firm/desk.secrets.json (git-ignored — never commit your key).
 *
 * The free plan allows ~25 calls a day, so everything is cached on disk
 * (~/.agent-office/av-cache.json, survives restarts): quotes for 5 minutes
 * while the market is open (1 hour when it's closed), daily history for 12
 * hours. When Alpha Vantage says we're over the limit we stop asking until
 * tomorrow and callers fall back to Yahoo / model estimates.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { PROJECT_DIR } from './roster.js'
import { classify } from './classify.js'

const SECRETS = join(PROJECT_DIR, 'firm', 'desk.secrets.json')
const DIR = join(homedir(), '.agent-office')
const CACHE = join(DIR, 'av-cache.json')
const BASE = 'https://www.alphavantage.co/query'
const QUOTE_TTL_OPEN = 5 * 60 * 1000
const QUOTE_TTL_CLOSED = 60 * 60 * 1000
const DAILY_TTL = 12 * 60 * 60 * 1000

let keyCache
export function avKey() {
  if (keyCache !== undefined) return keyCache
  keyCache = process.env.ALPHAVANTAGE_API_KEY || null
  if (!keyCache && existsSync(SECRETS)) {
    try { keyCache = JSON.parse(readFileSync(SECRETS, 'utf8')).alphaVantageKey || null } catch {}
  }
  return keyCache
}

let cache = { quotes: {}, daily: {}, limitedUntil: 0, premiumFull: false, calls: { day: '', n: 0 } }
try { if (existsSync(CACHE)) cache = { ...cache, ...JSON.parse(readFileSync(CACHE, 'utf8')) } } catch {}
function save() {
  try { mkdirSync(DIR, { recursive: true }); writeFileSync(CACHE, JSON.stringify(cache)) } catch {}
}

const today = () => new Date().toISOString().slice(0, 10)
function nextMidnightUtcish() {
  // Alpha Vantage resets daily; be conservative and wait until tomorrow ~00:05 US Eastern
  const d = new Date()
  d.setUTCHours(24 + 4, 5, 0, 0)
  return d.getTime()
}

/** one GET to Alpha Vantage → parsed JSON, or null (sets limitedUntil on a limit message) */
async function call(params, timeoutMs = 8000) {
  const key = avKey()
  if (!key) return null
  if (Date.now() < (cache.limitedUntil || 0)) return null
  const url = `${BASE}?${new URLSearchParams({ ...params, apikey: key })}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) return null
    const j = await res.json()
    if (cache.calls.day !== today()) cache.calls = { day: today(), n: 0 }
    cache.calls.n++
    const info = j?.Information || j?.Note
    if (info) {
      if (/premium/i.test(info) && params.outputsize === 'full') { cache.premiumFull = true; save(); return { premium: true } }
      if (/rate limit|requests per day|per minute|frequency|spreading out/i.test(info)) {
        cache.limitedUntil = /per minute|spreading out/i.test(info) ? Date.now() + 65_000 : nextMidnightUtcish()
        console.warn('[alphavantage] rate limited:', info.slice(0, 120))
      }
      save()
      return null
    }
    if (j?.['Error Message']) { save(); return null }
    save()
    return j
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const num = v => (v == null || v === '' ? null : Number(String(v).replace('%', '')))

/**
 * Latest quote → { ticker, price, change, changePct, open, high, low, prevClose, volume, day, source } | null
 * (changePct is a fraction, e.g. 0.0123 = +1.23%)
 */
export async function avQuote(rawTicker, { marketOpen = true } = {}) {
  const c = classify(rawTicker)
  const t = c.ticker
  if (t === 'CASH') return null
  const ttl = marketOpen ? QUOTE_TTL_OPEN : QUOTE_TTL_CLOSED
  const hit = cache.quotes[t]
  if (hit && Date.now() - hit.at < ttl) return hit.q
  let q = null
  if (c.cls === 'crypto' && !c.fund && (t === 'BTC' || t === 'ETH' || t === 'DOGE' || t === 'SOL')) {
    const j = await call({ function: 'CURRENCY_EXCHANGE_RATE', from_currency: t, to_currency: 'USD' })
    const r = j?.['Realtime Currency Exchange Rate']
    if (r) q = { ticker: t, price: num(r['5. Exchange Rate']), change: null, changePct: null, day: r['6. Last Refreshed'], source: 'alphavantage' }
  } else {
    const sym = t === 'BRK.B' || t === 'BRKB' ? 'BRK-B' : t
    const j = await call({ function: 'GLOBAL_QUOTE', symbol: sym })
    const g = j?.['Global Quote']
    if (g && g['05. price']) {
      q = {
        ticker: t, price: num(g['05. price']), change: num(g['09. change']),
        changePct: num(g['10. change percent']) != null ? num(g['10. change percent']) / 100 : null,
        open: num(g['02. open']), high: num(g['03. high']), low: num(g['04. low']),
        prevClose: num(g['08. previous close']), volume: num(g['06. volume']), day: g['07. latest trading day'],
        source: 'alphavantage',
      }
    }
  }
  if (q && Number.isFinite(q.price)) {
    cache.quotes[t] = { at: Date.now(), q }
    save()
    return q
  }
  return hit?.q ?? null   // a stale quote beats no quote
}

/** Daily closes → { symbol, last, series: Map<'YYYY-MM-DD', close> } | null  (same shape as marketdata.fetchHistory) */
export async function avDaily(rawTicker) {
  const c = classify(rawTicker)
  const t = c.ticker
  if (t === 'CASH' || (c.cls === 'crypto' && !c.fund)) return null   // crypto history: Yahoo
  const hit = cache.daily[t]
  const fromCache = h => ({ symbol: t, last: h.series.at(-1)?.[1], series: new Map(h.series) })
  if (hit && Date.now() - hit.at < DAILY_TTL) return fromCache(hit)
  const sym = t === 'BRK.B' || t === 'BRKB' ? 'BRK-B' : t
  let j = cache.premiumFull ? null : await call({ function: 'TIME_SERIES_DAILY', symbol: sym, outputsize: 'full' })
  if (!j || j.premium) j = await call({ function: 'TIME_SERIES_DAILY', symbol: sym, outputsize: 'compact' })
  const ts = j?.['Time Series (Daily)']
  if (ts) {
    const series = Object.entries(ts).map(([d, v]) => [d, num(v['4. close'])]).filter(([, v]) => Number.isFinite(v))
      .sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-260)
    if (series.length >= 30) {
      cache.daily[t] = { at: Date.now(), series }
      save()
      return fromCache(cache.daily[t])
    }
  }
  return hit ? fromCache(hit) : null
}

export function avStatus() {
  return {
    configured: !!avKey(),
    callsToday: cache.calls.day === today() ? cache.calls.n : 0,
    limited: Date.now() < (cache.limitedUntil || 0),
    limitedUntil: cache.limitedUntil || 0,
    cachedQuotes: Object.keys(cache.quotes).length,
  }
}
