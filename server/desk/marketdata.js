/**
 * marketdata.js — optional 1-year daily price history from Yahoo Finance's
 * public chart endpoint. Unofficial and best-effort: every caller must cope
 * with `null`, in which case the desk falls back to model assumptions.
 *
 * Disable with  "marketData": "off"  in firm/desk.config.json.
 */

import { yahooSymbol } from './classify.js'
import { avKey, avDaily } from './alphavantage.js'

const UA = 'Mozilla/5.0 (DunderMifflinCapital desk; +https://github.com)'

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** → { symbol, last, series: Map<'YYYY-MM-DD', close> } | null
 *  A year of history from Yahoo (no daily cap); Alpha Vantage daily as the backup
 *  (its free plan returns ~100 days and only 25 calls a day — live quotes use it first). */
export async function fetchHistory(ticker, opts = {}) {
  const y = await fetchYahoo(ticker, opts)
  if (y) return y
  if (avKey()) return avDaily(ticker).catch(() => null)
  return null
}

async function fetchYahoo(ticker, { timeoutMs = 6000 } = {}) {
  const sym = yahooSymbol(ticker)
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`
  const data = await fetchJson(url, timeoutMs)
  const r = data?.chart?.result?.[0]
  if (!r?.timestamp || !r?.indicators?.quote?.[0]?.close) return null
  const closes = r.indicators.adjclose?.[0]?.adjclose ?? r.indicators.quote[0].close
  const series = new Map()
  r.timestamp.forEach((ts, i) => {
    const c = closes[i]
    if (c == null || !Number.isFinite(c)) return
    series.set(new Date(ts * 1000).toISOString().slice(0, 10), c)
  })
  if (series.size < 30) return null
  const last = r.meta?.regularMarketPrice ?? [...series.values()].at(-1)
  return { symbol: sym, last, series }
}

/** Fetch many tickers in parallel; returns Map<ticker, history> (missing = failed). */
export async function fetchMany(tickers, opts) {
  const out = new Map()
  const results = await Promise.all(tickers.map(t => fetchHistory(t, opts).then(h => [t, h])))
  for (const [t, h] of results) if (h) out.set(t, h)
  return out
}

/** Align histories on common dates and return daily simple returns per ticker. */
export function alignedReturns(histories) {
  const tickers = [...histories.keys()]
  if (!tickers.length) return null
  let dates = [...histories.get(tickers[0]).series.keys()]
  for (const t of tickers.slice(1)) {
    const s = histories.get(t).series
    dates = dates.filter(d => s.has(d))
  }
  dates.sort()
  if (dates.length < 40) return null
  const rets = {}
  for (const t of tickers) {
    const s = histories.get(t).series
    const px = dates.map(d => s.get(d))
    rets[t] = px.slice(1).map((p, i) => p / px[i] - 1)
  }
  return { dates: dates.slice(1), rets, prices: Object.fromEntries(tickers.map(t => [t, dates.map(d => histories.get(t).series.get(d))])) }
}
