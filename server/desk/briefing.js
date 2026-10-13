/**
 * briefing.js — the all-hands briefing.  `/briefing AAPL [question]`
 *
 * Michael calls everyone into the conference room, Jim runs the room, and the
 * other 25 give one take each from their own job's angle — branch by branch:
 * Trading & Risk → Research & Quant → Compliance & Finance → Operations &
 * Technology → Market Intelligence → Investment Committee. Jim wraps up with the
 * tally and the desk view, and Pam posts a report.
 *
 * Lines come from the Claude Code CLI when the desk LLM is on (one call per
 * branch, started up front so the room never waits long), otherwise from
 * built-in lines in each character's voice. Live numbers come from one year of
 * daily prices when market data is on; otherwise model estimates are used.
 */

import { mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { emp as empBySlug, empByRole, loadDeskConfig, FIRM } from './roster.js'
import { claudeAvailable, runClaude, extractJson } from './llm.js'
import { classify, equityBeta } from './classify.js'
import { fetchHistory } from './marketdata.js'
import { avKey, avQuote } from './alphavantage.js'
import { markdownToHtml, reportHtml } from './report.js'

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPORTS_DIR = join(PROJECT_DIR, 'reports')
const SERVER_URL = `http://127.0.0.1:${process.env.PORT || 3334}`
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pick = a => a[Math.floor(Math.random() * a.length)]
const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%`)
const pctAbs = (x, d = 0) => (x == null || !Number.isFinite(x) ? '—' : `${(Math.abs(x) * 100).toFixed(d)}%`)

/** The room, in the order your hierarchy goes. */
export const BRANCHES = [
  { id: 'trading-risk', name: 'Trading & Risk', slugs: ['dwight-schrute', 'stanley-hudson', 'phyllis-vance', 'andy-bernard'] },
  { id: 'research-quant', name: 'Research & Quant', slugs: ['oscar-martinez', 'karen-filippelli'] },
  { id: 'compliance-finance', name: 'Compliance & Finance', slugs: ['angela-martin', 'kevin-malone', 'toby-flenderson', 'holly-flax'] },
  { id: 'ops-tech', name: 'Operations & Technology', slugs: ['darryl-philbin', 'roy-anderson', 'gabe-lewis', 'erin-hannon', 'pam-beesly'] },
  { id: 'market-intel', name: 'Market Intelligence', slugs: ['kelly-kapoor', 'ryan-howard', 'creed-bratton', 'meredith-palmer', 'carol-stills', 'nellie-bertram'] },
  { id: 'committee', name: 'Investment Committee', slugs: ['david-wallace', 'robert-california', 'jan-levinson', 'bob-vance'] },
]

// ---------------------------------------------------------------------------
// Market snapshot
// ---------------------------------------------------------------------------
export async function snapshot(ticker, cfg) {
  const c = classify(ticker)
  const s = {
    ticker: c.ticker, name: c.name, cls: c.cls, sector: c.sector, known: c.known,
    source: 'model', px: null, r1y: null, r3m: null, vol: c.vol, mdd: null, beta: equityBeta(c),
    offHigh: null, hi: null, lo: null, above200: null, ma200: null,
  }
  if (cfg.marketData === 'off') return s
  const [h, spy, q] = await Promise.all([fetchHistory(c.ticker), fetchHistory('SPY'), avKey() ? avQuote(c.ticker).catch(() => null) : null])
  if (q?.price) { s.quote = q; s.px = q.price; s.dayChg = q.changePct }
  if (!h) return s
  const px = [...h.series.values()]
  const n = px.length
  const rets = px.slice(1).map((p, i) => p / px[i] - 1)
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1))
  let peak = px[0], mdd = 0
  for (const p of px) { peak = Math.max(peak, p); mdd = Math.min(mdd, p / peak - 1) }
  const hi = Math.max(...px), lo = Math.min(...px)
  const ma200 = px.slice(-200).reduce((a, b) => a + b, 0) / Math.min(200, n)
  s.source = 'historical'
  s.span = n >= 240 ? '1-year' : `${n}-day`
  s.px = s.quote?.price ?? h.last ?? px[n - 1]
  s.r1y = px[n - 1] / px[0] - 1
  s.r3m = n > 63 ? px[n - 1] / px[n - 64] - 1 : null
  s.vol = sd * Math.sqrt(252)
  s.mdd = mdd
  s.hi = hi
  s.lo = lo
  s.offHigh = px[n - 1] / hi - 1
  s.ma200 = ma200
  s.above200 = px[n - 1] >= ma200
  if (spy) {
    // beta vs SPY on common dates
    const dates = [...h.series.keys()].filter(d => spy.series.has(d))
    if (dates.length > 60) {
      const a = [], b = []
      for (let i = 1; i < dates.length; i++) {
        a.push(h.series.get(dates[i]) / h.series.get(dates[i - 1]) - 1)
        b.push(spy.series.get(dates[i]) / spy.series.get(dates[i - 1]) - 1)
      }
      const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length
      let cov = 0, vb = 0
      for (let i = 0; i < a.length; i++) { cov += (a[i] - ma) * (b[i] - mb); vb += (b[i] - mb) ** 2 }
      if (vb > 0) s.beta = cov / vb
    }
  }
  return s
}

function snapshotText(s) {
  if (s.source !== 'historical') {
    return `${s.ticker} (${s.name}, ${s.cls}/${s.sector}). No live prices — model estimates only: annualised vol ≈ ${pctAbs(s.vol)}, equity beta ≈ ${s.beta.toFixed(2)}.${s.known ? '' : ' Unknown ticker: treated as a single stock; classification is a guess.'}`
  }
  return `${s.ticker} (${s.name}, ${s.cls}/${s.sector}) — last ${s.px.toFixed(2)}${s.dayChg != null ? ` (${pct(s.dayChg)} today, Alpha Vantage)` : ''}; ${s.span} return ${pct(s.r1y)}; 3-month ${pct(s.r3m)}; ` +
    `annualised vol ${pctAbs(s.vol)}; max drawdown (1y) ${pct(s.mdd)}; beta vs SPY ${s.beta.toFixed(2)}; ` +
    `${pctAbs(s.offHigh)} below its 52-week high (${s.hi.toFixed(2)}), low ${s.lo.toFixed(2)}; ${s.above200 ? 'above' : 'below'} its 200-day average (${s.ma200.toFixed(2)}).`
}

// ---------------------------------------------------------------------------
// Built-in takes (no LLM) — every character's angle on one ticker
// ---------------------------------------------------------------------------
export function offlineTake(slug, s, q) {
  const T = s.ticker
  const live = s.source === 'historical'
  const up = live && (s.r1y ?? 0) > 0
  const trendUp = s.above200 === true && (s.r3m ?? 0) > 0
  const trendDn = s.above200 === false && (s.r3m ?? 0) < 0
  const hot = (s.vol ?? 0) > 0.3
  const sharpe = live && s.vol ? (s.r1y ?? 0) / s.vol : null
  const v = pctAbs(s.vol)
  const T_ = {
    'dwight-schrute': () => ({
      stance: hot || (s.mdd ?? 0) < -0.25 ? 'bearish' : 'neutral',
      line: live ? `FACT: ${T} has ${v} annualised vol and fell ${pctAbs(s.mdd)} peak to trough this year. Beta ${s.beta.toFixed(2)}. I have prepared a bunker.`
        : `FACT: a stock like ${T} carries about ${v} vol. That is a bear's natural habitat. Size it like a bear is watching.`,
      note: `Risk view: ${v} annualised volatility${live ? `, ${pct(s.mdd)} max drawdown over the year` : ' (model estimate)'}, beta ${s.beta.toFixed(2)}. Cap the position and pre-agree a stop/review level.`,
    }),
    'stanley-hudson': () => ({
      stance: s.cls === 'bond' ? 'bullish' : 'neutral',
      line: s.cls === 'bond' ? `${T}? Coupons. Duration. Finally, something I like.` : `${T} doesn't pay me enough to care. Wake me when it's a dividend story. Neutral.`,
      note: s.cls === 'bond' ? 'Income view: fits an income sleeve; watch duration.' : 'Income view: not an income holding — growth exposure, not yield. Keep income sleeves separate.',
    }),
    'phyllis-vance': () => ({
      stance: hot ? 'neutral' : 'bullish',
      line: hot ? `For my retirees, ${v} vol is a lot, dear. A small slice, not a meal.` : `My clients would be comfortable with ${T}. It's a sensible name to own.`,
      note: `Private wealth: suitability depends on the client; for conservative mandates keep it a modest weight given ${v} volatility.`,
    }),
    'andy-bernard': () => ({
      stance: up ? 'bullish' : 'neutral',
      line: live ? `Clients ask about ${T} more than they ask about my a cappella. ${pct(s.r1y)} this year — easy story to tell!` : `Clients LOVE hearing about ${T}. It's the lead tenor of the portfolio.`,
      note: `Client coverage: high client interest; ${live ? `1-year return ${pct(s.r1y)}` : 'performance data unavailable'}. Prepare talking points on risk as well as upside.`,
    }),
    'oscar-martinez': () => ({
      stance: trendUp ? 'bullish' : trendDn ? 'bearish' : 'neutral',
      line: live ? `Actually, ${T} is ${s.above200 ? 'above' : 'below'} its 200-day average and ${pct(s.r3m)} over three months. The data says ${trendUp ? 'the trend is intact' : trendDn ? 'the trend is broken' : "it's mixed"}.`
        : `Actually, without price data I won't pretend to have a quant signal. Get me the numbers.`,
      note: live ? `Quant: price ${s.above200 ? 'above' : 'below'} 200-day MA (${s.ma200.toFixed(2)}), 3-month momentum ${pct(s.r3m)}, 1-year ${pct(s.r1y)}; return/vol ≈ ${sharpe?.toFixed(2)}.` : 'Quant: no live data, so no momentum/trend signal.',
    }),
    'karen-filippelli': () => ({
      stance: live && (s.offHigh ?? 0) < -0.15 ? 'bullish' : 'neutral',
      line: live ? ((s.offHigh ?? 0) < -0.15 ? `It's ${pctAbs(s.offHigh)} off the 52-week high. Better entry than last quarter.` : `It's within ${pctAbs(s.offHigh)} of its high. Priced for perfection. I'd wait for earnings.`)
        : `I'd want to see the latest earnings before I put a rating on ${T}.`,
      note: live ? `Equity research: ${pctAbs(s.offHigh)} below the 52-week high (${s.hi.toFixed(2)}). Valuation work should anchor on the next earnings print.` : 'Equity research: rating pending fundamentals review.',
    }),
    'angela-martin': () => ({
      stance: 'neutral',
      line: `If we own ${T}, it stays under the single-name limit. I will be checking. Daily.`,
      note: 'Controller: any position must respect the single-name concentration limit in the mandate; reconcile after every trade.',
    }),
    'kevin-malone': () => ({
      stance: !live ? 'neutral' : up ? 'bullish' : 'bearish',
      line: live ? `$10,000 in ${T} ${s.span === '1-year' || !s.span ? 'a year' : s.span.replace('-day', ' trading days')} ago is $${Math.round(10000 * (1 + s.r1y)).toLocaleString()} now. ${up ? 'That is a lot of M&Ms.' : 'That is fewer M&Ms.'}` : `I can do the P&L when we have prices. Keleven is ready.`,
      note: live ? `P&L: $10,000 invested a year ago would be about $${Math.round(10000 * (1 + s.r1y)).toLocaleString()} today (${pct(s.r1y)}).` : 'P&L: awaiting prices.',
    }),
    'toby-flenderson': () => ({
      stance: 'neutral',
      line: `Just a reminder: this isn't investment advice, and personal trading in ${T} needs pre-clearance. Thanks. Sorry.`,
      note: 'Compliance: educational discussion only; staff personal trading requires pre-clearance; no MNPI.',
    }),
    'holly-flax': () => ({
      stance: 'neutral',
      line: `Love the energy, everyone! Quick culture note: no trading on rumors from Kelly's group chat.`,
      note: 'Conduct: decisions should rest on documented analysis, not social-media rumor.',
    }),
    'darryl-philbin': () => ({
      stance: 'neutral',
      line: `${T} settles T+1, Mike. Liquid name — we can move size without the street noticing.`,
      note: 'Operations: standard T+1 settlement; liquidity adequate for typical position sizes.',
    }),
    'roy-anderson': () => ({ stance: 'neutral', line: `Paperwork's fine. Big name, easy to settle.`, note: 'Settlement: no special handling expected.' }),
    'gabe-lewis': () => ({
      stance: 'neutral',
      line: `The OMS can route ${T} with a VWAP algo. Sabre approves. Please don't touch the settings.`,
      note: 'Trading systems: execute via algorithm (VWAP/TWAP) to limit market impact.',
    }),
    'erin-hannon': () => ({ stance: 'bullish', line: `I can take the order! Is it a buy? It sounds like a buy. I'll write it on my hand.`, note: 'Order intake: ready to ticket once the desk decides side and size.' }),
    'pam-beesly': () => ({
      stance: 'neutral',
      line: live ? `I'll make the client one-pager: ${T}, ${pct(s.r1y)} this year, ${v} vol. Clean and simple.` : `I'll make a one-pager on ${T} for clients — I just need the numbers.`,
      note: 'Client reporting: a one-page summary with return, volatility and the key risks.',
    }),
    'kelly-kapoor': () => {
      const r = s.r3m ?? 0
      return {
        stance: r > 0.08 ? 'bearish' : r < -0.08 ? 'bullish' : 'neutral',
        line: r > 0.08 ? `Oh my God, everyone online is SO bullish on ${T}. Like, too bullish. That's bad, right? Ryan says that's bad.`
          : r < -0.08 ? `People are being so mean about ${T} online. Honestly? That's when you buy. I read that.` : `The vibes on ${T} are... meh. Nobody's even fighting about it.`,
        note: `Sentiment: ${r > 0.08 ? 'crowded and euphoric (contrarian caution)' : r < -0.08 ? 'washed-out and negative (contrarian opportunity)' : 'neutral'}, proxied by recent price action.`,
      }
    },
    'ryan-howard': () => ({
      stance: trendUp ? 'bullish' : trendDn ? 'bearish' : 'neutral',
      line: `My algo says ${trendUp ? 'long' : trendDn ? 'short' : 'wait'}. Also we should tokenize ${T}. WUPHF.`,
      note: `Systematic: trend model ${trendUp ? 'long' : trendDn ? 'short/flat' : 'neutral'}.`,
    }),
    'creed-bratton': () => ({
      stance: 'bullish',
      line: `I bought ${T} in 1979. Or 1997. Either way, buy. Don't ask where I keep my shares.`,
      note: 'Special situations: no catalyst identified. (Creed\'s holding period cannot be verified.)',
    }),
    'meredith-palmer': () => ({
      stance: 'neutral',
      line: `Input costs look fine from where I sit. Oil's fine, I'm fine, ${T}'s fine.`,
      note: 'Commodities: no major input-cost pressure flagged for this name.',
    }),
    'carol-stills': () => ({ stance: 'neutral', line: `Not my asset class, Michael. But a balance sheet that strong could buy a lot of real estate.`, note: 'Real assets: no direct exposure; neutral.' }),
    'nellie-bertram': () => ({
      stance: 'bullish',
      line: `Thematically, ${s.sector} is terribly on-trend. I've decided its ESG score is excellent.`,
      note: `Thematic/ESG: fits ${s.sector} themes; formal ESG screening still required.`,
    }),
    'david-wallace': () => ({
      stance: 'neutral',
      line: `What I care about: does ${T} fit our strategy, and can we explain it to the board in one sentence?`,
      note: 'Chairman: position must fit the firm\'s stated strategy and be explainable to the board.',
    }),
    'robert-california': () => ({
      stance: sharpe == null ? 'neutral' : sharpe > 0.5 ? 'bullish' : sharpe < 0 ? 'bearish' : 'neutral',
      line: sharpe == null ? `The question is not price. The question is desire. What does ${T} want?`
        : `The question is not price, it's desire. ${T} returned ${sharpe.toFixed(2)} units of reward per unit of fear. ${sharpe > 0.5 ? 'I find that seductive.' : sharpe < 0 ? 'That is not desire. That is regret.' : 'Interesting. Not irresistible.'}`,
      note: sharpe == null ? 'CIO: decision deferred until return/risk data is available.' : `CIO: 1-year return/vol ≈ ${sharpe.toFixed(2)}.`,
    }),
    'jan-levinson': () => ({
      stance: s.beta > 1.2 ? 'bearish' : 'neutral',
      line: `With beta ${s.beta.toFixed(2)}, ${T} is a macro trade whether you like it or not. If rates stay high, size it carefully.`,
      note: `Macro: beta ${s.beta.toFixed(2)} vs the market — sensitive to rates and risk appetite.`,
    }),
    'bob-vance': () => ({
      stance: up ? 'bullish' : 'neutral',
      line: `Bob Vance, Vance Refrigeration. As your anchor LP: ${!live ? "show me the numbers first. Then keep it cold." : up ? "I like it. It's up. Keep it cold." : "It's down. Keep it cold and keep it small."}`,
      note: 'LP view: supportive if risk is controlled.',
    }),
  }
  const f = T_[slug]
  if (f) return f()
  const e = empBySlug(slug)
  return { stance: 'neutral', line: `${e?.catchphrases?.[0] ?? 'Interesting.'} I'll look at ${T} from my side.`, note: 'No view.' }
}

// ---------------------------------------------------------------------------

export function createBriefing({ broadcast, addMessage, staff }) {
  let running = null

  function say(e, text, extra = {}) {
    if (!e || !text) return
    const msg = addMessage({ sender: e.name, role: e.role, text: String(text).slice(0, 600) })
    broadcast({ type: 'chat_message', ...msg, talk: true, ...extra })
  }
  function system(text) {
    const msg = addMessage({ sender: 'system', text, isSystem: true })
    broadcast({ type: 'chat_message', ...msg, isSystem: true })
  }

  async function llmBranch(branch, s, question, cfg) {
    const people = branch.slugs.map(empBySlug).filter(Boolean)
    const prompt = `You are writing lines for an all-hands briefing at ${FIRM.fullName}, a parody trading firm staffed by the cast of "The Office" (Scranton). Michael Scott (Managing Partner) asked about ${s.ticker}${question ? `: "${question}"` : ''}. Jim Halpert is running the room.

MARKET SNAPSHOT (use only these numbers; don't invent prices, dates or news):
${snapshotText(s)}

Branch: ${branch.name}. Write one take for each person, from their own job's angle and fully in their voice:
${people.map(e => `- slug "${e.slug}": ${e.name}, ${e.title}. Job: ${e.deskDuty} Voice: ${e.voice}`).join('\n')}

Return ONLY JSON: {"takes":[{"slug":"...","stance":"bullish|neutral|bearish","line":"what they say out loud in the room — 1–2 sentences, max 240 characters, cite a snapshot number when it fits","note":"2–3 sentence professional note for the written report"}]}
This is educational parody, not investment advice.`
    try {
      const out = await runClaude(prompt, { model: cfg.model, timeoutSec: 120 })
      const j = extractJson(out)
      const takes = Array.isArray(j?.takes) ? j.takes : []
      const bySlug = new Map(takes.filter(t => t?.slug && t?.line).map(t => [t.slug, t]))
      return branch.slugs.map(slug => {
        const t = bySlug.get(slug)
        if (!t) return { slug, ...offlineTake(slug, s, question) }
        const stance = ['bullish', 'neutral', 'bearish'].includes(t.stance) ? t.stance : 'neutral'
        return { slug, stance, line: String(t.line).slice(0, 300), note: String(t.note ?? '').slice(0, 600) }
      })
    } catch {
      return branch.slugs.map(slug => ({ slug, ...offlineTake(slug, s, question) }))
    }
  }

  function offlineSummary(s, takes) {
    const n = k => takes.filter(t => t.stance === k).length
    const bull = n('bullish'), neu = n('neutral'), bear = n('bearish')
    const score = bull - bear
    const view = score >= 4 ? 'constructive' : score <= -3 ? 'cautious' : 'neutral — hold, don\'t chase'
    const risks = takes.filter(t => t.stance === 'bearish').map(t => empBySlug(t.slug)?.name.split(' ')[0]).filter(Boolean)
    const line = `Okay. ${bull} bullish, ${neu} neutral, ${bear} bearish. Desk view on ${s.ticker}: ${view}.` +
      (risks.length ? ` ${risks.slice(0, 3).join(', ')} flagged the risk${s.source === 'historical' ? ` — ${pctAbs(s.vol)} vol, ${pct(s.mdd)} drawdown` : ''}.` : '') +
      ` If we act, we scale in with limit orders and stay under the single-name limit.`
    return { bull, neu, bear, view, line }
  }

  async function llmSummary(s, takes, question, cfg) {
    const tally = offlineSummary(s, takes)
    const prompt = `You are Jim Halpert, Head of Execution Trading at ${FIRM.fullName} (parody of "The Office"). Dry, understated, competent. You just ran an all-hands briefing on ${s.ticker}${question ? ` (Michael asked: "${question}")` : ''}.
Snapshot: ${snapshotText(s)}
Tally: ${tally.bull} bullish, ${tally.neu} neutral, ${tally.bear} bearish.
Takes:
${takes.map(t => `- ${empBySlug(t.slug)?.name} (${t.stance}): ${t.line}`).join('\n')}
Wrap it up out loud for Michael: the tally, the one or two points that matter most, and the desk view with how you'd execute if we act. 2–4 sentences, under 90 words, only snapshot numbers. Reply with only what you say.`
    try {
      const out = await runClaude(prompt, { model: cfg.model, timeoutSec: 90 })
      return { ...tally, line: out.replace(/^["']|["']$/g, '').trim() || tally.line }
    } catch { return tally }
  }

  function run(tickerRaw, question = '') {
    if (running) return { ok: false, error: `A briefing on ${running} is already under way.` }
    const ticker = String(tickerRaw || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 12)
    if (!ticker) return { ok: false, error: 'Usage: /briefing AAPL [question]' }
    question = String(question || '').trim()
    if (question) {
      question = question[0].toUpperCase() + question.slice(1)
      if (!/[?.!]$/.test(question)) question += '?'
    }
    running = ticker
    const cfg = loadDeskConfig()
    const useLLM = cfg.llm === 'claude' && claudeAvailable()
    const pace = Math.max(1200, cfg.paceMs ?? 2200)
    const michael = empByRole('boss'), jim = empByRole('assistant')
    ;(async () => {
      try {
        say(michael, pick([
          `Everybody, conference room! All-hands briefing on ${ticker}.${question ? ` ${question}` : ''} Jim, run it. I'll... supervise.`,
          `Conference room, NOW. We're talking ${ticker}.${question ? ` ${question}` : ''} Everyone gets a turn. Even Toby. Briefly.`,
        ]))
        staff.assembleAll(`All-hands briefing: ${ticker}`)
        const s = await snapshot(ticker, cfg)
        // start every branch's lines now, so the room never waits
        const pending = BRANCHES.map(b => (useLLM ? llmBranch(b, s, question, cfg) : Promise.resolve(b.slugs.map(slug => ({ slug, ...offlineTake(slug, s, question) })))))
        await sleep(9000)  // let people find a seat
        say(jim, s.source === 'historical'
          ? `Okay — ${ticker}. Last ${s.px.toFixed(2)}${s.dayChg != null ? `, ${pct(s.dayChg)} today` : ''}, ${pct(s.r1y)} over ${s.span === '1-year' ? 'the year' : `${s.span}s`}. One take each, by branch. I'll pull it together at the end.`
          : `Okay — ${ticker}. No live prices today, so we're on model estimates. One take each, by branch. I'll wrap it up.`)
        await sleep(pace)
        const takes = []
        for (let i = 0; i < BRANCHES.length; i++) {
          const b = BRANCHES[i]
          const lines = await pending[i]
          system(`— ${b.name} —`)
          for (const t of lines) {
            const e = empBySlug(t.slug)
            if (!e) continue
            takes.push({ ...t, branch: b.name })
            const icon = t.stance === 'bullish' ? '🟢' : t.stance === 'bearish' ? '🔴' : '⚪'
            say(e, `${icon} ${t.line}`)
            await sleep(pace)
          }
        }
        const sum = useLLM ? await llmSummary(s, takes, question, cfg) : offlineSummary(s, takes)
        say(jim, sum.line)
        await sleep(pace)

        // report
        const d = new Date(), p2 = n => String(n).padStart(2, '0')
        const id = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}-briefing-${ticker.toLowerCase().replace(/[^a-z0-9]/g, '')}`
        const md = reportMarkdown(s, takes, sum, question)
        const dir = join(REPORTS_DIR, id)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'report.md'), md)
        writeFileSync(join(dir, 'report.html'), reportHtml(md, `${FIRM.name} — ${ticker} briefing`))
        say(empBySlug('pam-beesly'), `Briefing notes are up — every take, the tally and the numbers: ${SERVER_URL}/reports/${id}`)
        await sleep(pace)
        say(michael, pick(['Great meeting. Best meeting ever. Back to work, everybody!', 'And that is why I am the Managing Partner. Meeting adjourned!']))
        await sleep(6000)
        staff.endMeeting({ quiet: true })
      } catch (err) {
        console.error('[briefing] failed:', err)
        system(`🔥 The briefing hit a problem: ${err.message}`)
      } finally {
        running = null
      }
    })()
    return { ok: true, ticker }
  }

  function reportMarkdown(s, takes, sum, question) {
    const L = []
    L.push(`# ${FIRM.fullName} — All-hands briefing: ${s.ticker}`)
    L.push(`**Date:** ${new Date().toLocaleString()} · **Requested by:** Michael Scott${question ? ` · **Question:** ${question}` : ''}`, '')
    L.push('## Desk view', '', `> ${sum.line}`, '')
    L.push(`**Tally:** 🟢 ${sum.bull} bullish · ⚪ ${sum.neu} neutral · 🔴 ${sum.bear} bearish`, '')
    L.push('## Snapshot', '')
    if (s.source === 'historical') {
      L.push(`| Last | Today | ${s.span} | 3-month | Vol (ann.) | Max drawdown | Beta vs SPY | vs high | vs 200-day |`)
      L.push('|---:|---:|---:|---:|---:|---:|---:|---:|---|')
      L.push(`| ${s.px.toFixed(2)} | ${pct(s.dayChg)} | ${pct(s.r1y)} | ${pct(s.r3m)} | ${pctAbs(s.vol)} | ${pct(s.mdd)} | ${s.beta.toFixed(2)} | ${pct(s.offHigh)} | ${s.above200 ? 'above' : 'below'} |`)
    } else {
      L.push(`_No live prices — model estimates: vol ≈ ${pctAbs(s.vol)}, beta ≈ ${s.beta.toFixed(2)}._`)
    }
    L.push('', `**${s.name}** · ${s.cls} · ${s.sector}`, '')
    for (const b of BRANCHES) {
      L.push(`## ${b.name}`, '')
      for (const t of takes.filter(x => x.branch === b.name)) {
        const e = empBySlug(t.slug)
        const icon = t.stance === 'bullish' ? '🟢' : t.stance === 'bearish' ? '🔴' : '⚪'
        L.push(`**${e.name}** — ${e.title} · ${icon} ${t.stance}  `)
        L.push(`> ${t.line}`, '')
        if (t.note) L.push(t.note, '')
      }
    }
    L.push('---', '', '_This briefing was produced by AI agents role-playing characters at a fictional parody trading firm. It is for educational and entertainment purposes only and is **not** investment advice. Figures come from one year of public daily prices when available, otherwise simple model estimates; verify before acting._')
    return L.join('\n')
  }

  return { run, isRunning: () => !!running }
}

export { markdownToHtml }
