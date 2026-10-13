/**
 * opsjobs.js — the numbers behind the firm's daily work.
 *
 *  · BOOKS        the portfolios each team runs (targets, PM, limits)
 *  · markBook     mark a book to market: NAV, day P&L, weights, drift
 *  · bookRisk     60-day vol, 1-day 95% VaR, beta to SPY, top weight, limit checks
 *  · riskCheck    Dwight's market indicators → regime (risk-on / neutral / risk-off)
 *  · alphaResearch Oscar & Karen's signal library, each one back-tested with a
 *                 rank information coefficient (IC), plus today's ranked ideas
 */

import { classify } from './classify.js'
import { rets, mean, sd, sma, ret, annVol, rsi } from './prices.js'

export const fmtPct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%`)
export const fmtUsd = (x, short = true) => {
  if (x == null || !Number.isFinite(x)) return '—'
  const s = x < 0 ? '-' : ''
  const a = Math.abs(x)
  if (short && a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`
  if (short && a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`
  if (short && a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}K`
  return `${s}$${a.toFixed(2)}`
}
export const fmtPx = x => (x == null ? '—' : x >= 1000 ? x.toLocaleString('en-US', { maximumFractionDigits: 0 }) : x.toFixed(2))

// ---------------------------------------------------------------------------
// Portfolio books — each team's book
// ---------------------------------------------------------------------------
export const BOOKS = [
  {
    id: 'flagship', name: 'DMC Flagship Multi-Asset', short: 'Flagship', pm: 'robert-california', team: ['jim-halpert', 'oscar-martinez'],
    nav: 250e6, limits: { single: 0.12, var: 0.02, drawdown: 0.10 },
    targets: { AAPL: 0.08, MSFT: 0.08, NVDA: 0.07, AMZN: 0.06, GOOGL: 0.05, JPM: 0.05, LLY: 0.05, XOM: 0.04, V: 0.04, SPY: 0.10, TLT: 0.12, GLD: 0.08, BTC: 0.03, CASH: 0.15 },
  },
  {
    id: 'income', name: 'Scranton Income Fund', short: 'Income', pm: 'stanley-hudson', team: ['angela-martin'],
    nav: 120e6, limits: { single: 0.12, var: 0.012, drawdown: 0.06 },
    targets: { TLT: 0.18, LQD: 0.18, HYG: 0.10, BND: 0.12, VZ: 0.07, KO: 0.08, JNJ: 0.08, PG: 0.08, O: 0.06, CASH: 0.05 },
  },
  {
    id: 'wealth', name: 'Vance Family Office (Private Wealth)', short: 'Private Wealth', pm: 'phyllis-vance', team: ['bob-vance'],
    nav: 40e6, limits: { single: 0.15, var: 0.012, drawdown: 0.07 },
    targets: { VTI: 0.32, BND: 0.30, MSFT: 0.08, PG: 0.08, JNJ: 0.06, GLD: 0.06, CASH: 0.10 },
  },
  {
    id: 'digital', name: 'Digital Assets & Algo', short: 'Digital', pm: 'ryan-howard', team: ['gabe-lewis'],
    nav: 15e6, limits: { single: 0.55, var: 0.07, drawdown: 0.30 },
    targets: { BTC: 0.45, ETH: 0.25, COIN: 0.10, MSTR: 0.08, CASH: 0.12 },
  },
  {
    id: 'real', name: 'Commodities & Real Assets', short: 'Real Assets', pm: 'meredith-palmer', team: ['carol-stills'],
    nav: 60e6, limits: { single: 0.15, var: 0.025, drawdown: 0.12 },
    targets: { GLD: 0.22, SLV: 0.08, USO: 0.14, XOM: 0.08, VNQ: 0.16, PLD: 0.10, O: 0.10, CASH: 0.12 },
  },
  {
    id: 'thematic', name: 'ESG & Thematic', short: 'Thematic', pm: 'nellie-bertram', team: ['karen-filippelli'],
    nav: 30e6, limits: { single: 0.18, var: 0.03, drawdown: 0.15 },
    targets: { NEE: 0.15, ICLN: 0.15, TSLA: 0.12, ENPH: 0.08, FSLR: 0.10, MSFT: 0.10, NVDA: 0.10, CASH: 0.20 },
  },
]
export const bookById = id => BOOKS.find(b => b.id === id)
export const bookTickers = () => [...new Set(BOOKS.flatMap(b => Object.keys(b.targets)))].filter(t => t !== 'CASH')

/** fresh positions at target weights */
export function initPositions(book, prices) {
  const pos = {}
  for (const [t, w] of Object.entries(book.targets)) {
    const px = t === 'CASH' ? 1 : prices.get(t)?.last
    if (!px) continue
    pos[t] = { shares: (book.nav * w) / px, cost: px }
  }
  return pos
}

/** book → mark: { nav, prevNav, dayPnl, dayRet, positions[], maxDrift, sources } */
export function markBook(book, positions, prices) {
  const rows = []
  let nav = 0, prevNav = 0
  const sources = new Set()
  for (const [t, p] of Object.entries(positions)) {
    // no price yet (feed still loading)? carry it at cost rather than dropping it from NAV
    const s = t === 'CASH' ? { last: 1, prev: 1, dayChg: 0, source: 'live' } : prices.get(t) ?? { last: p.cost, prev: p.cost, dayChg: 0, source: 'cost' }
    if (t !== 'CASH') sources.add(s.source)
    const value = p.shares * s.last, prevValue = p.shares * s.prev
    nav += value; prevNav += prevValue
    rows.push({ ticker: t, name: t === 'CASH' ? 'Cash' : classify(t).name, shares: p.shares, px: s.last, cost: p.cost, value, prevValue, dayChg: s.dayChg, dayPnl: value - prevValue, upnl: (s.last - p.cost) * p.shares, source: s.source })
  }
  for (const r of rows) {
    r.weight = nav ? r.value / nav : 0
    r.target = book.targets[r.ticker] ?? 0
    r.drift = r.weight - r.target
  }
  rows.sort((a, b) => b.value - a.value)
  const maxDrift = rows.reduce((m, r) => (Math.abs(r.drift) > Math.abs(m.drift) ? r : m), { drift: 0 })
  return { id: book.id, name: book.name, short: book.short, pm: book.pm, nav, prevNav, dayPnl: nav - prevNav, dayRet: prevNav ? nav / prevNav - 1 : 0, positions: rows, maxDrift, sources: [...sources] }
}

/** rebalance back to target: trades[] at current prices */
export function rebalanceTrades(book, mark, threshold = 0.01) {
  const trades = []
  for (const r of mark.positions) {
    if (r.ticker === 'CASH') continue
    const want = mark.nav * r.target
    const diff = want - r.value
    if (Math.abs(diff) / mark.nav < threshold) continue
    trades.push({ ticker: r.ticker, side: diff > 0 ? 'BUY' : 'SELL', notional: Math.abs(diff), shares: Math.abs(diff) / r.px, px: r.px, from: r.weight, to: r.target })
  }
  return trades.sort((a, b) => b.notional - a.notional)
}

// ---------------------------------------------------------------------------
// Book risk
// ---------------------------------------------------------------------------
export function bookRisk(book, mark, prices, peakNav) {
  const N = 60
  const spy = prices.get('SPY')
  const spyR = spy ? rets(spy.closes.slice(-(N + 1))) : []
  const port = new Array(N).fill(0)
  for (const r of mark.positions) {
    if (r.ticker === 'CASH') continue
    const s = prices.get(r.ticker)
    if (!s) continue
    const rr = rets(s.closes.slice(-(N + 1)))
    for (let i = 0; i < N; i++) port[i] += r.weight * (rr[rr.length - N + i] ?? 0)
  }
  const sdd = sd(port)
  const cov = spyR.length === N ? mean(port.map((x, i) => (x - mean(port)) * (spyR[i] - mean(spyR)))) : 0
  const beta = spyR.length === N && sd(spyR) ? cov / (sd(spyR) ** 2) : null
  const var95 = 1.645 * sdd * mark.nav
  const nonFund = mark.positions.filter(r => r.ticker !== 'CASH' && !classify(r.ticker).fund)
  const top = nonFund[0] ?? null
  const dd = peakNav ? mark.nav / peakNav - 1 : 0
  const breaches = []
  if (top && top.weight > book.limits.single) breaches.push({ kind: 'single', ticker: top.ticker, value: top.weight, limit: book.limits.single, text: `${top.ticker} is ${(top.weight * 100).toFixed(1)}% of the book (limit ${(book.limits.single * 100).toFixed(0)}%)` })
  if (var95 / mark.nav > book.limits.var) breaches.push({ kind: 'var', value: var95 / mark.nav, limit: book.limits.var, text: `1-day 95% VaR is ${(var95 / mark.nav * 100).toFixed(2)}% of NAV (limit ${(book.limits.var * 100).toFixed(1)}%)` })
  if (-dd > book.limits.drawdown) breaches.push({ kind: 'drawdown', value: dd, limit: book.limits.drawdown, text: `book is ${fmtPct(dd)} off its high (stop at -${(book.limits.drawdown * 100).toFixed(0)}%)` })
  const cash = mark.positions.find(r => r.ticker === 'CASH')
  return { vol: sdd * Math.sqrt(252), var95, varPct: var95 / mark.nav, beta, top: top ? { ticker: top.ticker, weight: top.weight } : null, drawdown: dd, cash: cash?.weight ?? 0, breaches }
}

// ---------------------------------------------------------------------------
// Dwight's market indicators
// ---------------------------------------------------------------------------
export const INDICATORS = [
  { t: 'SPY', name: 'S&P 500', what: 'trend' },
  { t: 'QQQ', name: 'Nasdaq 100', what: 'trend' },
  { t: 'IWM', name: 'Russell 2000', what: 'breadth' },
  { t: '^VIX', name: 'VIX', what: 'fear' },
  { t: 'TLT', name: '20Y+ Treasuries', what: 'rates' },
  { t: 'HYG', name: 'High-yield credit', what: 'credit' },
  { t: 'LQD', name: 'IG credit', what: 'credit' },
  { t: 'GLD', name: 'Gold', what: 'haven' },
  { t: 'UUP', name: 'US dollar', what: 'dollar' },
  { t: 'USO', name: 'Crude oil', what: 'oil' },
  { t: 'BTC', name: 'Bitcoin', what: 'speculation' },
]

export function riskCheck(prices) {
  const g = t => prices.get(t)
  const row = (ind) => {
    const s = g(ind.t)
    if (!s) return null
    const c = s.closes
    const ma50 = sma(c, 50), ma200 = sma(c, Math.min(200, c.length - 1))
    return { ...ind, last: s.last, dayChg: s.dayChg, m1: ret(c, 21), vs50: ma50 ? s.last / ma50 - 1 : null, vs200: ma200 ? s.last / ma200 - 1 : null, vol20: annVol(c, 20), vol1y: annVol(c, Math.min(250, c.length - 2)), offHigh: s.last / Math.max(...c.slice(-252)) - 1, source: s.source, status: 'ok', note: '' }
  }
  const rows = INDICATORS.map(row).filter(Boolean)
  const by = Object.fromEntries(rows.map(r => [r.t, r]))
  let score = 0
  const notes = []
  const flag = (r, status, note, pts) => { if (!r) return; r.status = status; r.note = note; score += pts; notes.push({ t: r.t, status, note }) }

  const spy = by.SPY
  if (spy) {
    if (spy.vs200 > 0 && spy.vs50 > 0) flag(spy, 'ok', 'above its 50- and 200-day — uptrend intact', 1)
    else if (spy.vs200 > 0) flag(spy, 'watch', 'below the 50-day, still above the 200-day', 0)
    else flag(spy, 'alert', 'below the 200-day moving average — trend broken', -2)
    if (spy.dayChg < -0.02) { flag(spy, 'alert', `down ${fmtPct(spy.dayChg)} today`, -1) }
    if (spy.vol20 > spy.vol1y * 1.4) notes.push({ t: 'SPY', status: 'watch', note: `realized vol ${(spy.vol20 * 100).toFixed(0)}% vs ${(spy.vol1y * 100).toFixed(0)}% 1-yr average` })
  }
  const q = by.QQQ
  if (q) q.vs200 > 0 ? flag(q, 'ok', 'tech leadership holding', 0.5) : flag(q, 'alert', 'tech below its 200-day', -1)
  const vix = by['^VIX']
  if (vix) {
    if (vix.last < 15) flag(vix, 'ok', `${vix.last.toFixed(1)} — calm`, 1)
    else if (vix.last < 20) flag(vix, 'ok', `${vix.last.toFixed(1)} — normal`, 0)
    else if (vix.last < 28) flag(vix, 'watch', `${vix.last.toFixed(1)} — elevated`, -1)
    else flag(vix, 'alert', `${vix.last.toFixed(1)} — stress`, -2)
    if (vix.dayChg > 0.15) flag(vix, 'alert', `spiked ${fmtPct(vix.dayChg, 0)} today`, -1)
  }
  if (by.HYG && by.LQD && by.HYG.m1 != null && by.LQD.m1 != null) {
    const rel = by.HYG.m1 - by.LQD.m1
    rel >= -0.005 ? flag(by.HYG, 'ok', `junk keeping up with IG (${fmtPct(rel)} 1m) — credit calm`, 0.5) : flag(by.HYG, 'alert', `junk lagging IG by ${fmtPct(rel)} over a month — credit spreads widening`, -1.5)
  }
  if (by.IWM && spy && by.IWM.m1 != null && spy.m1 != null) {
    const rel = by.IWM.m1 - spy.m1
    rel > -0.02 ? flag(by.IWM, 'ok', `small caps participating (${fmtPct(rel)} vs SPY, 1m)`, 0.5) : flag(by.IWM, 'watch', `small caps lagging SPY by ${fmtPct(rel)} — narrow market`, -0.5)
  }
  if (by.TLT && by.TLT.m1 != null) {
    if (by.TLT.m1 < -0.04) flag(by.TLT, 'watch', `long bonds ${fmtPct(by.TLT.m1)} in a month — yields rising fast`, -0.5)
    else if (by.TLT.m1 > 0.04 && spy?.m1 < 0) flag(by.TLT, 'watch', 'flight to quality into Treasuries', -0.5)
    else flag(by.TLT, 'ok', `${fmtPct(by.TLT.m1)} 1m — rates orderly`, 0)
  }
  if (by.UUP && by.UUP.m1 > 0.025) flag(by.UUP, 'watch', `dollar ${fmtPct(by.UUP.m1)} in a month — tightening financial conditions`, -0.5)
  else if (by.UUP) flag(by.UUP, 'ok', 'dollar steady', 0)
  if (by.GLD && by.GLD.m1 > 0.06 && spy?.m1 < 0) flag(by.GLD, 'watch', 'gold bid while stocks fall — havens in demand', -0.5)
  else if (by.GLD) flag(by.GLD, 'ok', `${fmtPct(by.GLD.m1)} 1m`, 0)
  if (by.USO && Math.abs(by.USO.dayChg) > 0.04) flag(by.USO, 'watch', `oil ${fmtPct(by.USO.dayChg)} today`, -0.25)
  else if (by.USO) flag(by.USO, 'ok', `${fmtPct(by.USO.m1)} 1m`, 0)
  if (by.BTC && by.BTC.dayChg < -0.07) flag(by.BTC, 'alert', `bitcoin ${fmtPct(by.BTC.dayChg)} today — speculative unwind`, -0.5)
  else if (by.BTC) flag(by.BTC, 'ok', `${fmtPct(by.BTC.m1)} 1m`, 0)

  const regime = score >= 1.5 ? 'RISK-ON' : score <= -2 ? 'RISK-OFF' : 'NEUTRAL'
  const sources = [...new Set(rows.map(r => r.source))]
  return { regime, score: Math.round(score * 10) / 10, rows, notes, sources }
}

// ---------------------------------------------------------------------------
// Alpha research — signal library with a quick back-test of each
// ---------------------------------------------------------------------------
export const UNIVERSE = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'AMD', 'NFLX', 'JPM', 'BAC', 'GS', 'V', 'MA', 'LLY', 'UNH', 'JNJ', 'PFE', 'XOM', 'CVX', 'KO', 'PG', 'WMT', 'COST', 'HD', 'MCD', 'DIS', 'CAT', 'BA', 'NEE', 'VZ', 'COIN', 'PLTR', 'O', 'PLD']

export const SIGNALS = [
  { id: 'mom', name: 'Momentum (6-1 mo)', owner: 'oscar-martinez', look: 127, f: c => c.at(-22) / c.at(-127) - 1, why: v => `${fmtPct(v, 0)} from 6 months ago to last month` },
  { id: 'trend', name: 'Trend (vs 100-day avg)', owner: 'oscar-martinez', look: 101, f: c => c.at(-1) / mean(c.slice(-100)) - 1, why: v => `${fmtPct(v, 1)} vs its 100-day average` },
  { id: 'high', name: 'Near 6-month high', owner: 'oscar-martinez', look: 120, f: c => c.at(-1) / Math.max(...c.slice(-120)) - 1, why: v => (v > -0.02 ? 'at its 6-month high' : `${fmtPct(v, 0)} below its 6-month high`) },
  { id: 'rev', name: 'Short-term reversal (5d)', owner: 'karen-filippelli', look: 6, f: c => -(c.at(-1) / c.at(-6) - 1), why: v => `${fmtPct(-v, 1)} over the past week` },
  { id: 'lowvol', name: 'Low volatility (60d)', owner: 'karen-filippelli', look: 61, f: c => -sd(rets(c.slice(-61))) * Math.sqrt(252), why: v => `${(-v * 100).toFixed(0)}% annualised vol` },
  { id: 'rsi', name: 'RSI mean reversion (14d)', owner: 'karen-filippelli', look: 15, f: c => 50 - (rsi(c, 14) ?? 50), why: v => `RSI ${(50 - v).toFixed(0)}` },
]

function rank(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0])
  const r = new Array(a.length)
  idx.forEach(([, i], k) => { r[i] = k })
  return r
}
function spearman(a, b) {
  const ra = rank(a), rb = rank(b)
  const ma = mean(ra), mb = mean(rb)
  let num = 0, da = 0, db = 0
  for (let i = 0; i < a.length; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2 }
  return da && db ? num / Math.sqrt(da * db) : 0
}
const zscores = a => { const m = mean(a), s = sd(a) || 1; return a.map(x => (x - m) / s) }

export function alphaResearch(prices) {
  const names = UNIVERSE.filter(t => prices.get(t)?.closes?.length >= 200)
  const series = names.map(t => prices.get(t).closes)
  const L = Math.min(...series.map(c => c.length))
  const H = 21                              // forward horizon: one month
  const stats = []
  for (const sig of SIGNALS) {
    const ics = []
    for (let end = L - H; end >= sig.look + 1 && ics.length < 40; end -= 5) {
      const vals = [], fwd = []
      for (const c0 of series) {
        const c = c0.slice(c0.length - L)
        const hist = c.slice(0, end)
        vals.push(sig.f(hist))
        fwd.push(c[end - 1 + H] / c[end - 1] - 1)
      }
      if (vals.every(Number.isFinite)) ics.push(spearman(vals, fwd))
    }
    const m = mean(ics), s = sd(ics)
    const t = s ? (m / s) * Math.sqrt(ics.length) : 0
    const hit = ics.length ? ics.filter(x => x > 0).length / ics.length : 0
    const verdict = m > 0.03 && t > 1.0 ? 'use' : m < -0.03 && t < -1.0 ? 'flip' : 'weak'
    stats.push({ id: sig.id, name: sig.name, owner: sig.owner, ic: m, icT: t, hit, n: ics.length, verdict })
  }
  // today's signal values, cross-sectional z-scores
  const today = SIGNALS.map(sig => series.map(c => sig.f(c)))
  const z = today.map(zscores)
  let usable = stats.filter(s => s.verdict === 'use' || s.verdict === 'flip')
  const fallback = !usable.length
  if (fallback) usable = [...stats].sort((a, b) => Math.abs(b.icT) - Math.abs(a.icT)).slice(0, 2)
  const weight = st => Math.sign(st.ic || 1) * Math.min(3, Math.max(0.5, Math.abs(st.icT)))
  const wsum = usable.reduce((s, st) => s + Math.abs(weight(st)), 0) || 1
  const ranked = names.map((t, i) => {
    let comp = 0
    const parts = []
    for (const st of usable) {
      const k = SIGNALS.findIndex(s => s.id === st.id)
      comp += (z[k][i] * weight(st)) / wsum
      parts.push({ id: st.id, name: st.name, z: z[k][i], raw: today[k][i] })
    }
    const s = prices.get(t)
    return { ticker: t, name: classify(t).name, sector: classify(t).sector, score: comp, parts, px: s.last, dayChg: s.dayChg, m1: ret(s.closes, 21), source: s.source }
  }).sort((a, b) => b.score - a.score)
  const sources = [...new Set(names.map(t => prices.get(t).source))]
  return { stats, ranked, longs: ranked.slice(0, 5), avoid: ranked.slice(-5).reverse(), universe: names.length, fallback, sources, horizon: H }
}

export function ideaWhy(idea) {
  const top = [...idea.parts].sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 2)
  return top.map(p => SIGNALS.find(s => s.id === p.id).why(p.raw)).join('; ')
}

export function sourceNote(sources) {
  if (!sources?.length) return ''
  if (sources.every(s => s === 'live')) return 'Prices: live daily closes (Yahoo Finance).'
  if (sources.includes('sim') && !sources.some(s => s.startsWith('live'))) return 'Prices: SIMULATED — the market data feed could not be reached, so these numbers are a stand-in, not real quotes.'
  if (sources.includes('sim')) return 'Prices: mostly live; some symbols SIMULATED where the feed failed.'
  return 'Prices: live history, carried forward with simulated days because the office clock is ahead of the real market.'
}
