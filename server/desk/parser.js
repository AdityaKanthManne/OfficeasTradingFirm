/**
 * parser.js — turns a free-form portfolio into structured positions.
 *
 * Accepted shapes (mix and match, separated by commas, semicolons or newlines):
 *   AAPL 25%            → target weight
 *   AAPL:25  /  AAPL=25 → weight (when all bare numbers sum to ~100), otherwise shares
 *   AAPL 100sh @190     → 100 shares at $190
 *   AAPL 100 shares @190 cost 150   → with average cost (for P&L)
 *   AAPL $12,000        → dollar value
 *   CASH 10%  /  CASH $5000
 *
 * Optional mandate after a pipe:
 *   /portfolio AAPL 30%, MSFT 25%, TLT 20%, GLD 10%, BTC 5%, CASH 10% | moderate, 5y horizon, $250k, name: Bob Vance
 *
 * Also accepts JSON: { name, mandate, notional, positions: [{ ticker, weight|shares|value, price, cost }] }
 */

import { classify } from './classify.js'

const NUM = '(-?\\d[\\d,]*(?:\\.\\d+)?)'

function num(s) {
  if (s == null) return undefined
  const n = parseFloat(String(s).replace(/,/g, ''))
  return Number.isFinite(n) ? n : undefined
}

/** "$250k", "1.2m", "250,000" → number */
export function parseMoney(s) {
  const m = String(s).trim().match(/^\$?\s*(\d[\d,]*(?:\.\d+)?)\s*([kmb])?/i)
  if (!m) return undefined
  const base = num(m[1])
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] ?? 1
  return base != null ? base * mult : undefined
}

export function parseMandate(text = '') {
  const t = String(text).toLowerCase()
  let risk = 'moderate'
  if (/conservative|low risk|capital preservation|cautious/.test(t)) risk = 'conservative'
  else if (/aggressive|high risk|speculative|yolo/.test(t)) risk = 'aggressive'
  else if (/growth/.test(t)) risk = 'aggressive'
  else if (/income|retire/.test(t)) risk = 'conservative'

  const horizonM = t.match(/(\d+(?:\.\d+)?)\s*(?:-|\s)?(?:y|yr|yrs|year|years)\b/)
  const notionalM = String(text).match(/\$\s*\d[\d,]*(?:\.\d+)?\s*[kmb]?/i)
  const nameM = String(text).match(/(?:name|client|for)\s*[:=]\s*([^,;|]+)/i)
  const goals = []
  if (/income|dividend|yield/.test(t)) goals.push('income')
  if (/growth|appreciation/.test(t)) goals.push('growth')
  if (/preserv|safety|protect/.test(t)) goals.push('preservation')
  if (/esg|sustainab|ethical/.test(t)) goals.push('esg')
  if (/tax/.test(t)) goals.push('tax-aware')

  return {
    raw: String(text).trim(),
    risk,
    horizonYears: horizonM ? parseFloat(horizonM[1]) : undefined,
    notional: notionalM ? parseMoney(notionalM[0]) : undefined,
    clientName: nameM ? nameM[1].trim() : undefined,
    goals,
  }
}

/** Parse one "AAPL 100sh @190 cost 150" style chunk into a raw position. */
function parseChunk(chunk) {
  const s = chunk.trim()
  if (!s) return null
  const tickM = s.match(/^\$?([A-Za-z][A-Za-z0-9.\-]{0,11})\b\s*[:=]?\s*(.*)$/)
  if (!tickM) return { error: `Couldn't read "${s}"` }
  const ticker = tickM[1].toUpperCase().replace(/-USD$/, '')
  let rest = tickM[2] || ''
  const pos = { ticker, raw: s }

  const priceM = rest.match(new RegExp(`(?:@|at\\s+|price\\s*[:=]?\\s*)\\$?\\s*${NUM}`, 'i'))
  if (priceM) { pos.price = num(priceM[1]); rest = rest.replace(priceM[0], ' ') }
  const costM = rest.match(new RegExp(`(?:cost|avg|basis|bought(?:\\s+at)?)\\s*[:=]?\\s*\\$?\\s*${NUM}`, 'i'))
  if (costM) { pos.cost = num(costM[1]); rest = rest.replace(costM[0], ' ') }

  const pctM = rest.match(new RegExp(`${NUM}\\s*%`))
  const shM = rest.match(new RegExp(`${NUM}\\s*(?:sh|shs|shares?|units?|coins?)\\b`, 'i'))
  const dolM = rest.match(/\$\s*\d[\d,]*(?:\.\d+)?\s*[kmb]?\b/i)
  const bareM = rest.match(new RegExp(`(?:^|\\s)${NUM}(?:\\s|$)`))

  if (pctM) pos.weight = num(pctM[1])
  else if (shM) pos.shares = num(shM[1])
  else if (dolM) pos.value = parseMoney(dolM[0])
  else if (bareM) pos.bare = num(bareM[1])
  return pos
}

/**
 * Parse portfolio text into { positions, mandate, warnings }.
 * Positions are unpriced at this stage; analytics.js values them.
 */
export function parsePortfolioText(input) {
  const text = String(input || '').replace(/^\/(portfolio|desk|book)\b/i, '').trim()
  if (!text) return { positions: [], mandate: parseMandate(''), warnings: ['Empty portfolio'] }

  const [holdingsPart, ...mandateParts] = text.split('|')
  const mandate = parseMandate(mandateParts.join('|'))
  const warnings = []

  const chunks = holdingsPart.split(/[,;\n]+/).map(c => c.trim()).filter(Boolean)
  const raw = []
  for (const c of chunks) {
    const p = parseChunk(c)
    if (!p) continue
    if (p.error) { warnings.push(p.error); continue }
    raw.push(p)
  }

  // Bare numbers: weights if they sum to ~100 (or every other position is a weight), else shares.
  const bare = raw.filter(p => p.bare != null)
  if (bare.length) {
    const otherWeights = raw.filter(p => p.weight != null).reduce((s, p) => s + p.weight, 0)
    const bareSum = bare.reduce((s, p) => s + p.bare, 0)
    const looksLikeWeights = Math.abs(bareSum + otherWeights - 100) <= 5 ||
      (raw.every(p => p.bare != null || p.weight != null) && bareSum + otherWeights <= 100.5)
    for (const p of bare) {
      if (looksLikeWeights) p.weight = p.bare
      else p.shares = p.bare
      delete p.bare
    }
  }

  // Merge duplicate tickers
  const merged = new Map()
  for (const p of raw) {
    const prev = merged.get(p.ticker)
    if (!prev) { merged.set(p.ticker, { ...p }); continue }
    for (const k of ['weight', 'shares', 'value']) {
      if (p[k] != null) prev[k] = (prev[k] ?? 0) + p[k]
    }
    prev.price = prev.price ?? p.price
    prev.cost = prev.cost ?? p.cost
    warnings.push(`Merged duplicate ${p.ticker}`)
  }

  const positions = [...merged.values()].map(p => {
    const c = classify(p.ticker)
    if (!p.weight && !p.shares && !p.value) {
      warnings.push(`${p.ticker}: no size given — assuming equal weight`)
    }
    return { ticker: c.ticker, weight: p.weight, shares: p.shares, value: p.value, price: p.price, cost: p.cost, info: c }
  })

  return { positions, mandate, warnings }
}

/** Accept the JSON API shape too. */
export function parsePortfolioJson(body) {
  const mandate = parseMandate(body.mandate || '')
  if (body.notional) mandate.notional = parseMoney(body.notional) ?? mandate.notional
  if (body.name) mandate.clientName = body.name
  if (body.risk) mandate.risk = body.risk
  const warnings = []
  const positions = (body.positions || []).map(p => {
    const c = classify(p.ticker)
    return {
      ticker: c.ticker,
      weight: num(p.weight), shares: num(p.shares), value: num(p.value),
      price: num(p.price), cost: num(p.cost), info: c,
    }
  })
  if (!positions.length) warnings.push('No positions supplied')
  return { positions, mandate, warnings }
}

export const PORTFOLIO_HELP = [
  '📈 /portfolio usage:',
  '/portfolio AAPL 30%, MSFT 20%, TLT 20%, GLD 10%, BTC 5%, CASH 15%',
  '/portfolio NVDA 50sh @120 cost 45, AAPL 40sh @230, VOO $20k | aggressive, 10y, name: Bob Vance',
  'After the | : risk (conservative/moderate/aggressive), horizon, account size ($250k), client name.',
].join('\n')
