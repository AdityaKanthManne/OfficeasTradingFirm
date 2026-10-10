/**
 * analytics.js — the deterministic math behind the desk.
 *
 * Kevin "does" this math. The calculator is the one actually doing it, so the
 * numbers are right even when Kevin isn't.
 *
 * Risk figures use 1y of daily history when market data is available,
 * otherwise a simple constant-correlation model with per-asset vol guesses.
 */

import { equityBeta, rateShock, assumedCorrelation } from './classify.js'
import { fetchMany, alignedReturns } from './marketdata.js'

const DEFAULT_NOTIONAL = 100_000
const Z95 = 1.645
const round = (x, d = 2) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 10 ** d) / 10 ** d)

export const MANDATE_LIMITS = {
  conservative: { maxPosition: 10, maxSector: 25, maxSpec: 0,  cashMin: 5, cashMax: 25, maxEquityLike: 50 },
  moderate:     { maxPosition: 20, maxSector: 40, maxSpec: 5,  cashMin: 2, cashMax: 15, maxEquityLike: 80 },
  aggressive:   { maxPosition: 30, maxSector: 60, maxSpec: 15, cashMin: 0, cashMax: 10, maxEquityLike: 100 },
}

function sumBy(arr, f) { return arr.reduce((s, x) => s + (f(x) || 0), 0) }

function groupWeights(positions, key) {
  const m = {}
  for (const p of positions) m[p[key]] = (m[p[key]] || 0) + p.weight
  return Object.entries(m).map(([k, w]) => ({ name: k, weight: round(w, 2) })).sort((a, b) => b.weight - a.weight)
}

/**
 * Value the book. Mutates nothing; returns priced positions + total.
 */
function valuePositions(parsed, live) {
  const positions = parsed.positions.map(p => ({ ...p }))
  const warnings = []

  // Fill missing prices from live data
  for (const p of positions) {
    if (p.ticker === 'CASH') { p.price = 1; continue }
    const h = live?.get(p.ticker)
    if (p.price == null && h?.last) { p.price = round(h.last, 4); p.priceSource = 'live' }
    else if (p.price != null) p.priceSource = 'given'
  }

  // Dollar values where possible
  for (const p of positions) {
    if (p.value != null) continue
    if (p.shares != null && p.price != null) p.value = p.shares * p.price
    if (p.ticker === 'CASH' && p.shares != null) p.value = p.shares
  }

  const valued = positions.filter(p => p.value != null)
  const weighted = positions.filter(p => p.value == null && p.weight != null)
  const unsized = positions.filter(p => p.value == null && p.weight == null && p.shares == null)
  const unpriced = positions.filter(p => p.value == null && p.weight == null && p.shares != null)

  for (const p of unpriced) warnings.push(`${p.ticker}: ${p.shares} units but no price — add "@price" (sized at equal weight for now)`)

  const valuedSum = sumBy(valued, p => p.value)
  const weightSum = sumBy(weighted, p => p.weight)
  let notional = parsed.mandate.notional
  if (!notional) {
    if (valuedSum > 0 && weightSum > 0 && weightSum < 100) notional = valuedSum / (1 - weightSum / 100)
    else if (valuedSum > 0 && !weighted.length) notional = valuedSum
    else notional = DEFAULT_NOTIONAL
  }
  for (const p of weighted) p.value = (p.weight / 100) * notional

  // Equal-weight anything still unsized
  const leftovers = [...unsized, ...unpriced]
  if (leftovers.length) {
    const assigned = sumBy(positions.filter(p => p.value != null), p => p.value)
    const remaining = Math.max(notional - assigned, 0)
    const each = remaining > 0 ? remaining / leftovers.length : notional / (positions.length || 1)
    for (const p of leftovers) { p.value = each; p.sizedBy = 'equal-weight' }
  }

  // Weight-only books that don't add to 100: the gap becomes cash.
  if (!valued.length && weighted.length && !leftovers.length) {
    const ws = sumBy(positions, p => p.weight)
    if (ws < 99.5) {
      const cash = positions.find(p => p.ticker === 'CASH')
      const gap = ((100 - ws) / 100) * notional
      if (cash) cash.value += gap
      else positions.push({ ticker: 'CASH', value: gap, price: 1, info: { ticker: 'CASH', cls: 'cash', sector: 'Cash', name: 'Cash & equivalents', fund: true, vol: 0, known: true, duration: 0 } })
      warnings.push(`Weights summed to ${round(ws, 1)}% — the remaining ${round(100 - ws, 1)}% is treated as cash`)
    } else if (ws > 100.5) {
      warnings.push(`Weights summed to ${round(ws, 1)}% — rescaled to 100%`)
    }
  }

  const total = sumBy(positions, p => p.value)
  for (const p of positions) {
    p.weight = total > 0 ? (p.value / total) * 100 : 0
    if (p.shares == null && p.price && p.ticker !== 'CASH') p.shares = p.value / p.price
  }
  const usedDefaultNotional = !parsed.mandate.notional && !valued.length
  return { positions, total, warnings, usedDefaultNotional }
}

function historicalRisk(positions, live) {
  const risky = positions.filter(p => p.ticker !== 'CASH')
  if (!live || !risky.length || !risky.every(p => live.has(p.ticker))) return null
  const hist = new Map(risky.map(p => [p.ticker, live.get(p.ticker)]))
  if (live.has('SPY')) hist.set('__SPY', live.get('SPY'))
  const aligned = alignedReturns(hist)
  if (!aligned) return null
  const n = aligned.dates.length
  const w = Object.fromEntries(risky.map(p => [p.ticker, p.weight / 100]))
  const port = Array.from({ length: n }, (_, i) => sumBy(risky, p => w[p.ticker] * aligned.rets[p.ticker][i]))
  const mean = port.reduce((a, b) => a + b, 0) / n
  const sd = Math.sqrt(port.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1))

  let equity = 1, peak = 1, mdd = 0
  for (const r of port) { equity *= 1 + r; peak = Math.max(peak, equity); mdd = Math.min(mdd, equity / peak - 1) }

  const perAsset = {}
  for (const p of risky) {
    const r = aligned.rets[p.ticker]
    const m = r.reduce((a, b) => a + b, 0) / n
    const s = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1))
    const px = aligned.prices[p.ticker]
    perAsset[p.ticker] = { vol: s * Math.sqrt(252), ret1y: px.at(-1) / px[0] - 1 }
  }

  let beta
  const spy = aligned.rets.__SPY
  if (spy) {
    const ms = spy.reduce((a, b) => a + b, 0) / n
    const cov = port.reduce((a, r, i) => a + (r - mean) * (spy[i] - ms), 0) / (n - 1)
    const vs = spy.reduce((a, r) => a + (r - ms) ** 2, 0) / (n - 1)
    beta = vs > 0 ? cov / vs : undefined
  }

  // Pairwise correlation — report the highest pair (Oscar likes this)
  let topPair = null
  for (let i = 0; i < risky.length; i++) {
    for (let j = i + 1; j < risky.length; j++) {
      const a = aligned.rets[risky[i].ticker], b = aligned.rets[risky[j].ticker]
      const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n
      let c = 0, va = 0, vb = 0
      for (let k = 0; k < n; k++) { c += (a[k] - ma) * (b[k] - mb); va += (a[k] - ma) ** 2; vb += (b[k] - mb) ** 2 }
      const rho = c / Math.sqrt(va * vb)
      if (!topPair || rho > topPair.rho) topPair = { a: risky[i].ticker, b: risky[j].ticker, rho: round(rho, 2) }
    }
  }

  const cumulative = port.reduce((acc, r) => acc * (1 + r), 1) - 1
  return { vol: sd * Math.sqrt(252), maxDrawdown: mdd, beta, perAsset, topPair, days: n, ret1y: cumulative }
}

function modelRisk(positions) {
  const risky = positions.filter(p => p.ticker !== 'CASH')
  let v = 0
  for (const a of risky) for (const b of risky) {
    v += (a.weight / 100) * (b.weight / 100) * a.info.vol * b.info.vol * assumedCorrelation(a.info, b.info)
  }
  let topPair = null
  for (let i = 0; i < risky.length; i++) for (let j = i + 1; j < risky.length; j++) {
    const rho = assumedCorrelation(risky[i].info, risky[j].info)
    if (!topPair || rho > topPair.rho) topPair = { a: risky[i].ticker, b: risky[j].ticker, rho }
  }
  const beta = sumBy(positions, p => (p.weight / 100) * equityBeta(p.info))
  return { vol: Math.sqrt(Math.max(v, 0)), beta, topPair }
}

function mandateChecks(positions, byClass, bySector, limits, risk) {
  const checks = []
  const singles = positions.filter(p => !p.info.fund && p.ticker !== 'CASH')
  const biggest = singles.slice().sort((a, b) => b.weight - a.weight)[0]
  checks.push({
    id: 'max-position', rule: `Single-name position ≤ ${limits.maxPosition}%`,
    limit: limits.maxPosition, actual: round(biggest?.weight ?? 0, 1),
    pass: !biggest || biggest.weight <= limits.maxPosition + 0.05,
    detail: singles.filter(p => p.weight > limits.maxPosition + 0.05).map(p => `${p.ticker} ${round(p.weight, 1)}%`).join(', ') || 'none',
    note: 'Diversified funds/ETFs are exempt (policy 4.2(b)).',
  })
  const realSectors = bySector.filter(s => !['Broad Market', 'Cash', 'Unclassified', 'Aggregate Bonds', 'T-Bills'].includes(s.name))
  const topSector = realSectors[0]
  checks.push({
    id: 'max-sector', rule: `Any one sector ≤ ${limits.maxSector}%`, limit: limits.maxSector,
    actual: round(topSector?.weight ?? 0, 1), pass: !topSector || topSector.weight <= limits.maxSector + 0.05,
    detail: topSector ? `${topSector.name} ${round(topSector.weight, 1)}%` : 'n/a',
  })
  const spec = sumBy(positions.filter(p => p.info.spec || p.info.cls === 'crypto'), p => p.weight)
  checks.push({
    id: 'max-spec', rule: `Crypto & speculative ≤ ${limits.maxSpec}%`, limit: limits.maxSpec,
    actual: round(spec, 1), pass: spec <= limits.maxSpec + 0.05,
    detail: positions.filter(p => p.info.spec || p.info.cls === 'crypto').map(p => `${p.ticker} ${round(p.weight, 1)}%`).join(', ') || 'none',
  })
  const cash = byClass.find(c => c.name === 'cash')?.weight ?? 0
  checks.push({
    id: 'cash-band', rule: `Cash between ${limits.cashMin}% and ${limits.cashMax}%`, limit: `${limits.cashMin}–${limits.cashMax}`,
    actual: round(cash, 1), pass: cash >= limits.cashMin - 0.05 && cash <= limits.cashMax + 0.05, detail: `${round(cash, 1)}% cash`,
  })
  const eqLike = sumBy(positions.filter(p => ['equity', 'crypto', 'realestate'].includes(p.info.cls)), p => p.weight)
  checks.push({
    id: 'equity-like', rule: `Equity-like risk assets ≤ ${limits.maxEquityLike}%`, limit: limits.maxEquityLike,
    actual: round(eqLike, 1), pass: eqLike <= limits.maxEquityLike + 0.05, detail: `${round(eqLike, 1)}% in equities/REITs/crypto`,
  })
  checks.push({
    id: 'min-holdings', rule: 'At least 5 holdings (or a diversified fund)', limit: 5,
    actual: positions.filter(p => p.ticker !== 'CASH').length,
    pass: positions.filter(p => p.ticker !== 'CASH').length >= 5 || positions.some(p => p.info.fund && p.info.cls !== 'cash' && p.weight >= 20),
    detail: `${positions.filter(p => p.ticker !== 'CASH').length} non-cash holdings`,
  })
  void risk
  return checks
}

/**
 * Deterministic baseline rebalance that fixes mandate breaches.
 * Jim (the LLM) starts from this and may adjust it; final weights are re-validated.
 */
export function baselineRebalance(positions, limits, risk) {
  const tgt = new Map(positions.map(p => [p.ticker, p.weight]))
  const info = new Map(positions.map(p => [p.ticker, p.info]))
  const notes = []
  // Freed-up weight is tracked by where it came from so we can recycle it like-for-like:
  // equity risk stays equity risk (into a broad fund), speculative/idle money goes defensive or core.
  let eqPool = 0, defPool = 0, idlePool = 0

  const trim = (t, newW) => { const w = tgt.get(t); tgt.set(t, newW); return w - newW }

  // 1. Single-name cap
  for (const t of [...tgt.keys()]) {
    const i = info.get(t)
    if (i.fund || t === 'CASH') continue
    const w = tgt.get(t)
    if (w > limits.maxPosition + 0.05) {
      const freed = trim(t, limits.maxPosition)
      if (i.cls === 'crypto' || i.spec) defPool += freed; else eqPool += freed
      notes.push(`${t}: ${round(w, 1)}% → ${limits.maxPosition}% (single-name limit)`)
    }
  }

  // 2. Speculative cap (scale proportionally)
  const specT = [...tgt.keys()].filter(t => info.get(t).spec || info.get(t).cls === 'crypto')
  const specW = sumBy(specT, t => tgt.get(t))
  if (specW > limits.maxSpec + 0.05) {
    const scale = specW > 0 ? limits.maxSpec / specW : 0
    for (const t of specT) defPool += trim(t, tgt.get(t) * scale)
    notes.push(`Crypto/speculative sleeve ${round(specW, 1)}% → ${limits.maxSpec}%`)
  }

  // 3. Sector cap (diversified broad funds don't count as a sector bet)
  const EXEMPT = ['Broad Market', 'Unclassified', 'Aggregate Bonds', 'T-Bills', 'Cash', 'International']
  const sectors = {}
  for (const [t, w] of tgt) { const s = info.get(t).sector; if (t !== 'CASH') sectors[s] = (sectors[s] || 0) + w }
  for (const [s, w] of Object.entries(sectors)) {
    if (EXEMPT.includes(s) || w <= limits.maxSector + 0.05) continue
    const scale = limits.maxSector / w
    for (const t of [...tgt.keys()]) if (info.get(t).sector === s) {
      const freed = trim(t, tgt.get(t) * scale)
      if (['equity', 'realestate'].includes(info.get(t).cls)) eqPool += freed; else defPool += freed
    }
    notes.push(`${s} sector ${round(w, 1)}% → ${limits.maxSector}%`)
  }

  // 4. Cash band
  let cash = tgt.get('CASH') ?? 0
  if (cash > limits.cashMax + 0.05) {
    idlePool += cash - limits.cashMax
    notes.push(`Cash ${round(cash, 1)}% → ${limits.cashMax}% (put idle cash to work)`)
    cash = limits.cashMax
  }
  let needCash = Math.max(limits.cashMin - cash, 0)
  for (const k of ['defPool', 'eqPool']) {
    const avail = k === 'defPool' ? defPool : eqPool
    const take = Math.min(needCash, avail)
    if (take > 0) { cash += take; needCash -= take; if (k === 'defPool') defPool -= take; else eqPool -= take }
  }
  if (needCash > 0.05) {
    const others = [...tgt.keys()].filter(t => t !== 'CASH')
    const ow = sumBy(others, t => tgt.get(t))
    for (const t of others) tgt.set(t, tgt.get(t) * (1 - needCash / ow))
    cash += needCash
  }
  if (cash > (tgt.get('CASH') ?? 0) + 0.05) notes.push(`Raised cash to the ${limits.cashMin}% floor`)
  tgt.set('CASH', cash)
  if (!info.has('CASH')) info.set('CASH', { ticker: 'CASH', cls: 'cash', sector: 'Cash', name: 'Cash & equivalents', fund: true, vol: 0, known: true, duration: 0 })

  // 5. Recycle like-for-like
  const isBroadEq = t => { const i = info.get(t); return i.fund && !i.spec && i.cls === 'equity' && ['Broad Market', 'International', 'Dividend'].includes(i.sector) }
  const isBondFund = t => { const i = info.get(t); return i.fund && i.cls === 'bond' }
  const ADD = {
    VTI: { cls: 'equity', sector: 'Broad Market', name: 'Vanguard Total Market ETF', fund: true, vol: 0.17 },
    BND: { cls: 'bond', sector: 'Aggregate Bonds', name: 'Vanguard Total Bond ETF', fund: true, vol: 0.06, duration: 6 },
  }
  const sendTo = (amount, pickFn, fallback, label) => {
    if (amount <= 0.05) return
    let targets = [...tgt.keys()].filter(pickFn)
    if (!targets.length) { tgt.set(fallback, 0); info.set(fallback, ADD[fallback]); targets = [fallback] }
    const tw = sumBy(targets, t => tgt.get(t))
    for (const t of targets) tgt.set(t, tgt.get(t) + amount * (tw > 0 ? tgt.get(t) / tw : 1 / targets.length))
    notes.push(`Recycled ${round(amount, 1)}% ${label} into ${targets.join(', ')}`)
  }
  sendTo(eqPool, isBroadEq, 'VTI', 'of trimmed equity risk')
  sendTo(defPool, isBondFund, risk === 'aggressive' ? 'VTI' : 'BND', 'of trimmed speculative risk')
  if (idlePool > 0.05) {
    if (risk === 'conservative') sendTo(idlePool, isBondFund, 'BND', 'of idle cash')
    else if (risk === 'aggressive') sendTo(idlePool, isBroadEq, 'VTI', 'of idle cash')
    else { sendTo(idlePool * 0.6, isBroadEq, 'VTI', 'of idle cash'); sendTo(idlePool * 0.4, isBondFund, 'BND', 'of idle cash') }
  }

  // 6. Equity-like cap (mostly bites on conservative mandates): shift the excess into bonds,
  //    taking it from broad equity funds first, then pro-rata from the remaining equity-like risk.
  const eqLikeT = () => [...tgt.keys()].filter(t => ['equity', 'crypto', 'realestate'].includes(info.get(t).cls))
  const eqLike = sumBy(eqLikeT(), t => tgt.get(t))
  if (eqLike > limits.maxEquityLike + 0.05) {
    let excess = eqLike - limits.maxEquityLike
    const moved = excess
    const funds = eqLikeT().filter(isBroadEq)
    for (const t of funds) { const take = Math.min(tgt.get(t), excess); tgt.set(t, tgt.get(t) - take); excess -= take }
    if (excess > 0.05) {
      const rest = eqLikeT().filter(t => tgt.get(t) > 0)
      const rw = sumBy(rest, t => tgt.get(t))
      for (const t of rest) tgt.set(t, tgt.get(t) * (1 - excess / rw))
    }
    for (const [t, w] of [...tgt.entries()]) if (w <= 0.01 && t !== 'CASH' && !positions.find(p => p.ticker === t)) tgt.delete(t)
    sendTo(moved, isBondFund, 'BND', 'from equities (equity-like cap)')
    notes.push(`Equity-like exposure ${round(eqLike, 1)}% → ${limits.maxEquityLike}%`)
  }

  const total = sumBy([...tgt.values()], w => w)
  const targets = [...tgt.entries()].map(([t, w]) => ({ ticker: t, target: round((w / total) * 100, 2), info: info.get(t) }))
    .sort((a, b) => b.target - a.target)
  return { targets, notes }
}

/** Build a trade list from current → target weights. */
export function buildTrades(book, targets) {
  const cur = new Map(book.positions.map(p => [p.ticker, p]))
  const trades = []
  for (const t of targets) {
    if (t.ticker === 'CASH') continue
    const p = cur.get(t.ticker)
    const from = p?.weight ?? 0
    const delta = t.target - from
    if (Math.abs(delta) < 0.5) continue
    const dollars = (delta / 100) * book.totalValue
    const price = p?.price
    trades.push({
      ticker: t.ticker,
      side: delta > 0 ? 'BUY' : 'SELL',
      fromWeight: round(from, 2), toWeight: round(t.target, 2),
      dollars: round(Math.abs(dollars), 0),
      shares: price ? round(Math.abs(dollars) / price, price > 1000 ? 4 : 2) : undefined,
      price,
    })
  }
  for (const p of book.positions) {
    if (p.ticker !== 'CASH' && !targets.find(t => t.ticker === p.ticker)) {
      trades.push({ ticker: p.ticker, side: 'SELL', fromWeight: round(p.weight, 2), toWeight: 0, dollars: round(p.value, 0), shares: p.shares ? round(p.shares, 4) : undefined, price: p.price })
    }
  }
  return trades.sort((a, b) => (a.side === b.side ? b.dollars - a.dollars : a.side === 'SELL' ? -1 : 1))
}

/**
 * Validate/normalise target weights coming back from an LLM.
 * Unknown tickers are allowed (new buys) but weights must be ≥0; the result is rescaled to 100.
 */
export function normaliseTargets(raw, book, classifyFn) {
  if (!Array.isArray(raw) || !raw.length) return null
  const out = new Map()
  for (const r of raw) {
    const t = String(r.ticker || '').toUpperCase().trim()
    const w = parseFloat(r.target_weight ?? r.target ?? r.weight)
    if (!t || !Number.isFinite(w) || w < 0) continue
    out.set(t === 'USD' ? 'CASH' : t, (out.get(t) || 0) + w)
  }
  const total = [...out.values()].reduce((a, b) => a + b, 0)
  if (total < 50 || total > 150) return null
  // Positions the LLM didn't mention are kept at their current weight
  for (const p of book.positions) if (!out.has(p.ticker)) out.set(p.ticker, p.weight)
  const sum = [...out.values()].reduce((a, b) => a + b, 0)
  return [...out.entries()].map(([t, w]) => ({ ticker: t, target: round((w / sum) * 100, 2), info: book.positions.find(p => p.ticker === t)?.info ?? classifyFn(t) }))
}

/**
 * Main entry: parsed portfolio → analysed "book".
 */
export async function analyseBook(parsed, { marketData = 'yahoo', id } = {}) {
  let live = null
  let dataSource = 'model'
  if (marketData !== 'off') {
    const tickers = [...new Set([...parsed.positions.map(p => p.ticker).filter(t => t !== 'CASH'), 'SPY'])]
    try { live = await fetchMany(tickers, { timeoutMs: 6000 }) } catch { live = null }
    if (live && live.size === 0) live = null
  }

  const { positions, total, warnings, usedDefaultNotional } = valuePositions(parsed, live)
  const warn = [...parsed.warnings, ...warnings]
  if (usedDefaultNotional) warn.push(`No account size given — using a $${DEFAULT_NOTIONAL.toLocaleString()} model notional`)

  const hist = historicalRisk(positions, live)
  if (hist) dataSource = 'historical'
  const model = modelRisk(positions)

  for (const p of positions) {
    p.name = p.info.name
    p.cls = p.info.cls
    p.sector = p.info.sector
    p.vol = round(hist?.perAsset[p.ticker]?.vol ?? p.info.vol, 3)
    p.ret1y = hist?.perAsset[p.ticker]?.ret1y != null ? round(hist.perAsset[p.ticker].ret1y * 100, 1) : undefined
    p.beta = round(equityBeta(p.info), 2)
    if (p.cost != null && p.price != null && p.shares != null && p.ticker !== 'CASH') {
      p.costValue = p.cost * p.shares
      p.pnl = round(p.value - p.costValue, 0)
      p.pnlPct = round((p.price / p.cost - 1) * 100, 1)
    }
    p.value = round(p.value, 2)
    p.weight = round(p.weight, 2)
  }
  positions.sort((a, b) => b.weight - a.weight)

  const byClass = groupWeights(positions, 'cls')
  const bySector = groupWeights(positions, 'sector')
  const ws = positions.map(p => p.weight / 100)
  const hhi = ws.reduce((a, w) => a + w * w, 0)
  const nonCash = positions.filter(p => p.ticker !== 'CASH')

  const vol = hist?.vol ?? model.vol
  const equityShockPct = sumBy(positions, p => (p.weight / 100) * equityBeta(p.info) * -20)
  const rateShockPct = sumBy(positions, p => (p.weight / 100) * rateShock(p.info))
  const pnlPositions = positions.filter(p => p.pnl != null)

  const risk = MANDATE_LIMITS[parsed.mandate.risk] ? parsed.mandate.risk : 'moderate'
  const limits = MANDATE_LIMITS[risk]
  const checks = mandateChecks(positions, byClass, bySector, limits, risk)

  const book = {
    id,
    createdAt: new Date().toISOString(),
    clientName: parsed.mandate.clientName || 'House Account',
    mandate: { ...parsed.mandate, risk },
    limits,
    totalValue: round(total, 2),
    positions,
    byClass, bySector,
    concentration: {
      top1: round(nonCash[0]?.weight ?? 0, 2), top1Ticker: nonCash[0]?.ticker,
      top3: round(sumBy(nonCash.slice(0, 3), p => p.weight), 2),
      hhi: round(hhi, 4), effectiveN: round(hhi > 0 ? 1 / hhi : 0, 1),
      holdings: nonCash.length,
    },
    pnl: pnlPositions.length ? {
      total: round(sumBy(pnlPositions, p => p.pnl), 0),
      costBasis: round(sumBy(pnlPositions, p => p.costValue), 0),
      pct: round((sumBy(pnlPositions, p => p.pnl) / sumBy(pnlPositions, p => p.costValue)) * 100, 1),
      best: pnlPositions.slice().sort((a, b) => b.pnlPct - a.pnlPct)[0]?.ticker,
      worst: pnlPositions.slice().sort((a, b) => a.pnlPct - b.pnlPct)[0]?.ticker,
    } : null,
    risk: {
      source: dataSource,
      vol: round(vol * 100, 1),
      var95_1d: round(Z95 * vol / Math.sqrt(252) * total, 0),
      var95_1dPct: round(Z95 * vol / Math.sqrt(252) * 100, 2),
      beta: round(hist?.beta ?? model.beta, 2),
      maxDrawdown1y: hist ? round(hist.maxDrawdown * 100, 1) : undefined,
      return1y: hist ? round(hist.ret1y * 100, 1) : undefined,
      equityShock: { label: 'Equities −20%', pct: round(equityShockPct, 1), value: round(equityShockPct / 100 * total, 0) },
      rateShock: { label: 'Rates +100bp', pct: round(rateShockPct, 1), value: round(rateShockPct / 100 * total, 0) },
      topCorrelation: hist?.topPair ?? model.topPair,
    },
    checks,
    warnings: warn,
  }
  book.baseline = baselineRebalance(positions, limits, risk)
  book.baselineTrades = buildTrades(book, book.baseline.targets)
  return book
}

/**
 * Project any set of target weights through the same model + mandate checks,
 * so "before" and "after" are measured the same way.
 */
export function projectWeights(book, targets) {
  const positions = targets.filter(t => t.target > 0.001).map(t => ({
    ticker: t.ticker, weight: t.target, info: t.info, value: (t.target / 100) * book.totalValue,
  }))
  for (const p of positions) { p.cls = p.info.cls; p.sector = p.info.sector }
  positions.sort((a, b) => b.weight - a.weight)
  const byClass = groupWeights(positions, 'cls')
  const bySector = groupWeights(positions, 'sector')
  const m = modelRisk(positions)
  const checks = mandateChecks(positions, byClass, bySector, book.limits, book.mandate.risk)
  const singles = positions.filter(p => !p.info.fund && p.ticker !== 'CASH')
  const realSectors = bySector.filter(x => !['Broad Market', 'Cash', 'Unclassified', 'Aggregate Bonds', 'T-Bills'].includes(x.name))
  const hhi = positions.reduce((a, p) => a + (p.weight / 100) ** 2, 0)
  return {
    vol: round(m.vol * 100, 1),
    beta: round(m.beta, 2),
    equityShockPct: round(sumBy(positions, p => (p.weight / 100) * equityBeta(p.info) * -20), 1),
    rateShockPct: round(sumBy(positions, p => (p.weight / 100) * rateShock(p.info)), 1),
    largestSingle: singles[0] ? `${singles[0].ticker} ${round(singles[0].weight, 1)}%` : 'none',
    largestSector: realSectors[0] ? `${realSectors[0].name} ${round(realSectors[0].weight, 1)}%` : 'none',
    effectiveN: round(hhi > 0 ? 1 / hhi : 0, 1),
    checksPassed: checks.filter(c => c.pass).length,
    checksTotal: checks.length,
    failing: checks.filter(c => !c.pass).map(c => c.rule),
  }
}

/** Compact JSON for LLM prompts (keeps tokens down). */
export function bookForPrompt(book) {
  return {
    client: book.clientName,
    mandate: { risk: book.mandate.risk, horizonYears: book.mandate.horizonYears, goals: book.mandate.goals, notes: book.mandate.raw },
    limits: book.limits,
    totalValueUSD: book.totalValue,
    positions: book.positions.map(p => ({
      ticker: p.ticker, name: p.name, assetClass: p.cls, sector: p.sector, weightPct: p.weight, valueUSD: Math.round(p.value),
      price: p.price, cost: p.cost, pnlPct: p.pnlPct, volPct: p.vol != null ? Math.round(p.vol * 100) : undefined,
      return1yPct: p.ret1y, diversifiedFund: !!p.info.fund, speculative: !!p.info.spec, knownTicker: p.info.known,
    })),
    assetClassMix: book.byClass, sectorMix: book.bySector.slice(0, 8),
    concentration: book.concentration, pnl: book.pnl, risk: book.risk,
    mandateChecks: book.checks.map(c => ({ rule: c.rule, pass: c.pass, actual: c.actual, detail: c.detail })),
    baselineRebalance: { targets: book.baseline.targets.map(t => ({ ticker: t.ticker, targetPct: t.target })), notes: book.baseline.notes },
    dataNotes: book.warnings,
  }
}
