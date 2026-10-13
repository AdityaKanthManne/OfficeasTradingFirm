/**
 * prices.js — daily price series for the firm's day-to-day work (risk checks,
 * the alpha report, marking the books).
 *
 *  1. Live:  a year of daily closes from Yahoo's public chart endpoint (no daily
 *            cap), cached for 20 minutes. Alpha Vantage is NOT used here, so the
 *            25-calls-a-day free quota stays free for quotes you ask about in chat.
 *  2. Ahead of real time: when you've skipped the office clock past today, the
 *            live history is carried forward with simulated days ("live+sim").
 *  3. Sim:   when a symbol can't be fetched (no network, unknown symbol), a
 *            deterministic simulated series is used, clearly labelled "sim".
 *            Same symbol + same day → same price, so numbers don't jump around.
 *
 * Every result says which it is: source = 'live' | 'live+sim' | 'sim'.
 */

import { fetchYahoo } from './marketdata.js'
import { classify, equityBeta } from './classify.js'
import { loadDeskConfig } from './roster.js'

const TTL = 20 * 60 * 1000
const cache = new Map()        // symbol → { at, h }
const inflight = new Map()
const DAY = 86400000

// ---------------------------------------------------------------------------
// deterministic randomness
// ---------------------------------------------------------------------------
function hash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export function gauss(key) {
  const r = rng(hash(key))
  const u = Math.max(1e-9, r()), v = r()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
export const seededChance = (key) => rng(hash(key))()

const iso = ms => new Date(ms).toISOString().slice(0, 10)
const isWeekday = ms => { const d = new Date(ms).getUTCDay(); return d !== 0 && d !== 6 }

/** NY date of a moment, 'YYYY-MM-DD' */
const nyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
export const nyDate = ms => nyFmt.format(new Date(ms))
const nyMinsFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false })
const nyMins = ms => { const [h, m] = nyMinsFmt.format(new Date(ms)).split(':').map(Number); return (h % 24) * 60 + m }

// ---------------------------------------------------------------------------
// simulation — one market factor + each symbol's own noise
// ---------------------------------------------------------------------------
const SIM_EPOCH = Date.UTC(2025, 0, 2)
const SPECIAL_BETA = { SPY: 1, VTI: 1, QQQ: 1.2, IWM: 1.15, TLT: -0.3, IEF: -0.15, BND: -0.05, LQD: 0.1, HYG: 0.35, GLD: 0.05, SLV: 0.3, USO: 0.45, UUP: -0.15, VNQ: 0.8, ICLN: 1.2, '^VIX': 0 }

function simParams(t) {
  const c = classify(t)
  let beta = SPECIAL_BETA[t] ?? equityBeta(c)
  let vol = c.vol ?? 0.28
  if (t === 'SPY' || t === 'VTI') vol = 0.16
  if (t === 'TLT') vol = 0.15
  if (t === 'BND' || t === 'LQD') vol = 0.07
  if (t === 'HYG') vol = 0.08
  if (t === 'UUP') vol = 0.07
  if (c.ticker === 'CASH') return { beta: 0, idio: 0, base: 1, drift: 0 }
  const mktVol = 0.16
  const idio = Math.sqrt(Math.max(0.0004, vol * vol - (beta * mktVol) ** 2))
  const h = hash('base:' + t)
  const base = c.cls === 'crypto' ? (t === 'BTC' ? 60000 : t === 'ETH' ? 2600 : 40) : 20 + (h % 460)
  const drift = 0.06 + ((h >> 9) % 100) / 1000 - 0.05   // 1%–11% a year
  return { beta, idio, base, drift }
}

const mktRet = d => 0.0003 + (0.16 / Math.sqrt(252)) * gauss('MKT:' + d) * (1 + 0.6 * Math.max(0, gauss('MKTREG:' + d.slice(0, 7))))

function simDayRet(t, d, p) {
  return p.drift / 252 + p.beta * mktRet(d) + (p.idio / Math.sqrt(252)) * gauss(`${t}:${d}`)
}

/** simulated closes for trading days in [fromMs, toMs] continuing from startPx */
function simulate(t, dates, startPx) {
  const p = simParams(t)
  const out = []
  let px = startPx
  for (const d of dates) { px = px * Math.exp(simDayRet(t, d, p)); out.push(px) }
  return out
}

function weekdaysBetween(fromMs, toMs, everyDay = false) {
  const out = []
  for (let ms = Date.UTC(...isoParts(iso(fromMs))); ms <= toMs; ms += DAY) if (everyDay || isWeekday(ms)) out.push(iso(ms))
  return out
}
const isCrypto = t => classify(t).cls === 'crypto'
const isoParts = s => { const [y, m, d] = s.split('-').map(Number); return [y, m - 1, d] }

/** today's move so far, scaled by how much of the session has passed */
function sessionFraction(nowMs) {
  const m = nyMins(nowMs)
  return Math.max(0, Math.min(1, (m - 570) / 390))
}

function simVix(dates, spyCloses) {
  const out = []
  for (let i = 0; i < dates.length; i++) {
    const w = spyCloses.slice(Math.max(0, i - 20), i + 1)
    const r = w.slice(1).map((p, j) => Math.log(p / w[j]))
    const sd = r.length > 2 ? Math.sqrt(r.reduce((a, b) => a + b * b, 0) / r.length) : 0.01
    out.push(Math.max(10, sd * Math.sqrt(252) * 100 * 1.15 + 1.5 * gauss('VIX:' + dates[i])))
  }
  return out
}

function simSeries(t, nowMs) {
  const today = nyDate(nowMs)
  const all = weekdaysBetween(SIM_EPOCH, Date.UTC(...isoParts(today)))
  if (t === '^VIX') {
    const spy = simSeries('SPY', nowMs)
    return { dates: spy.dates, closes: simVix(spy.dates, spy.closes) }
  }
  const p = simParams(t)
  const crypto = isCrypto(t)
  const days = crypto ? weekdaysBetween(SIM_EPOCH, Date.UTC(...isoParts(today)), true) : all
  const closes = simulate(t, days, p.base)
  // today's bar is partial: the stock session (9:30–16:00 ET), or the whole day for crypto
  if (days.at(-1) === today && closes.length > 1) {
    const f = crypto ? nyMins(nowMs) / 1440 : (nyMins(nowMs) < 570 ? 0 : sessionFraction(nowMs))
    const prev = closes.at(-2)
    closes[closes.length - 1] = prev * Math.exp(Math.log(closes.at(-1) / prev) * f)
  }
  const n = crypto ? 365 : 260
  return { dates: days.slice(-n), closes: closes.slice(-n) }
}

// ---------------------------------------------------------------------------
// live
// ---------------------------------------------------------------------------
async function live(t) {
  const hit = cache.get(t)
  if (hit && Date.now() - hit.at < TTL) return hit.h
  if (inflight.has(t)) return inflight.get(t)
  const sym = t === '^VIX' ? '^VIX' : t
  const p = fetchYahoo(sym, { timeoutMs: 5000 }).catch(() => null).then(h => {
    inflight.delete(t)
    cache.set(t, { at: Date.now(), h })
    return h
  })
  inflight.set(t, p)
  return p
}

/**
 * → { ticker, source, dates[], closes[], last, prev, dayChg }
 * `closes.at(-1)` is today's (possibly intraday) price on the office clock.
 */
export async function getSeries(rawTicker, nowMs = Date.now()) {
  const t = rawTicker === '^VIX' ? '^VIX' : classify(rawTicker).ticker
  if (t === 'CASH') return { ticker: 'CASH', source: 'live', dates: [], closes: [1, 1], last: 1, prev: 1, dayChg: 0 }
  const cfg = loadDeskConfig()
  const h = cfg.marketData === 'off' ? null : await live(t)
  let dates, closes, source
  if (h && h.series?.size >= 30) {
    dates = [...h.series.keys()]
    closes = [...h.series.values()]
    if (Number.isFinite(h.last) && h.last > 0) closes[closes.length - 1] = h.last
    source = 'live'
    // office clock is ahead of the real market: carry forward with simulated days
    const lastLive = dates.at(-1)
    const today = nyDate(nowMs)
    if (today > lastLive) {
      const extra = weekdaysBetween(Date.UTC(...isoParts(lastLive)) + DAY, Date.UTC(...isoParts(today)), isCrypto(t))
      if (extra.length) {
        const ext = t === '^VIX' ? extra.map(d => Math.max(10, closes.at(-1) + 1.2 * gauss('VIX:' + d))) : simulate(t, extra, closes.at(-1))
        dates = [...dates, ...extra].slice(-260)
        closes = [...closes, ...ext].slice(-260)
        source = 'live+sim'
      }
    }
  } else {
    ({ dates, closes } = simSeries(t, nowMs))
    source = 'sim'
  }
  const last = closes.at(-1), prev = closes.at(-2) ?? last
  return { ticker: t, source, dates, closes, last, prev, dayChg: prev ? last / prev - 1 : 0 }
}

export async function getMany(tickers, nowMs) {
  const uniq = [...new Set(tickers)]
  const out = new Map()
  // a few at a time — be polite to the data source
  for (let i = 0; i < uniq.length; i += 6) {
    const batch = await Promise.all(uniq.slice(i, i + 6).map(t => getSeries(t, nowMs).then(s => [t, s])))
    for (const [t, s] of batch) out.set(t, s)
  }
  return out
}

// ---------------------------------------------------------------------------
// small stats helpers shared by the desk's jobs
// ---------------------------------------------------------------------------
export const rets = c => c.slice(1).map((p, i) => p / c[i] - 1)
export const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
export const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) }
export const sma = (c, n) => (c.length >= n ? mean(c.slice(-n)) : null)
export const ret = (c, n) => (c.length > n ? c.at(-1) / c.at(-1 - n) - 1 : null)
export const annVol = (c, n = 20) => { const r = rets(c.slice(-(n + 1))); return sd(r) * Math.sqrt(252) }
export function rsi(c, n = 14) {
  if (c.length <= n) return null
  let g = 0, l = 0
  for (let i = c.length - n; i < c.length; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d }
  if (l === 0) return 100
  const rs = g / l
  return 100 - 100 / (1 + rs)
}
export function maxDrawdown(c) {
  let peak = -Infinity, mdd = 0
  for (const p of c) { peak = Math.max(peak, p); mdd = Math.min(mdd, p / peak - 1) }
  return mdd
}
