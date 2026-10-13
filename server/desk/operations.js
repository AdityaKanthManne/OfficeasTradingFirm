/**
 * operations.js — the firm's working day.
 *
 * The staff do their jobs on the office clock, the way a trading firm runs:
 *
 *   07:30  Ryan       overnight crypto note (every day — crypto never closes)
 *   07:50  Gabe       systems & market-data health check
 *   08:00  Dwight     morning risk check — market indicators, regime, book VaR
 *   08:10  Darryl     settlement report (yesterday's trades, T+1), breaks → tickets
 *   08:20  Oscar      ALPHA REPORT — every signal back-tested, today's ranked ideas
 *   08:30  Robert     Investment Committee agenda (Mondays)
 *   08:45  Angela     mandate / concentration check on every book
 *   09:05  Jan        macro note (Mon / Wed / Fri)
 *   09:20  Jim        "any orders for today?" — reply with "buy NVDA" and he works it
 *   10:00  Jim        desk-open update across the books
 *   10:30, 12:30, 14:30, 15:45  Dwight intraday risk checks
 *   11:45  Kelly      what's moving
 *   13:15  staff email each other asking for details (you're cc'd)
 *   16:05  Erin       order log
 *   16:15  each PM    end-of-day book update — rebalance proposals for approval
 *   16:30  Kevin      firm P&L
 *   + weekly: Toby attestations, Holly training, Andy client meetings, Pam's LP
 *     letter (Fri), and David Wallace wanting month-end numbers.
 *
 * Work lands in three places: the email inbox (you can reply, approve, reject),
 * the project board (tickets P0–P3 moving Backlog → To Do → In Progress →
 * Review → Done as staff work them), and the group chat for the big items.
 * State persists in ~/.agent-office/operations.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { emp, loadDeskConfig, FIRM } from './roster.js'
import { personaBlock } from './prompts.js'
import { claudeAvailable, runClaude } from './llm.js'
import { tickersInText, classify } from './classify.js'
import { offlineReply } from './talk.js'
import { nyParts, isTradingDay, marketPhase } from './market.js'
import { getMany, seededChance, nyDate } from './prices.js'
import { reportHtml } from './report.js'
import {
  BOOKS, bookById, bookTickers, initPositions, markBook, rebalanceTrades, bookRisk,
  INDICATORS, riskCheck, UNIVERSE, alphaResearch, ideaWhy, sourceNote, fmtPct, fmtUsd, fmtPx,
} from './opsjobs.js'

const FILE = join(homedir(), '.agent-office', 'operations.json')
const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPORTS_DIR = join(PROJECT_DIR, 'reports')
const PORT = process.env.PORT || 3334
const DAY = 86400000, MIN = 60000
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pickBy = (arr, key) => arr[Math.floor(seededChance(key) * arr.length) % arr.length]

export const COLUMNS = ['Backlog', 'To Do', 'In Progress', 'Review', 'Done']
const PRIO_W = { P0: 8, P1: 4, P2: 2, P3: 1 }

const nameOf = slug => (slug === 'michael' ? 'Michael Scott' : emp(slug)?.name ?? slug)
const firstOf = slug => nameOf(slug).split(' ')[0]
const roleOf = slug => (slug === 'michael' ? 'boss' : emp(slug)?.role)

const tf = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })
const df = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' })
const timeLabel = ms => tf.format(new Date(ms))
const dayLabel = ms => df.format(new Date(ms))

/** UTC ms for a New York wall-clock time on a NY date */
function nyAt(date, mins) {
  const [y, m, d] = date.split('-').map(Number)
  let guess = Date.UTC(y, m - 1, d, Math.floor(mins / 60), mins % 60) + 5 * 3600e3
  for (let i = 0; i < 3; i++) {
    const p = nyParts(guess)
    const dayDiff = p.date === date ? 0 : p.date < date ? 1 : -1
    const diff = mins - p.mins + dayDiff * 1440
    if (!diff) break
    guess += diff * MIN
  }
  return guess
}

function firstTradingDayOfMonth(ms) {
  if (!isTradingDay(ms)) return false
  const p = nyParts(ms)
  for (let b = 1; b < 7; b++) {
    const q = nyParts(ms - b * DAY)
    if (q.date.slice(0, 7) !== p.date.slice(0, 7)) return true
    if (isTradingDay(ms - b * DAY)) return false
  }
  return true
}

function dayMatches(job, ms) {
  const p = nyParts(ms)
  if (job.days === 'daily') return true
  if (job.days === 'trading') return isTradingDay(ms)
  if (job.days === 'monthstart') return firstTradingDayOfMonth(ms)
  if (Array.isArray(job.days)) return isTradingDay(ms) && job.days.includes(p.weekday)
  return false
}

function latestOccurrence(job, now) {
  for (let back = 0; back < 8; back++) {
    const ms = now - back * DAY
    if (!dayMatches(job, ms)) continue
    const date = nyParts(ms).date
    for (const m of [...job.at].sort((a, b) => b - a)) {
      const occ = nyAt(date, m)
      if (occ <= now) return occ
    }
  }
  return null
}

const hm = (h, m = 0) => h * 60 + m

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
function freshState() {
  return { version: 1, seq: { ticket: 100, email: 0, trade: 0 }, books: {}, tickets: [], emails: [], trades: [], queue: [], lastRun: {}, lastWork: 0, risk: null, alphas: null, booted: false }
}
function load() {
  try {
    if (existsSync(FILE)) {
      const s = JSON.parse(readFileSync(FILE, 'utf8'))
      if (s?.version === 1) return { ...freshState(), ...s }
    }
  } catch (e) { console.warn('[ops] could not read state:', e.message) }
  return freshState()
}

// ---------------------------------------------------------------------------
export function createOperations({ broadcast, addMessage, clock }) {
  const S = load()
  let prices = new Map(), pricesFor = -Infinity, pricesAt = 0
  let busy = false
  let saveTimer = null

  function save() {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      try {
        mkdirSync(dirname(FILE), { recursive: true })
        S.emails = S.emails.slice(-400)
        S.trades = S.trades.slice(-300)
        const done = S.tickets.filter(t => t.status === 'Done').sort((a, b) => b.updated - a.updated)
        const keepDone = new Set(done.slice(0, 40).map(t => t.id))
        S.tickets = S.tickets.filter(t => t.status !== 'Done' || keepDone.has(t.id))
        writeFileSync(FILE, JSON.stringify(S))
      } catch (e) { console.warn('[ops] save failed:', e.message) }
    }, 300)
  }

  let changedParts = new Set(), changeTimer = null
  function changed(part) {
    changedParts.add(part)
    clearTimeout(changeTimer)
    changeTimer = setTimeout(() => {
      broadcast({ type: 'ops_update', parts: [...changedParts], timestamp: Date.now() })
      changedParts = new Set()
    }, 150)
    save()
  }

  /** someone on the floor visibly doing their job */
  function activity(slug, text) {
    const role = roleOf(slug)
    if (role) broadcast({ type: 'staff_activity', role, text, timestamp: Date.now() })
  }

  /** big items also go to #trading-floor */
  function post(slug, text) {
    const e = emp(slug)
    const msg = addMessage({ sender: e?.name ?? slug, role: e?.role ?? 'system', text })
    broadcast({ type: 'chat_message', ...msg })
  }

  // ------------------------------------------------------------------ email
  function sendEmail(m) {
    const id = `em-${++S.seq.email}`
    const email = {
      id, threadId: m.threadId ?? id, from: m.from, to: m.to ?? ['michael'], cc: m.cc ?? [],
      subject: m.subject, body: m.body, at: m.at ?? clock.now(), read: m.from === 'michael',
      kind: m.kind ?? 'note', tags: m.tags ?? [], needsReply: !!m.needsReply, actions: m.actions ?? null,
      handled: null, ticketId: m.ticketId ?? null, links: m.links ?? [], data: m.data ?? null, priority: m.priority ?? null,
    }
    S.emails.push(email)
    if (email.from !== 'michael' && (email.to.includes('michael') || email.cc.includes('michael'))) {
      broadcast({ type: 'ops_email', id, threadId: email.threadId, from: email.from, fromName: nameOf(email.from), fromRole: roleOf(email.from), subject: email.subject, priority: email.priority, timestamp: Date.now() })
    }
    changed('emails')
    return email
  }
  const thread = id => S.emails.filter(e => e.threadId === id).sort((a, b) => a.at - b.at)
  const reSubject = s => (s.startsWith('Re: ') ? s : `Re: ${s}`)

  function replyAs(slug, to, parent, body, extra = {}) {
    return sendEmail({ from: slug, to: [to], cc: parent.cc?.filter(c => c !== slug && c !== to) ?? [], subject: reSubject(parent.subject), body, threadId: parent.threadId, kind: extra.kind ?? 'reply', ...extra })
  }

  /** do something later on the office clock */
  function later(minutes, item) {
    S.queue.push({ due: clock.now() + minutes * MIN, ...item })
    save()
  }

  // ---------------------------------------------------------------- tickets
  function createTicket(t) {
    if (t.key) {
      const open = S.tickets.find(x => x.key === t.key && x.status !== 'Done')
      if (open) return open
    }
    const now = clock.now()
    const ticket = {
      id: `DMC-${++S.seq.ticket}`, title: t.title, desc: t.desc ?? '', status: t.status ?? 'To Do', priority: t.priority ?? 'P2',
      type: t.type ?? 'General', assignee: t.assignee, reporter: t.reporter ?? 'michael', created: now, updated: now,
      due: t.due ?? null, comments: [], needsMichael: !!t.needsMichael, key: t.key ?? null, plan: t.plan ?? [], book: t.book ?? null,
      emailId: t.emailId ?? null, points: t.points ?? ({ P0: 5, P1: 3, P2: 2, P3: 1 }[t.priority ?? 'P2']),
    }
    if (t.comment) ticket.comments.push({ by: ticket.reporter, text: t.comment, at: now })
    S.tickets.push(ticket)
    changed('tickets')
    return ticket
  }
  const ticketById = id => S.tickets.find(t => t.id === id)

  function moveTicket(id, status, by, comment) {
    const t = ticketById(id)
    if (!t || !COLUMNS.includes(status)) return null
    const from = t.status
    t.status = status
    t.updated = clock.now()
    if (comment) t.comments.push({ by, text: comment, at: t.updated })
    else if (from !== status) t.comments.push({ by, text: `moved ${from} → ${status}`, at: t.updated, system: true })
    if (status === 'Done') t.needsMichael = false
    changed('tickets')
    return t
  }

  const GENERIC = {
    start: ['Picking this up.', 'On it — starting now.', 'Starting on this today.', 'Taking this one.'],
    progress: ['Halfway there.', 'Making progress — no blockers.', 'Draft done, tidying up.', 'Numbers are in, writing it up.'],
    review: ['Ready for review.', 'Done on my side — can someone check it?', 'Up for review.'],
    done: ['Reviewed — looks good. Closing.', 'Signed off. Done.', 'Closed out.', 'Merged and done.'],
    groom: ['Pulled into this sprint.', 'Prioritised for this sprint.'],
  }

  /** staff working their tickets — a few moves every 20 office minutes in working hours */
  function workTickets(now) {
    const STEP = 20 * MIN
    if (!S.lastWork) S.lastWork = now
    let rounds = Math.min(6, Math.floor((now - S.lastWork) / STEP))
    if (rounds <= 0) return
    S.lastWork += rounds * STEP
    if (now - S.lastWork > STEP) S.lastWork = now
    const p = nyParts(now)
    if (!isTradingDay(now) || p.mins < hm(8) || p.mins > hm(18, 30)) return
    while (rounds-- > 0) {
      const pool = S.tickets.filter(t => t.status !== 'Done' && !(t.status === 'Review' && t.needsMichael) && (t.status !== 'Backlog' || Math.random() < 0.15))
      if (!pool.length) return
      const n = Math.random() < 0.5 ? 1 : 2
      for (let i = 0; i < n && pool.length; i++) {
        const total = pool.reduce((s, t) => s + PRIO_W[t.priority], 0)
        let r = Math.random() * total, k = 0
        while (k < pool.length - 1 && (r -= PRIO_W[pool[k].priority]) > 0) k++
        const t = pool.splice(k, 1)[0]
        advance(t)
      }
    }
  }

  function advance(t) {
    const step = t.plan?.shift()
    const by = step?.by ?? t.assignee
    const say = k => step?.say ?? GENERIC[k][Math.floor(Math.random() * GENERIC[k].length)]
    const next = step?.to ?? { Backlog: 'To Do', 'To Do': 'In Progress', 'In Progress': t.comments.some(c => c.progress) ? 'Review' : 'In Progress', Review: 'Done' }[t.status]
    if (!next) return
    if (next === t.status) {
      t.comments.push({ by, text: say('progress'), at: clock.now(), progress: true })
      t.updated = clock.now()
      changed('tickets')
      return
    }
    const kind = next === 'To Do' ? 'groom' : next === 'In Progress' ? 'start' : next === 'Review' ? 'review' : 'done'
    const reviewer = t.reporter && t.reporter !== t.assignee && t.reporter !== 'michael' ? t.reporter : 'jim-halpert'
    moveTicket(t.id, next, kind === 'done' && !step ? reviewer : by, say(kind))
    if (kind === 'start') activity(t.assignee, `🎫 ${t.id}: ${t.title.slice(0, 40)}`)
    if (next === 'Review' && t.needsMichael) {
      sendEmail({ from: t.assignee, subject: `Review needed: ${t.id} ${t.title}`, body: `Hi Michael,\n\n${t.id} — **${t.title}** — is ready for your review on the board.\n\n${t.desc}\n\nApprove it and I'll close it out.\n\n${firstOf(t.assignee)}`, kind: 'ticket-review', actions: [{ id: 'approve', label: 'Approve' }, { id: 'changes', label: 'Request changes' }], ticketId: t.id, tags: [t.type] })
    }
  }

  // ----------------------------------------------------------------- prices
  async function refreshPrices(force = false) {
    const now = clock.now()
    if (!force && Math.abs(now - pricesFor) < 10 * MIN && Date.now() - pricesAt < 3 * MIN) return prices
    const all = [...INDICATORS.map(i => i.t), ...UNIVERSE, ...bookTickers()]
    prices = await getMany(all, now)
    pricesFor = now
    pricesAt = Date.now()
    return prices
  }

  function bookState(b) {
    if (!S.books[b.id]) S.books[b.id] = { positions: null, peakNav: b.nav, history: [], lastEod: null }
    const st = S.books[b.id]
    if (!st.positions) st.positions = initPositions(b, prices)
    return st
  }
  /** the book with this team's current targets (they move when you hedge, trim or place an order) */
  const eff = b => ({ ...b, targets: S.books[b.id]?.targets ?? b.targets })
  function markAll() {
    return BOOKS.map(b => {
      const st = bookState(b)
      const mark = markBook(eff(b), st.positions, prices)
      const risk = bookRisk(b, mark, prices, st.peakNav)
      return { book: b, st, mark, risk }
    })
  }

  // ------------------------------------------------------------ the jobs
  const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n')
  const statusIcon = s => (s === 'alert' ? '🔴' : s === 'watch' ? '🟡' : '🟢')

  async function jobRisk({ at, morning }) {
    activity('dwight-schrute', '📈 Checking market indicators…')
    const rc = riskCheck(prices)
    const books = markAll()
    const prev = S.risk?.regime
    S.risk = {
      at, regime: rc.regime, score: rc.score, sources: rc.sources,
      rows: rc.rows.map(r => ({ t: r.t, name: r.name, last: r.last, dayChg: r.dayChg, m1: r.m1, vs200: r.vs200, vol20: r.vol20, status: r.status, note: r.note, source: r.source })),
      books: books.map(({ book, mark, risk }) => ({ id: book.id, name: book.short, nav: mark.nav, varPct: risk.varPct, var95: risk.var95, vol: risk.vol, beta: risk.beta, top: risk.top, drawdown: risk.drawdown, breaches: risk.breaches.map(b => b.text) })),
    }
    changed('risk')
    const alerts = rc.rows.filter(r => r.status !== 'ok')
    const breaches = books.flatMap(({ book, risk }) => risk.breaches.filter(b => b.kind !== 'single').map(b => ({ book, b })))
    const body = [
      `Michael,`, ``,
      `${morning ? 'Morning' : 'Intraday'} risk check, ${timeLabel(at)} ET. **Regime: ${rc.regime}** (score ${rc.score > 0 ? '+' : ''}${rc.score}).${prev && prev !== rc.regime ? ` Changed from ${prev}.` : ''}`,
      ``, `**Market indicators**`,
      table(['', 'Indicator', 'Last', 'Day', '1 mo', 'vs 200d', 'Read'], rc.rows.map(r => [statusIcon(r.status), `${r.name} (${r.t.replace('^', '')})`, fmtPx(r.last), fmtPct(r.dayChg), fmtPct(r.m1), fmtPct(r.vs200), r.note])),
      ``, `**Book risk** (1-day 95% VaR, 60-day vol)`,
      table(['Book', 'NAV', 'VaR', 'VaR % NAV', 'Vol', 'Beta', 'Off high'], books.map(({ book, mark, risk }) => [book.short, fmtUsd(mark.nav), fmtUsd(risk.var95), `${(risk.varPct * 100).toFixed(2)}%${risk.varPct > book.limits.var ? ' 🔴' : ''}`, `${(risk.vol * 100).toFixed(1)}%`, risk.beta == null ? '—' : risk.beta.toFixed(2), fmtPct(risk.drawdown)])),
      ``,
      breaches.length ? `**Limit breaches**\n${breaches.map(({ book, b }) => `- ${book.short}: ${b.text}`).join('\n')}` : 'No VaR or drawdown limits breached.',
      ``,
      alerts.length ? `Watch list: ${alerts.map(r => `${r.name} (${r.note})`).join('; ')}.` : 'Nothing on the watch list. I remain suspicious anyway.',
      ``, `_${sourceNote(rc.sources)}_`, ``,
      rc.regime === 'RISK-OFF' ? 'I have locked the supply closet. Precaution.' : rc.regime === 'RISK-ON' ? 'Conditions favourable. Do not get comfortable.' : 'Vigilance. Always vigilance.',
      `— Dwight K. Schrute, Chief Risk Officer`,
    ].join('\n')
    const email = sendEmail({ from: 'dwight-schrute', cc: ['jim-halpert', 'robert-california'], subject: `${morning ? 'Morning risk check' : `Risk check ${timeLabel(at)}`} — ${rc.regime}${breaches.length ? ` · ${breaches.length} breach${breaches.length > 1 ? 'es' : ''}` : ''}`, body, kind: 'risk', tags: ['Risk'], priority: rc.regime === 'RISK-OFF' || breaches.length ? 'high' : null, at })
    if (morning || (prev && prev !== rc.regime) || breaches.length) {
      post('dwight-schrute', `📈 Risk check ${timeLabel(at)}: **${rc.regime}**. ${alerts.slice(0, 2).map(r => `${r.name}: ${r.note}`).join('. ') || 'All indicators green.'}${breaches.length ? ` ${breaches.length} limit breach${breaches.length > 1 ? 'es' : ''} — tickets opened.` : ''} Full sheet in your inbox.`)
    }
    for (const { book, b } of breaches) {
      createTicket({ key: `breach:${book.id}:${b.kind}`, title: `${book.short}: ${b.kind === 'var' ? 'VaR over limit' : 'drawdown stop hit'}`, desc: `${b.text}. Bring it back inside the limit or get a waiver.`, priority: 'P1', type: 'Risk', assignee: book.pm, reporter: 'dwight-schrute', comment: `Found in the ${timeLabel(at)} risk check. Fix it.`, book: book.id, emailId: email.id })
    }
    // regime turned risk-off → hedge proposal for the flagship
    if (rc.regime === 'RISK-OFF' && prev !== 'RISK-OFF') {
      const fl = books.find(x => x.book.id === 'flagship')
      const notional = fl.mark.nav * 0.05
      const t = createTicket({ key: 'hedge:flagship', title: 'Hedge Flagship equity beta (sell 5% SPY)', desc: `Regime flipped to RISK-OFF. Proposal: sell ${fmtUsd(notional)} of SPY in the Flagship book to cut beta.`, priority: 'P0', type: 'Risk', assignee: 'jim-halpert', reporter: 'dwight-schrute', status: 'Review', needsMichael: true, book: 'flagship' })
      sendEmail({ from: 'dwight-schrute', cc: ['jim-halpert', 'robert-california'], subject: `ACTION: hedge the Flagship — ${t.id}`, body: `Michael,\n\nThe regime is now **RISK-OFF**. I propose we sell **${fmtUsd(notional)} of SPY** in the Flagship (about 5% of NAV) to cut equity beta until conditions improve.\n\nJim is standing by to execute. I need your approval. Now would be good. Yesterday would have been better.\n\n— Dwight`, kind: 'hedge', actions: [{ id: 'approve', label: 'Approve hedge' }, { id: 'reject', label: 'Reject' }], ticketId: t.id, tags: ['Risk'], priority: 'high', needsReply: true })
    }
  }

  async function jobAlpha({ at }) {
    activity('oscar-martinez', '🧮 Running the alpha back-tests…')
    activity('karen-filippelli', '📑 Checking the signal write-ups…')
    const a = alphaResearch(prices)
    const stamp = new Date(clock.now()).toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const id = `${stamp.slice(0, 8)}-${stamp.slice(8, 14)}-alphas`
    const verdict = v => (v === 'use' ? '✅ Use' : v === 'flip' ? '🔁 Use reversed' : '⚠️ Weak — monitor')
    const md = [
      `# Alpha Report — ${dayLabel(at)}`,
      `<p class="byline">Oscar Martínez (Quant) & Karen Filippelli (Equity Research) · ${FIRM.fullName}</p>`,
      ``,
      `Every signal in the library, back-tested on a ${a.universe}-stock universe: at each date we rank the stocks by the signal and check how well that ranking predicted the next ${a.horizon} trading days' returns (rank information coefficient, IC). An IC above about 0.03 with a t-stat above 1 is something you can use.`,
      ``, `## The alphas you can use`,
      table(['Signal', 'Owner', 'Avg IC', 't-stat', 'Hit rate', 'Tests', 'Verdict'], a.stats.map(s => [s.name, firstOf(s.owner), s.ic.toFixed(3), s.icT.toFixed(2), `${(s.hit * 100).toFixed(0)}%`, String(s.n), verdict(s.verdict)])),
      ``,
      a.fallback ? '> None of the signals cleared the bar this time, so the ideas below lean on the two strongest — size them small.' : `> Today's ideas combine the usable signals: ${a.stats.filter(s => s.verdict === 'use' || s.verdict === 'flip').map(s => s.verdict === 'flip' ? `${s.name} (reversed)` : s.name).join(', ')}, weighted by their t-stats. A signal marked "use reversed" has been reliably wrong, so we bet the other way.`,
      ``, `## Long ideas`,
      table(['#', 'Ticker', 'Name', 'Score', 'Price', '1 mo', 'Why'], a.longs.map((x, i) => [String(i + 1), x.ticker, x.name, x.score.toFixed(2), fmtPx(x.px), fmtPct(x.m1), ideaWhy(x)])),
      ``, `## Underweight / avoid`,
      table(['#', 'Ticker', 'Name', 'Score', 'Price', '1 mo', 'Why'], a.avoid.map((x, i) => [String(i + 1), x.ticker, x.name, x.score.toFixed(2), fmtPx(x.px), fmtPct(x.m1), ideaWhy(x)])),
      ``, `## Full ranking`,
      table(['Ticker', 'Sector', 'Score', 'Day', '1 mo'], a.ranked.map(x => [x.ticker, x.sector, x.score.toFixed(2), fmtPct(x.dayChg), fmtPct(x.m1)])),
      ``, `## Notes`,
      `- Back-test: every 5 trading days over the last year of daily closes, ${a.horizon}-day forward returns, Spearman rank IC. No transaction costs, no sector neutralisation.`,
      `- ${sourceNote(a.sources)}`,
      `- Research, not advice. Toby asked us to say that.`,
    ].join('\n')
    try {
      mkdirSync(join(REPORTS_DIR, id), { recursive: true })
      writeFileSync(join(REPORTS_DIR, id, 'report.md'), md)
      writeFileSync(join(REPORTS_DIR, id, 'report.html'), reportHtml(md, `Alpha Report — ${dayLabel(at)}`))
    } catch (e) { console.warn('[ops] alpha report write failed:', e.message) }
    const url = `http://127.0.0.1:${PORT}/reports/${id}`
    S.alphas = { at, id, url, stats: a.stats, longs: a.longs.map(x => ({ ticker: x.ticker, name: x.name, score: x.score, why: ideaWhy(x), m1: x.m1 })), avoid: a.avoid.map(x => ({ ticker: x.ticker, name: x.name, score: x.score, why: ideaWhy(x), m1: x.m1 })), sources: a.sources, universe: a.universe }
    changed('alphas')
    const usable = a.stats.filter(s => s.verdict === 'use' || s.verdict === 'flip')
    const body = [
      `Michael,`, ``,
      `Today's alpha report is ready. Actually, it's quite good.`, ``,
      `**Usable alphas (${usable.length} of ${a.stats.length})**`,
      table(['Signal', 'Avg IC', 't-stat', 'Hit rate', 'Verdict'], a.stats.map(s => [s.name, s.ic.toFixed(3), s.icT.toFixed(2), `${(s.hit * 100).toFixed(0)}%`, verdict(s.verdict)])),
      ``, `**Top long ideas**`,
      ...a.longs.map((x, i) => `${i + 1}. **${x.ticker}** (${x.score.toFixed(2)}) — ${ideaWhy(x)}`),
      ``, `**Avoid**: ${a.avoid.map(x => x.ticker).join(', ')}`,
      ``, `_${sourceNote(a.sources)}_`, ``,
      `Say the word and I'll send the ideas to the PMs and open research tickets for the top two.`, ``, `Oscar`,
    ].join('\n')
    sendEmail({ from: 'oscar-martinez', cc: ['karen-filippelli', 'robert-california'], subject: `Alpha report — ${dayLabel(at)}: ${usable.length} usable signals, top idea ${a.longs[0]?.ticker ?? '—'}`, body, kind: 'alpha', actions: [{ id: 'send', label: 'Send ideas to PMs' }, { id: 'ack', label: 'Thanks' }], links: [{ label: 'Open the full alpha report', url }], tags: ['Research'], data: { reportId: id }, at })
    post('oscar-martinez', `🧮 Alpha report is out: ${usable.length} of ${a.stats.length} signals are usable today${usable.length ? ` (${usable.map(s => s.name).join(', ')})` : ''}. Top ideas: ${a.longs.slice(0, 3).map(x => x.ticker).join(', ')}. Avoid: ${a.avoid.slice(0, 3).map(x => x.ticker).join(', ')}. It's in your inbox.`)
  }

  async function jobDeskOpen({ at }) {
    activity('jim-halpert', '📊 Pulling the morning numbers…')
    const books = markAll()
    const firmNav = books.reduce((s, x) => s + x.mark.nav, 0), firmPnl = books.reduce((s, x) => s + x.mark.dayPnl, 0)
    const movers = books.flatMap(x => x.mark.positions.filter(p => p.ticker !== 'CASH').map(p => ({ ...p, book: x.book.short }))).sort((a, b) => Math.abs(b.dayPnl) - Math.abs(a.dayPnl)).slice(0, 4)
    const body = [
      `Morning Michael,`, ``,
      marketPhase(at) === 'open' ? `Half an hour into the session. Here's where the books are.` : `Here's where the books stand${marketPhase(at) === 'pre' ? ' before the open' : ' after the close'}.`, ``,
      table(['Book', 'PM', 'NAV', 'Today', 'Today %'], books.map(({ book, mark }) => [book.short, firstOf(book.pm), fmtUsd(mark.nav), fmtUsd(mark.dayPnl), fmtPct(mark.dayRet, 2)])),
      `**Firm: ${fmtUsd(firmNav)} · ${fmtUsd(firmPnl)} today (${fmtPct(firmPnl / (firmNav - firmPnl), 2)})**`, ``,
      `Biggest movers: ${movers.map(m => `${m.ticker} ${fmtPct(m.dayChg)} (${m.book}, ${fmtUsd(m.dayPnl)})`).join(' · ')}.`, ``,
      S.risk ? `Dwight has us at **${S.risk.regime}**. He's also been staring at me since 9:30.` : '',
      ``, `_${sourceNote([...new Set(books.flatMap(x => x.mark.sources))])}_`, ``, `Jim`,
    ].join('\n')
    sendEmail({ from: 'jim-halpert', cc: BOOKS.map(b => b.pm), subject: `${marketPhase(at) === 'open' ? 'Desk open' : 'Desk update'} — firm ${fmtPct(firmPnl / (firmNav - firmPnl), 2)} (${fmtUsd(firmPnl)})`, body, kind: 'books', tags: ['Portfolio'], at })
  }

  async function jobBooksEod({ at }) {
    const books = markAll()
    let k = 0
    for (const { book, st, mark, risk } of books) {
      activity(book.pm, `💼 Writing the ${book.short} close…`)
      st.peakNav = Math.max(st.peakNav ?? 0, mark.nav)
      const date = nyDate(at)
      st.history = [...(st.history ?? []).filter(h => h.date !== date), { date, nav: mark.nav, pnl: mark.dayPnl }].slice(-90)
      st.lastEod = { at, nav: mark.nav, pnl: mark.dayPnl, ret: mark.dayRet }
      const pos = mark.positions.filter(p => p.ticker !== 'CASH')
      const up = [...pos].sort((a, b) => b.dayPnl - a.dayPnl).slice(0, 3)
      const down = [...pos].sort((a, b) => a.dayPnl - b.dayPnl).slice(0, 2)
      const drift = Math.abs(mark.maxDrift.drift ?? 0)
      const trades = drift > 0.03 ? rebalanceTrades(book, mark, 0.01) : []
      const VOICE = {
        'robert-california': ['The Flagship closed', 'Conviction is a position. This is ours.'],
        'stanley-hudson': ['Income Fund close', 'That is all. It is 4:15. I am leaving at 5.'],
        'phyllis-vance': ['The Vance family book closed', 'Bob says hi. He always says hi.'],
        'ryan-howard': ['Digital book closed', 'Volatility is just opportunity wearing a hoodie.'],
        'meredith-palmer': ['Real assets closed', "Commodities don't lie. Carol checked the REITs."],
        'nellie-bertram': ['ESG & Thematic closed', 'Doing well by doing good. Mostly doing.'],
      }[book.pm] ?? [`${book.short} closed`, '']
      const lines = [
        `Michael,`, ``,
        `${VOICE[0]} at **${fmtUsd(mark.nav)}**, **${fmtUsd(mark.dayPnl)}** on the day (${fmtPct(mark.dayRet, 2)}). Since inception: ${fmtPct(mark.nav / book.nav - 1, 2)}.`, ``,
        `Top contributors: ${up.map(p => `${p.ticker} ${fmtUsd(p.dayPnl)}`).join(', ')}. Detractors: ${down.map(p => `${p.ticker} ${fmtUsd(p.dayPnl)}`).join(', ')}.`, ``,
        table(['Position', 'Price', 'Day', 'Value', 'Weight', 'Target', 'Drift'], mark.positions.map(p => [p.ticker, p.ticker === 'CASH' ? '—' : fmtPx(p.px), p.ticker === 'CASH' ? '—' : fmtPct(p.dayChg), fmtUsd(p.value), `${(p.weight * 100).toFixed(1)}%`, `${(p.target * 100).toFixed(0)}%`, fmtPct(p.drift)])),
        ``, `Risk: VaR ${fmtUsd(risk.var95)} (${(risk.varPct * 100).toFixed(2)}% of NAV), vol ${(risk.vol * 100).toFixed(1)}%, beta ${risk.beta?.toFixed(2) ?? '—'}.`,
      ]
      let ticket = null
      if (trades.length && !S.tickets.some(t => t.key === `rebal:${book.id}` && t.status !== 'Done')) {
        ticket = createTicket({ key: `rebal:${book.id}`, title: `Rebalance ${book.short} (${trades.length} trades)`, desc: trades.map(t => `${t.side} ${fmtUsd(t.notional)} ${t.ticker} (${(t.from * 100).toFixed(1)}% → ${(t.to * 100).toFixed(0)}%)`).join('\n'), priority: drift > 0.06 ? 'P1' : 'P2', type: 'Trading', assignee: 'jim-halpert', reporter: book.pm, status: 'Review', needsMichael: true, book: book.id })
        lines.push(``, `**Rebalance proposal** — ${mark.maxDrift.ticker} has drifted ${fmtPct(mark.maxDrift.drift)} from target:`,
          table(['Side', 'Ticker', 'Notional', 'From → To'], trades.map(t => [t.side, t.ticker, fmtUsd(t.notional), `${(t.from * 100).toFixed(1)}% → ${(t.to * 100).toFixed(0)}%`])),
          `Approve and Jim works it tomorrow at the open. (${ticket.id})`)
      }
      lines.push(``, VOICE[1], ``, firstOf(book.pm))
      sendEmail({
        from: book.pm, cc: [...book.team.filter(s => s !== 'bob-vance'), 'kevin-malone'], subject: `${book.short} EOD — ${fmtPct(mark.dayRet, 2)} (${fmtUsd(mark.dayPnl)})${ticket ? ' · rebalance for approval' : ''}`,
        body: lines.join('\n'), kind: ticket ? 'rebalance' : 'books', tags: ['Portfolio'], at: at + (k++) * 2 * MIN,
        actions: ticket ? [{ id: 'approve', label: 'Approve rebalance' }, { id: 'reject', label: 'Reject' }] : null,
        ticketId: ticket?.id ?? null, data: ticket ? { book: book.id, trades } : null, priority: ticket ? 'high' : null,
      })
      await sleep(400)
    }
    changed('books')
  }

  async function jobKevin({ at }) {
    activity('kevin-malone', '🧾 Adding up the P&L…')
    const books = markAll()
    const firmNav = books.reduce((s, x) => s + x.mark.nav, 0), pnl = books.reduce((s, x) => s + x.mark.dayPnl, 0)
    const best = [...books].sort((a, b) => b.mark.dayRet - a.mark.dayRet)[0]
    const body = [
      `Michael`, ``, `P&L for ${dayLabel(at)}. I did it in my head first and then the computer agreed with me. Mostly.`, ``,
      table(['Book', 'NAV', 'Day P&L', 'Day %', 'Since start'], books.map(({ book, mark }) => [book.short, fmtUsd(mark.nav), fmtUsd(mark.dayPnl), fmtPct(mark.dayRet, 2), fmtPct(mark.nav / book.nav - 1, 2)])),
      `**Firm: ${fmtUsd(firmNav)} · ${fmtUsd(pnl)}**`, ``,
      pnl >= 0 ? `We made ${fmtUsd(pnl, false).replace('.00', '')}. That's a lot of M&Ms. Best book was ${best.book.short}.` : `We lost ${fmtUsd(-pnl, false)}. That's not my fault. Angela checked it. Best book was still ${best.book.short}.`,
      ``, `Positions reconcile to the custodian. Angela made me say that.`, ``, `Kevin`,
    ].join('\n')
    sendEmail({ from: 'kevin-malone', cc: ['angela-martin', 'david-wallace'], subject: `Daily P&L ${dayLabel(at)}: ${fmtUsd(pnl)}`, body, kind: 'pnl', tags: ['Finance'], at })
    post('kevin-malone', `🧾 Firm P&L today: ${fmtUsd(pnl)} on ${fmtUsd(firmNav)}. ${pnl >= 0 ? 'Nice.' : 'Not nice.'}`)
  }

  async function jobAngela({ at }) {
    activity('angela-martin', '📏 Checking mandates…')
    const books = markAll()
    const issues = books.flatMap(({ book, risk }) => risk.breaches.filter(b => b.kind === 'single').map(b => ({ book, b })))
    const body = [
      `Michael,`, ``,
      issues.length ? `The morning mandate check found **${issues.length} concentration breach${issues.length > 1 ? 'es' : ''}**. This is unacceptable.` : 'Morning mandate check: every book is inside its mandate. As it should be.',
      ``,
      table(['Book', 'Largest single name', 'Limit', 'Cash', 'Status'], books.map(({ book, risk }) => [book.short, risk.top ? `${risk.top.ticker} ${(risk.top.weight * 100).toFixed(1)}%` : '—', `${(book.limits.single * 100).toFixed(0)}%`, `${(risk.cash * 100).toFixed(1)}%`, risk.breaches.some(b => b.kind === 'single') ? '🔴 Breach' : '🟢 OK'])),
      ...(issues.length ? [``, ...issues.map(({ book, b }) => `- ${book.short}: ${b.text}`), ``, `Approve and Jim trims it back to the limit. Or grant a waiver, and I will note in the file that you did.`] : []),
      ``, `Angela Martin, Fund Controller`,
    ].join('\n')
    let ticket = null
    if (issues.length) {
      const { book, b } = issues[0]
      ticket = createTicket({ key: `limit:${book.id}:${b.ticker}`, title: `${book.short}: ${b.ticker} over single-name limit`, desc: b.text, priority: 'P1', type: 'Compliance', assignee: book.pm, reporter: 'angela-martin', status: 'Review', needsMichael: true, book: book.id })
    }
    sendEmail({ from: 'angela-martin', cc: ['toby-flenderson'], subject: issues.length ? `Mandate breach — ${issues.map(x => `${x.book.short} ${x.b.ticker}`).join(', ')}` : 'Mandate check — all clear', body, kind: issues.length ? 'limit' : 'mandate', tags: ['Compliance'], at, actions: issues.length ? [{ id: 'approve', label: 'Trim to limit' }, { id: 'waive', label: 'Grant waiver' }] : null, ticketId: ticket?.id ?? null, data: issues.length ? { book: issues[0].book.id, ticker: issues[0].b.ticker } : null, priority: issues.length ? 'high' : null })
  }

  async function jobDarryl({ at }) {
    activity('darryl-philbin', '📦 Settling yesterday\'s trades…')
    const today = nyDate(at)
    const due = S.trades.filter(t => !t.settled && t.date < today)
    for (const t of due) t.settled = today
    const brk = due.length ? seededChance('break' + today) < 0.3 : seededChance('cashbreak' + today) < 0.15
    const lines = [`Mike,`, ``]
    if (due.length) {
      lines.push(`${due.length} trade${due.length > 1 ? 's' : ''} settled T+1 this morning:`, table(['Trade', 'Book', 'Side', 'Ticker', 'Shares', 'Price'], due.slice(0, 12).map(t => [t.id, bookById(t.book)?.short ?? t.book, t.side, t.ticker, Math.round(t.shares).toLocaleString(), fmtPx(t.px)])))
    } else lines.push('No trades to settle this morning. Custody positions match the books.')
    if (brk) {
      const t = due[0]
      const what = t ? `${t.ticker}: custodian shows ${Math.round(t.shares * 0.98).toLocaleString()} shares, we show ${Math.round(t.shares).toLocaleString()}` : 'Income Fund cash: custodian is $1,250.00 light vs. the book'
      lines.push(``, `One break: ${what}. Roy's on it.`)
      const ticket = createTicket({ title: `Settlement break — ${t ? t.ticker : 'Income Fund cash'}`, desc: what, priority: 'P2', type: 'Ops', assignee: 'roy-anderson', reporter: 'darryl-philbin', comment: 'Chase the custodian first, then the broker.', plan: [{ to: 'In Progress', say: 'Called the custodian. On hold. Again.' }, { to: 'In Progress', say: 'Broker confirmed partial fill on their side — booking the correction.', progress: true }, { to: 'Review', say: 'Corrected. Darryl, can you check it?' }, { to: 'Done', by: 'darryl-philbin', say: 'Checked. Break cleared.' }] })
      const ask = sendEmail({ from: 'roy-anderson', to: ['darryl-philbin'], cc: ['michael', 'kevin-malone'], subject: `Question on ${ticket.id} — who do I chase?`, body: `Darryl,\n\n${what}. Do I call the custodian or the broker first? And do we need Kevin to hold the P&L until it's fixed?\n\nRoy`, kind: 'ask', tags: ['Ops'], ticketId: ticket.id, at: at + 5 * MIN })
      later(35, { type: 'reply', parent: ask.id, from: 'darryl-philbin', to: 'roy-anderson', body: `Roy — custodian first, they'll have the receive. If they show the full quantity it's the broker's allocation. Kevin, book it as-is and flag it; we'll true it up when it clears.\n\nD` })
    }
    lines.push(``, `Darryl`)
    sendEmail({ from: 'darryl-philbin', cc: ['roy-anderson'], subject: `Settlement report ${dayLabel(at)} — ${due.length} settled${brk ? ', 1 break' : ''}`, body: lines.join('\n'), kind: 'ops', tags: ['Ops'], at })
  }

  async function jobGabe({ at }) {
    activity('gabe-lewis', '🖥️ Checking Sabre and the data feeds…')
    const srcs = [...prices.values()].map(s => s.source)
    const sim = srcs.filter(s => s === 'sim').length, fwd = srcs.filter(s => s === 'live+sim').length
    if (sim) {
      createTicket({ key: 'feed:sim', title: `Market data feed down — ${sim} symbols on simulated prices`, desc: `The price feed could not be reached for ${sim} of ${srcs.length} symbols. Risk, alphas and book marks are using simulated prices for those until it's back.`, priority: 'P1', type: 'Tech', assignee: 'gabe-lewis', reporter: 'gabe-lewis', comment: 'Investigating. Opened a ticket with the vendor.' })
    } else {
      const open = S.tickets.find(t => t.key === 'feed:sim' && t.status !== 'Done')
      if (open) moveTicket(open.id, 'Done', 'gabe-lewis', 'Feed is back — all symbols live.')
    }
    if (sim || seededChance('gabe' + nyDate(at)) < 0.35) {
      sendEmail({ from: 'gabe-lewis', to: ['michael'], cc: ['jim-halpert'], subject: sim ? `Data feed degraded — ${sim} symbols simulated` : 'Pre-market systems check — all green', body: `Michael,\n\n${sim ? `Heads up: the market data feed failed for **${sim} of ${srcs.length}** symbols, so the desk is running on simulated prices for those. Everything that uses them is labelled SIMULATED. I'm on it.` : `Sabre OMS is up, FIX sessions to both brokers connected, market data live for all ${srcs.length} symbols${fwd ? ` (${fwd} carried forward because the office clock is ahead of the real market)` : ''}.`}\n\nAs they say at Sabre: "Sabre."\n\nGabe Lewis, Electronic Trading Systems`, kind: sim ? 'datafeed' : 'systems', tags: ['Tech'], actions: sim ? [{ id: 'ack', label: 'Acknowledge' }] : null, priority: sim ? 'high' : null, at })
    }
  }

  async function jobRyan({ at }) {
    const b = prices.get('BTC'), e = prices.get('ETH')
    if (!b) return
    activity('ryan-howard', '₿ Writing the overnight crypto note…')
    const st = bookState(bookById('digital'))
    const mark = markBook(eff(bookById('digital')), st.positions, prices)
    sendEmail({ from: 'ryan-howard', cc: ['gabe-lewis'], subject: `Overnight crypto: BTC ${fmtPct(b.dayChg)} · ETH ${fmtPct(e?.dayChg)}`, body: `Michael,\n\nCrypto never sleeps. Neither do I (I do).\n\n- **BTC** ${fmtPx(b.last)} (${fmtPct(b.dayChg)} 24h, ${fmtPct(b.closes.length > 30 ? b.last / b.closes.at(-31) - 1 : null)} 30d)\n- **ETH** ${fmtPx(e?.last)} (${fmtPct(e?.dayChg)} 24h)\n\nDigital book: ${fmtUsd(mark.nav)}, ${fmtPct(mark.nav / bookById('digital').nav - 1, 1)} since launch.\n\n${b.dayChg > 0.03 ? 'We are so back.' : b.dayChg < -0.03 ? "It's a dip. Dips are for buying. Or for chips." : 'Consolidating. Very bullish, actually.'}\n\n_${sourceNote([b.source])}_\n\nRyan Howard, Head of Digital Assets`, kind: 'crypto', tags: ['Digital'], at })
  }

  async function jobJan({ at }) {
    activity('jan-levinson', '🌐 Macro note…')
    const g = t => prices.get(t)
    const tlt = g('TLT'), uup = g('UUP'), uso = g('USO'), gld = g('GLD'), spy = g('SPY')
    const m1 = s => (s && s.closes.length > 22 ? s.last / s.closes.at(-22) - 1 : null)
    const ratesUp = m1(tlt) < -0.02
    sendEmail({ from: 'jan-levinson', cc: ['robert-california', 'stanley-hudson', 'david-wallace'], subject: `Macro note — ${ratesUp ? 'rates moving up' : m1(tlt) > 0.02 ? 'bonds rallying' : 'rates range-bound'}`, body: `Michael,\n\nOne month, across assets:\n\n${table(['', '1 month', 'Read'], [
      ['Long Treasuries (TLT)', fmtPct(m1(tlt)), ratesUp ? 'yields up — duration hurting' : m1(tlt) > 0.02 ? 'yields down — duration working' : 'quiet'],
      ['Dollar (UUP)', fmtPct(m1(uup)), m1(uup) > 0.02 ? 'strong dollar tightens conditions' : 'neutral'],
      ['Oil (USO)', fmtPct(m1(uso)), Math.abs(m1(uso) ?? 0) > 0.08 ? 'big move — watch inflation prints' : 'contained'],
      ['Gold (GLD)', fmtPct(m1(gld)), m1(gld) > 0.04 ? 'someone is nervous' : 'calm'],
      ['S&P 500 (SPY)', fmtPct(m1(spy)), ''],
    ])}\n\n${ratesUp ? 'Stanley should keep duration short. I already told him. Twice.' : 'No change to the duration call.'} I'll bring this to Monday's IC.\n\n_${sourceNote([tlt?.source, spy?.source].filter(Boolean))}_\n\nJan Levinson\nHead of Institutional Strategy`, kind: 'macro', tags: ['Macro'], at })
  }

  async function jobKelly({ at }) {
    activity('kelly-kapoor', '📱 Checking what everyone is talking about…')
    const movers = UNIVERSE.map(t => prices.get(t)).filter(Boolean).sort((a, b) => Math.abs(b.dayChg) - Math.abs(a.dayChg)).slice(0, 5)
    sendEmail({ from: 'kelly-kapoor', cc: ['ryan-howard'], subject: `What's moving: ${movers.slice(0, 3).map(s => `${s.ticker} ${fmtPct(s.dayChg)}`).join(', ')}`, body: `Michael!!\n\nOkay so these are the stocks EVERYONE is going to be talking about today (biggest moves so far):\n\n${movers.map(s => `- **${s.ticker}** ${fmtPct(s.dayChg)} ${s.dayChg > 0.03 ? '🚀' : s.dayChg < -0.03 ? '💀' : ''}`).join('\n')}\n\n${movers[0] ? `${movers[0].ticker} is literally the main character today.` : ''} I'm basing this on the price moves, not my phone, because Toby said my phone is "not a data source." Rude.\n\nAlso can I expense a ring light? For research.\n\nKelly`, kind: 'sentiment', needsReply: true, tags: ['Intel'], at })
  }

  async function jobJimOrders({ at }) {
    sendEmail({ from: 'jim-halpert', subject: `Orders for today?`, body: `Hey Michael,\n\nDesk's set up for the open. Anything you want worked today? Reply with something like "buy $2M NVDA in the Flagship" or "trim TSLA" and I'll ticket it and work it.\n\n${S.alphas?.longs?.length ? `Oscar's top ideas this morning: ${S.alphas.longs.slice(0, 3).map(x => x.ticker).join(', ')}.` : ''}\n\nJim`, kind: 'orders', needsReply: true, tags: ['Trading'], at })
  }

  async function jobErin({ at }) {
    activity('erin-hannon', '🗂️ Logging today\'s orders…')
    const today = nyDate(at)
    const t = S.trades.filter(x => x.date === today)
    sendEmail({ from: 'erin-hannon', cc: ['darryl-philbin', 'toby-flenderson'], subject: `Order log ${dayLabel(at)} — ${t.length} order${t.length === 1 ? '' : 's'}`, body: t.length ? `Hi Michael!\n\nHere's everything we did today:\n\n${table(['Trade', 'Book', 'Side', 'Ticker', 'Notional'], t.map(x => [x.id, bookById(x.book)?.short ?? x.book, x.side, x.ticker, fmtUsd(x.notional)]))}\n\nAll logged in Sabre AND the paper book, just in case.\n\nErin` : `Hi Michael!\n\nNo orders today! I logged that too. It's a very short log.\n\nErin`, kind: 'orderlog', tags: ['Trading'], at })
  }

  async function jobRobert({ at }) {
    const books = markAll()
    const t = createTicket({ key: `ic:${nyDate(at)}`, title: `Investment Committee — ${dayLabel(at)}`, desc: 'Weekly IC: regime, alpha report, book reviews, rebalance approvals.', priority: 'P2', type: 'Committee', assignee: 'robert-california', reporter: 'robert-california', status: 'In Progress', plan: [{ to: 'Review', say: 'Minutes drafted.' }, { to: 'Done', by: 'jan-levinson', say: 'Minutes approved.' }] })
    sendEmail({ from: 'robert-california', cc: ['jan-levinson', 'david-wallace', 'oscar-martinez', 'dwight-schrute'], subject: `IC agenda — ${dayLabel(at)}`, body: `Michael,\n\nAgenda for this week's Investment Committee (${t.id}):\n\n1. Regime: ${S.risk?.regime ?? 'pending Dwight'} — Dwight\n2. Alpha report — Oscar${S.alphas?.longs?.length ? ` (top: ${S.alphas.longs.slice(0, 3).map(x => x.ticker).join(', ')})` : ''}\n3. Book reviews — ${books.map(x => `${x.book.short} ${fmtPct(x.mark.nav / x.book.nav - 1, 1)}`).join(', ')}\n4. Rebalance approvals waiting on you: ${S.tickets.filter(x => x.needsMichael && x.status === 'Review').length}\n5. Macro — Jan\n\nEveryone has a price. Ours is in the agenda.\n\nRobert California, CIO`, kind: 'ic', tags: ['Committee'], ticketId: t.id, at })
  }

  async function jobToby({ at }) {
    const t = createTicket({ key: `attest:${nyDate(at).slice(0, 7)}`, title: 'Monthly personal-trading attestation — Michael', desc: 'Every employee attests their personal trades monthly. You have not.', priority: 'P3', type: 'Compliance', assignee: 'toby-flenderson', reporter: 'toby-flenderson', status: 'Review', needsMichael: true })
    sendEmail({ from: 'toby-flenderson', subject: `Reminder: personal-trading attestation (${t.id})`, body: `Hi Michael,\n\nSorry to bother you. It's time for the monthly personal-trading attestation. Everybody else has done it. Well, Creed did something, I'm not sure it counts.\n\nIt's one click. I made it one click. For you.\n\nToby\nChief Compliance Officer`, kind: 'attest', actions: [{ id: 'approve', label: 'Sign attestation' }, { id: 'reject', label: 'Not now' }], ticketId: t.id, tags: ['Compliance'], at })
  }

  async function jobHolly({ at }) {
    createTicket({ key: `training:${nyDate(at).slice(0, 7)}`, title: 'Conduct training: market abuse refresher', desc: 'Annual refresher on market abuse and information barriers. 45 minutes, conference room.', priority: 'P3', type: 'Culture', assignee: 'holly-flax', reporter: 'holly-flax', plan: [{ to: 'In Progress', say: 'Booked the conference room! And snacks.' }, { to: 'Review', say: 'Session done. 24 of 26 attended. Creed was "in a meeting".' }, { to: 'Done', by: 'toby-flenderson', say: 'Attendance logged. Thank you, Holly.' }] })
    sendEmail({ from: 'holly-flax', to: ['michael'], cc: ['toby-flenderson'], subject: 'Conduct training this week 🎉', body: `Hi Michael!\n\nThis week's conduct refresher is on market abuse and information barriers. I made it fun — there's a quiz, and the prize is a mug that says "I didn't front-run."\n\nCan you open it with a few words? Not a speech. A few words.\n\nHolly`, kind: 'training', needsReply: true, tags: ['Culture'], at })
  }

  async function jobAndy({ at }) {
    const t = createTicket({ key: `client:${nyDate(at)}`, title: 'Quarterly review — Vance Refrigeration (anchor LP)', desc: 'Bob Vance wants the quarterly review in person. Andy to prep, Pam to make the deck.', priority: 'P2', type: 'Client', assignee: 'andy-bernard', reporter: 'andy-bernard', status: 'To Do' })
    sendEmail({ from: 'andy-bernard', cc: ['phyllis-vance', 'pam-beesly'], subject: 'Bob Vance wants a sit-down — can you do Thursday 2pm?', body: `Big Tuna... I mean, Michael!\n\nBob Vance (Vance Refrigeration — our anchor LP!) wants his quarterly review in person. Thursday at 2. He asked for you specifically. Well, he asked for "the guy in charge," and I said "that's Michael," and he said "fine."\n\nPhyllis has the numbers, Pam's on the deck (${t.id}). Can you make it?\n\nRock on,\nAndy Bernard, Cornell '95`, kind: 'meeting', actions: [{ id: 'approve', label: 'Accept' }, { id: 'reject', label: 'Decline' }], ticketId: t.id, tags: ['Client'], needsReply: true, at })
  }

  async function jobPam({ at }) {
    const books = markAll()
    const t = createTicket({ key: `letter:${nyDate(at)}`, title: 'Weekly LP letter — sign-off', desc: 'Weekly letter to Limited Partners with book performance and outlook.', priority: 'P2', type: 'Client', assignee: 'pam-beesly', reporter: 'pam-beesly', status: 'Review', needsMichael: true })
    sendEmail({ from: 'pam-beesly', cc: ['andy-bernard', 'toby-flenderson'], subject: `LP letter for your sign-off (${t.id})`, body: `Hi Michael,\n\nHere's this week's LP letter draft:\n\n> Dear Partners,\n> This week our books ${books.reduce((s, x) => s + x.mark.nav, 0) >= books.reduce((s, x) => s + x.book.nav, 0) ? 'continued to grow' : 'were tested'}: ${books.map(x => `${x.book.short} ${fmtPct(x.mark.nav / x.book.nav - 1, 1)}`).join(', ')} since inception. Our risk team rates conditions **${S.risk?.regime ?? 'NEUTRAL'}**.\n> — Michael Scott, Managing Partner\n\nToby already checked the disclaimers. Can you approve it so I can send it out? (No, you can't add a joke at the end. I tried.)\n\nPam`, kind: 'letter', actions: [{ id: 'approve', label: 'Approve & send' }, { id: 'changes', label: 'Request changes' }], ticketId: t.id, tags: ['Client'], at })
  }

  async function jobDavid({ at }) {
    sendEmail({ from: 'david-wallace', cc: ['jan-levinson', 'robert-california'], subject: 'Month-end numbers for the board', body: `Michael,\n\nThe board meets next week. Can you send me a short summary of last month — performance by book, any risk events, and what you're doing about them? Kevin's P&L emails are... colourful.\n\nThanks,\nDavid`, kind: 'board', needsReply: true, tags: ['Corporate'], priority: 'high', at })
  }

  async function jobCreed({ at }) {
    const lines = [
      ['Opportunity', "Michael — I've got a guy who can get us 40% of a mung bean farm in Taiwan. No paperwork. That's the opportunity. Don't tell Toby.\n\nCreed"],
      ['re: the thing', "The thing we discussed is done. If anyone asks, you were with me. In Toronto.\n\nC."],
      ['Special situation', "A company called Dunder Mifflin Paper is trading at a discount to its paper. I bought the paper. Physical. It's in the warehouse.\n\nCreed Bratton, Special Situations"],
      ['Due diligence', "Did the due diligence on the deal. It's due. I'm diligent.\n\nCreed"],
    ]
    const [s, b] = pickBy(lines, 'creed' + nyDate(at))
    sendEmail({ from: 'creed-bratton', subject: s, body: b, kind: 'creed', tags: ['Alts'], at })
  }

  /** staff asking each other for details — you're cc'd and see the answer arrive */
  const ASKS = [
    ['kevin-malone', 'angela-martin', 'Cost basis on the TLT lots?', 'Angela, for the Income Fund TLT lots — do we use FIFO or specific lot? The spreadsheet has both and I picked the one with the bigger number.', 'Specific lot identification, Kevin. It is in the procedures binder. Tab four. The beige tab. Do not pick the bigger number.', 30],
    ['jim-halpert', 'dwight-schrute', 'Working a big order into the close', 'Dwight, if I work the Flagship rebalance into the close, does that blow up your intraday VaR?', "Jim. VaR is calculated at the close. You know that. Work it in clips under 10% of volume and I will allow it. This time.", 25],
    ['karen-filippelli', 'oscar-martinez', 'Sector-neutral momentum?', 'Oscar — are we neutralising the momentum signal by sector before ranking? Feels like it is just a tech bet.', "Not yet — and you're right, half of the long book is tech. I'll add a sector-neutral version to tomorrow's report and we can compare the ICs.", 45],
    ['stanley-hudson', 'jan-levinson', 'Duration call', 'Jan. Do I need to shorten duration before the Fed meeting or not. Yes or no.', "Stanley — trim TLT to 15% and add to short-dated. I'll make it formal at IC.", 40],
    ['pam-beesly', 'kevin-malone', 'MTD numbers for the LP letter', 'Kevin, I need final month-to-date numbers by 3pm for the LP letter. The real ones, please.', 'Pam the numbers are done. I am 90% sure. Angela is checking the other 10%.', 30],
    ['erin-hannon', 'darryl-philbin', 'Phone order — Sabre or paper?', 'Darryl! A client called an order in on the phone. Do I put it in Sabre or the paper book? Or both? I did both.', 'Erin — Sabre is the book of record. Paper book is backup. Both is fine. And thank you for asking.', 20],
    ['meredith-palmer', 'carol-stills', 'Oil roll this week', 'Carol, USO rolls this week. You want to keep the real-assets weight the same or take some off?', "Keep the weight, Meredith. I'd rather add to PLD than oil here. Let's look at it Thursday.", 50],
    ['gabe-lewis', 'jim-halpert', 'Sabre OMS patch tonight', 'Jim, Sabre needs a patch tonight at 8pm. 20 minutes of downtime. Need the desk to sign off. Also, "Sabre."', 'Fine by me, Gabe. Nothing working after hours. Please stop saying "Sabre" like that.', 25],
    ['ryan-howard', 'toby-flenderson', 'Is this insider trading?', 'Toby, if I read something on a Discord about a token listing, is it insider info? Asking for the desk.', "Ryan... it depends where the Discord got it. Please don't trade it until we talk. I'm putting time on your calendar.", 30],
    ['nellie-bertram', 'oscar-martinez', 'Factor check on the ESG book', 'Oscar, darling, could you run the ESG & Thematic book through your factor model? I suspect we are simply long momentum with a halo.', "You are, mostly. Momentum loading is about 0.6. I'll send the full breakdown this afternoon.", 60],
    ['phyllis-vance', 'stanley-hudson', 'Bond ladder for the Vances', 'Stanley, Bob would like a little more income in the family account. Could you suggest a bond ladder?', '2, 4, 6, 8, 10 years, equal weights. Treasuries. It is not complicated, Phyllis. Send me the size.', 35],
  ]
  async function jobAsk({ at }) {
    const [from, to, subject, q, a, mins] = pickBy(ASKS, 'ask' + nyDate(at))
    activity(from, `✉️ Emailing ${firstOf(to)}…`)
    const m = sendEmail({ from, to: [to], cc: ['michael'], subject, body: `${q}\n\n${firstOf(from)}`, kind: 'ask', tags: ['Team'], at })
    later(mins, { type: 'reply', parent: m.id, from: to, to: from, body: `${a}\n\n${firstOf(to)}` })
  }

  const JOBS = [
    { id: 'crypto', days: 'daily', at: [hm(7, 30)], run: jobRyan },
    { id: 'systems', days: 'trading', at: [hm(7, 50)], run: jobGabe },
    { id: 'risk-am', days: 'trading', at: [hm(8, 0)], run: x => jobRisk({ ...x, morning: true }) },
    { id: 'settle', days: 'trading', at: [hm(8, 10)], run: jobDarryl },
    { id: 'alpha', days: 'trading', at: [hm(8, 20)], run: jobAlpha },
    { id: 'ic', days: ['Mon'], at: [hm(8, 30)], run: jobRobert },
    { id: 'mandate', days: 'trading', at: [hm(8, 45)], run: jobAngela },
    { id: 'macro', days: ['Mon', 'Wed', 'Fri'], at: [hm(9, 5)], run: jobJan },
    { id: 'orders', days: 'trading', at: [hm(9, 20)], run: jobJimOrders },
    { id: 'board', days: 'monthstart', at: [hm(9, 40)], run: jobDavid },
    { id: 'desk-open', days: 'trading', at: [hm(10, 0)], run: jobDeskOpen },
    { id: 'attest', days: ['Tue'], at: [hm(10, 15)], run: jobToby },
    { id: 'risk-day', days: 'trading', at: [hm(10, 30), hm(12, 30), hm(14, 30), hm(15, 45)], run: x => jobRisk({ ...x, morning: false }) },
    { id: 'client', days: ['Thu'], at: [hm(11, 0)], run: jobAndy },
    { id: 'buzz', days: 'trading', at: [hm(11, 45)], run: jobKelly },
    { id: 'ask', days: 'trading', at: [hm(13, 15)], run: jobAsk },
    { id: 'training', days: ['Wed'], at: [hm(13, 30)], run: jobHolly },
    { id: 'letter', days: ['Fri'], at: [hm(13, 0)], run: jobPam },
    { id: 'creed', days: 'trading', at: [hm(15, 10)], chance: 0.35, run: jobCreed },
    { id: 'orderlog', days: 'trading', at: [hm(16, 5)], run: jobErin },
    { id: 'eod', days: 'trading', at: [hm(16, 15)], run: jobBooksEod },
    { id: 'pnl', days: 'trading', at: [hm(16, 30)], run: jobKevin },
  ]
  const MANUAL = {
    risk: x => jobRisk({ ...x, morning: false }), alpha: jobAlpha, books: jobBooksEod, 'desk-open': jobDeskOpen, pnl: jobKevin,
    mandate: jobAngela, settle: jobDarryl, systems: jobGabe, macro: jobJan, buzz: jobKelly, crypto: jobRyan, ask: jobAsk,
  }

  // ------------------------------------------------------------- actions
  function execTrades(bookId, trades, by = 'jim-halpert', retarget = false) {
    const b = bookById(bookId), st = bookState(b)
    const date = nyDate(clock.now())
    const done = []
    for (const t of trades) {
      const s = prices.get(t.ticker)
      const px = s?.last ?? t.px
      const shares = t.notional / px
      const p = st.positions[t.ticker] ?? (st.positions[t.ticker] = { shares: 0, cost: px })
      const cash = st.positions.CASH ?? (st.positions.CASH = { shares: 0, cost: 1 })
      if (t.side === 'BUY') { p.cost = (p.cost * p.shares + px * shares) / (p.shares + shares); p.shares += shares; cash.shares -= t.notional }
      else { const q = Math.min(p.shares, shares); p.shares -= q; cash.shares += q * px }
      if (p.shares < 1e-6 && t.ticker !== 'CASH') delete st.positions[t.ticker]
      const trade = { id: `T-${++S.seq.trade}`, book: bookId, side: t.side, ticker: t.ticker, shares, px, notional: t.notional, date, by, settled: null }
      S.trades.push(trade)
      done.push(trade)
    }
    if (retarget && done.length) {
      // a discretionary trade is the PM's new target for that name — don't rebalance it away tonight
      const m = markBook(eff(b), st.positions, prices)
      const tg = { ...(st.targets ?? b.targets) }
      for (const t of done) tg[t.ticker] = m.positions.find(p => p.ticker === t.ticker)?.weight ?? 0
      tg.CASH = Math.max(0, 1 - Object.entries(tg).filter(([k]) => k !== 'CASH').reduce((a, [, w]) => a + w, 0))
      st.targets = tg
    }
    changed('books')
    return done
  }

  function handleAction(email, action) {
    if (email.handled) return { ok: false, error: 'already handled' }
    email.handled = action
    email.read = true
    const t = email.ticketId ? ticketById(email.ticketId) : null
    const yes = action === 'approve' || action === 'send'
    const k = email.kind
    if (k === 'rebalance' && email.data) {
      if (yes) {
        if (t) { t.needsMichael = false; moveTicket(t.id, 'In Progress', 'jim-halpert', 'Approved by Michael. Working the orders.') }
        later(15, { type: 'exec', book: email.data.book, trades: email.data.trades, ticketId: t?.id, parent: email.id })
        replyAs(email.from, 'michael', email, `Thanks Michael — Jim's working it now.\n\n${firstOf(email.from)}`)
      } else {
        if (t) moveTicket(t.id, 'Done', 'michael', 'Rejected by Michael — holding current weights.')
        replyAs(email.from, 'michael', email, `Understood. We'll let it run and look again tomorrow.\n\n${firstOf(email.from)}`)
      }
    } else if (k === 'hedge') {
      if (yes) {
        const fl = bookById('flagship'), st = bookState(fl)
        const mark = markBook(eff(fl), st.positions, prices)
        if (t) { t.needsMichael = false; moveTicket(t.id, 'In Progress', 'jim-halpert', 'Approved. Selling SPY.') }
        later(10, { type: 'exec', retarget: true, book: 'flagship', trades: [{ ticker: 'SPY', side: 'SELL', notional: Math.min(mark.nav * 0.05, (st.positions.SPY?.shares ?? 0) * (prices.get('SPY')?.last ?? 0)) }], ticketId: t?.id, parent: email.id })
        replyAs('dwight-schrute', 'michael', email, 'Excellent decision. Jim is executing. I will monitor him. Closely.\n\n— D')
      } else {
        if (t) moveTicket(t.id, 'Done', 'michael', 'Hedge rejected by Michael.')
        replyAs('dwight-schrute', 'michael', email, 'Noted. Under protest. The protest is also noted.\n\n— D')
      }
    } else if (k === 'limit' && email.data) {
      if (action === 'approve') {
        const b = bookById(email.data.book), st = bookState(b)
        const mark = markBook(eff(b), st.positions, prices)
        const p = mark.positions.find(x => x.ticker === email.data.ticker)
        if (p) {
          const excess = (p.weight - b.limits.single + 0.01) * mark.nav
          if (excess > 0) later(10, { type: 'exec', retarget: true, book: b.id, trades: [{ ticker: p.ticker, side: 'SELL', notional: excess }], ticketId: t?.id, parent: email.id })
        }
        if (t) { t.needsMichael = false; moveTicket(t.id, 'In Progress', 'jim-halpert', 'Trimming to 1% under the limit.') }
        replyAs('angela-martin', 'michael', email, 'Thank you. Jim is trimming it. I will confirm when it is back inside the mandate.\n\nAngela')
      } else {
        if (t) moveTicket(t.id, 'Done', 'angela-martin', 'Waiver granted by Michael. Noted in the file.')
        replyAs('angela-martin', 'michael', email, 'Waiver noted. In the file. In ink.\n\nAngela')
      }
    } else if (k === 'alpha') {
      if (action === 'send' && S.alphas) {
        const [a, b] = S.alphas.longs
        for (const x of [a, b].filter(Boolean)) createTicket({ key: `research:${x.ticker}:${nyDate(clock.now())}`, title: `Research: ${x.ticker} idea from alpha report`, desc: `Score ${x.score.toFixed(2)} — ${x.why}. Write up a thesis and sizing for the PMs.`, priority: 'P2', type: 'Research', assignee: 'karen-filippelli', reporter: 'oscar-martinez', status: 'To Do' })
        sendEmail({ from: 'oscar-martinez', to: BOOKS.map(b => b.pm), cc: ['michael'], subject: `FW: Alpha ideas — ${S.alphas.longs.map(x => x.ticker).join(', ')}`, body: `PMs,\n\nMichael asked me to send today's ideas.\n\n${S.alphas.longs.map((x, i) => `${i + 1}. **${x.ticker}** — ${x.why}`).join('\n')}\n\nAvoid: ${S.alphas.avoid.map(x => x.ticker).join(', ')}. Karen is writing up the top two.\n\nOscar`, kind: 'alpha-fw', tags: ['Research'], links: email.links })
        later(20, { type: 'email', email: { from: 'robert-california', to: ['oscar-martinez'], cc: ['michael'], subject: `Re: FW: Alpha ideas`, body: `${S.alphas.longs[0]?.ticker} interests me. Bring the write-up to IC.\n\nRC`, kind: 'reply', tags: ['Research'] } })
      } else replyAs('oscar-martinez', 'michael', email, "You're welcome. Actually, I'm glad someone reads them.\n\nOscar")
    } else if (k === 'letter') {
      if (yes) { if (t) moveTicket(t.id, 'Done', 'pam-beesly', 'Approved by Michael and sent to LPs.'); replyAs('pam-beesly', 'michael', email, 'Sent! Bob Vance already replied "Vance Refrigeration approves." 🙂\n\nPam') }
      else { if (t) { t.needsMichael = true; moveTicket(t.id, 'In Progress', 'pam-beesly', 'Changes requested — revising.') } replyAs('pam-beesly', 'michael', email, "Okay, I'll revise it. What would you like changed? (Please not the font again.)\n\nPam"); later(60, { type: 'ticket', id: t?.id, status: 'Review', by: 'pam-beesly', say: 'Revised draft ready.' }) }
    } else if (k === 'attest') {
      if (yes) { if (t) moveTicket(t.id, 'Done', 'toby-flenderson', 'Signed by Michael.'); replyAs('toby-flenderson', 'michael', email, "Oh! Thank you, Michael. That's... that's really great. Thanks.\n\nToby") }
      else replyAs('toby-flenderson', 'michael', email, "Okay. I'll... remind you tomorrow. Sorry.\n\nToby")
    } else if (k === 'meeting') {
      if (yes) { if (t) moveTicket(t.id, 'In Progress', 'andy-bernard', 'Michael confirmed Thursday 2pm. Prepping.'); replyAs('andy-bernard', 'michael', email, "YES! Thursday at 2. I'll have Pam do the deck and I'll do a little a cappella intro. Kidding. Unless?\n\nAndy") }
      else { if (t) moveTicket(t.id, 'Done', 'andy-bernard', 'Michael declined — Phyllis will run it.'); replyAs('andy-bernard', 'michael', email, "Copy that. Phyllis will take it. She's great with Bob. Obviously.\n\nAndy") }
    } else if (k === 'ticket-review' && t) {
      if (yes) { moveTicket(t.id, 'Done', 'michael', 'Approved by Michael.'); replyAs(email.from, 'michael', email, `Thanks — closed ${t.id}.\n\n${firstOf(email.from)}`) }
      else { t.needsMichael = true; moveTicket(t.id, 'In Progress', email.from, 'Changes requested by Michael.'); replyAs(email.from, 'michael', email, `Got it — I'll rework ${t.id} and send it back.\n\n${firstOf(email.from)}`); later(60, { type: 'ticket', id: t.id, status: 'Review', by: email.from, say: 'Reworked — back for review.' }) }
    } else if (k === 'datafeed') {
      replyAs('gabe-lewis', 'michael', email, "Thanks. I'll update the ticket when the vendor gets back to me.\n\nGabe")
    }
    changed('emails')
    return { ok: true }
  }

  /** Michael approves / rejects straight from the board */
  function onBoardMove(t, status) {
    if (!t.needsMichael) return
    const email = S.emails.find(e => e.ticketId === t.id && e.actions && !e.handled)
    if (status === 'Done' && email) handleAction(email, email.actions[0].id)
    if (status === 'Done') t.needsMichael = false
  }

  // ----------------------------------------------------------- replies
  const llmOn = () => loadDeskConfig().llm !== 'offline' && claudeAvailable()

  function context() {
    const books = S.books && BOOKS.map(b => {
      const st = S.books[b.id]
      if (!st?.positions) return null
      const m = markBook(eff(b), st.positions, prices)
      return `${b.short} ${fmtUsd(m.nav)} (${fmtPct(m.dayRet, 2)} today)`
    }).filter(Boolean).join('; ')
    return [
      S.risk ? `Risk regime: ${S.risk.regime} (as of ${timeLabel(S.risk.at)}).` : '',
      books ? `Books: ${books}.` : '',
      S.alphas?.longs?.length ? `Alpha report top ideas: ${S.alphas.longs.map(x => x.ticker).join(', ')}.` : '',
      `Open tickets: ${S.tickets.filter(t => t.status !== 'Done').length}.`,
    ].filter(Boolean).join(' ')
  }

  async function staffReply(slug, email, text) {
    const e = emp(slug)
    if (llmOn()) {
      try {
        const cfg = loadDeskConfig()
        const th = thread(email.threadId).slice(-6).map(m => `From: ${nameOf(m.from)}\nSubject: ${m.subject}\n${m.body.slice(0, 1500)}`).join('\n---\n')
        const prompt = `${personaBlock(e)}\n\nYou work at ${FIRM.fullName}, a trading firm. ${context()}\n\nEmail thread so far:\n${th}\n---\nFrom: Michael Scott (Managing Partner)\n${text}\n\nWrite ${e.name}'s reply email to Michael: in character, about the work, under 120 words, plain text, no subject line, sign off with your first name. If he asked for something you can't know, say what you'll find out.`
        const out = await runClaude(prompt, { model: cfg.model || undefined, timeoutSec: 60 })
        if (out) return out.trim()
      } catch {}
    }
    return `${opsAnswer(slug, text) ?? offlineReply(e, text, { preferJob: true })}\n\n${firstOf(slug)}`
  }

  /** offline: answer work questions from the firm's actual numbers */
  function opsAnswer(slug, text) {
    const t = text.toLowerCase()
    const books = markAll()
    const firmNav = books.reduce((a, x) => a + x.mark.nav, 0), pnl = books.reduce((a, x) => a + x.mark.dayPnl, 0)
    const mine = books.find(x => x.book.pm === slug || x.book.team.includes(slug))
    const open = S.tickets.filter(x => x.assignee === slug && x.status !== 'Done')
    if (/\b(p&l|pnl|profit|loss|made|lost|how much money|performance|returns?)\b/.test(t)) {
      const b = mine && !/\bfirm|total|overall|all\b/.test(t) ? mine : null
      return b
        ? `${b.book.short} is ${fmtUsd(b.mark.dayPnl)} today (${fmtPct(b.mark.dayRet, 2)}), NAV ${fmtUsd(b.mark.nav)}, ${fmtPct(b.mark.nav / b.book.nav - 1, 2)} since inception. Best today: ${[...b.mark.positions].sort((x, y) => y.dayPnl - x.dayPnl)[0]?.ticker}.`
        : `Firm-wide we're ${fmtUsd(pnl)} today (${fmtPct(pnl / (firmNav - pnl), 2)}) on ${fmtUsd(firmNav)}. ${books.map(x => `${x.book.short} ${fmtUsd(x.mark.dayPnl)}`).join(', ')}.`
    }
    if (/\b(risk|regime|vix|var|hedge|worried|safe|drawdown|volatil\w*)\b/.test(t) && S.risk) {
      const watch = S.risk.rows.filter(r => r.status !== 'ok').map(r => `${r.name}: ${r.note}`).slice(0, 3)
      const b = mine ? S.risk.books.find(x => x.id === mine.book.id) : null
      return `As of ${timeLabel(S.risk.at)} we're ${S.risk.regime} (score ${S.risk.score}). ${watch.length ? `Watching ${watch.join('; ')}.` : 'Indicators are green.'}${b ? ` ${b.name} VaR is ${fmtUsd(b.var95)} (${(b.varPct * 100).toFixed(2)}% of NAV).` : ''}`
    }
    if (/\b(alphas?|ideas?|signals?|what should (we|i) buy|picks?|research)\b/.test(t) && S.alphas) {
      return `From this morning's alpha report: longs ${S.alphas.longs.slice(0, 3).map(x => `${x.ticker} (${x.why})`).join('; ')}. Avoid ${S.alphas.avoid.slice(0, 3).map(x => x.ticker).join(', ')}. ${S.alphas.stats.filter(x => x.verdict !== 'weak').length} of ${S.alphas.stats.length} signals are usable.`
    }
    if (/\b(book|portfolio|positions?|holdings?|weights?|exposure)\b/.test(t) && mine) {
      const top = mine.mark.positions.filter(p => p.ticker !== 'CASH').slice(0, 4)
      return `${mine.book.short}: ${fmtUsd(mine.mark.nav)}. Biggest positions ${top.map(p => `${p.ticker} ${(p.weight * 100).toFixed(1)}%`).join(', ')}; cash ${((mine.mark.positions.find(p => p.ticker === 'CASH')?.weight ?? 0) * 100).toFixed(1)}%. Largest drift: ${mine.mark.maxDrift.ticker ?? '—'} ${fmtPct(mine.mark.maxDrift.drift)}.`
    }
    if (/\b(tickets?|working on|status|update|plate|board|tasks?|progress)\b/.test(t) && open.length) {
      return `I've got ${open.length} open ticket${open.length > 1 ? 's' : ''}: ${open.slice(0, 3).map(x => `${x.id} ${x.title} (${x.status})`).join('; ')}.`
    }
    return null
  }

  const ORDER_RE = /\b(buy|sell|add|trim|reduce|cut|short)\b/i
  /** "buy $2M NVDA in the Flagship and trim TSLA in Thematic" → one order per clause */
  function parseOrders(text) {
    const out = []
    let book = BOOKS[0], side = null
    for (const clause of text.split(/\band\b|[,;]|\bthen\b|\balso\b/i)) {
      const low = clause.toLowerCase()
      const b = BOOKS.find(x => low.includes(x.short.toLowerCase()) || low.includes(x.id) || x.name.toLowerCase().split(/\W+/).some(w => w.length > 5 && low.includes(w)))
      if (b) book = b
      const sd = ORDER_RE.exec(clause)?.[1]?.toLowerCase()
      if (sd) side = ['buy', 'add'].includes(sd) ? 'BUY' : 'SELL'
      const tickers = tickersInText(clause)
      if (!side || !tickers.length) continue
      const amt = /\$?\s?(\d+(?:\.\d+)?)\s*(m|mm|million|k|thousand)\b/i.exec(clause)
      const notional = amt ? Number(amt[1]) * (/^(k|thousand)/i.test(amt[2]) ? 1e3 : 1e6) : null
      for (const t of tickers.slice(0, 3)) out.push({ ticker: classify(t).ticker, side, notional, book: book.id })
    }
    return out.length ? out : null
  }

  async function michaelReplied(email, text) {
    await refreshPrices().catch(() => {})
    const root = thread(email.threadId)[0] ?? email
    const target = email.from === 'michael' ? email.to[0] : email.from
    if (!emp(target)) return
    // "approve" / "go ahead" in a reply to something with buttons counts as a click
    if (root.actions && !root.handled) {
      if (/\b(approved?|go ahead|do it|yes|lgtm|sounds good|ship it|sign(ed)?|accept)\b/i.test(text)) return handleAction(root, root.actions[0].id)
      if (/\b(reject(ed)?|decline|hold off|don'?t|no)\b/i.test(text) && root.actions[1]) return handleAction(root, root.actions[1].id)
    }
    if (root.kind === 'orders' || (target === 'jim-halpert' && ORDER_RE.test(text))) {
      const orders = parseOrders(text)
      if (orders?.length) {
        const ids = []
        for (const o of orders) {
          const b = bookById(o.book), st = bookState(b)
          const mark = markBook(eff(b), st.positions, prices)
          const pos = mark.positions.find(p => p.ticker === o.ticker)
          o.notional = o.notional ?? (o.side === 'BUY' ? mark.nav * 0.01 : (pos?.value ?? 0) * 0.25)
          if (o.side === 'SELL' && pos) o.notional = Math.min(o.notional, pos.value)
          if (!o.notional || (o.side === 'SELL' && !pos)) continue
          const t = createTicket({ title: `Work order: ${o.side} ${fmtUsd(o.notional)} ${o.ticker} (${b.short})`, desc: `From Michael: "${text.slice(0, 200)}"`, priority: 'P1', type: 'Trading', assignee: 'jim-halpert', reporter: 'michael', status: 'In Progress', book: b.id })
          ids.push(t.id)
          later(20 + ids.length * 5, { type: 'exec', retarget: true, book: b.id, trades: [{ ticker: o.ticker, side: o.side, notional: o.notional }], ticketId: t.id, parent: email.id })
        }
        if (ids.length) {
          activity('jim-halpert', '📞 Working your order…')
          replyAs('jim-halpert', 'michael', email, `On it. Ticketed as ${ids.join(', ')}. I'll work ${orders.filter(o => o.notional).map(o => `${o.side === 'BUY' ? 'buy' : 'sell'} ${fmtUsd(o.notional)} ${o.ticker} (${bookById(o.book).short})`).join(' and ')} with limit orders and send you the fills.\n\nJim`)
          return
        }
      }
    }
    if (root.kind === 'board') {
      replyAs('david-wallace', 'michael', email, `Thanks, Michael. This is helpful — I'll take it to the board.\n\nDavid`)
      return
    }
    const body = await staffReply(target, email, text)
    replyAs(target, 'michael', email, body)
  }

  // ------------------------------------------------------------- queue
  function runQueue(now) {
    const due = S.queue.filter(q => q.due <= now).sort((a, b) => a.due - b.due)
    if (!due.length) return
    S.queue = S.queue.filter(q => q.due > now)
    for (const q of due) {
      try {
        if (q.type === 'reply') {
          const parent = S.emails.find(e => e.id === q.parent)
          if (parent) { replyAs(q.from, q.to, parent, q.body, { at: q.due }); activity(q.from, `✉️ Replying to ${firstOf(q.to)}…`) }
        } else if (q.type === 'email') sendEmail({ ...q.email, at: q.due })
        else if (q.type === 'ticket' && q.id) moveTicket(q.id, q.status, q.by, q.say)
        else if (q.type === 'exec') {
          const fills = execTrades(q.book, q.trades.filter(t => t.notional > 0), 'jim-halpert', !!q.retarget)
          if (q.ticketId) moveTicket(q.ticketId, 'Done', 'jim-halpert', `Filled: ${fills.map(f => `${f.side} ${Math.round(f.shares).toLocaleString()} ${f.ticker} @ ${fmtPx(f.px)}`).join(', ') || 'nothing to do'}.`)
          const parent = S.emails.find(e => e.id === q.parent)
          if (fills.length) {
            sendEmail({ from: 'jim-halpert', to: ['michael'], cc: ['darryl-philbin', 'erin-hannon', 'kevin-malone'], subject: `Filled — ${bookById(q.book).short}: ${fills.map(f => `${f.side} ${f.ticker}`).join(', ')}`, body: `Michael,\n\nDone:\n\n${table(['Trade', 'Side', 'Ticker', 'Shares', 'Price', 'Notional'], fills.map(f => [f.id, f.side, f.ticker, Math.round(f.shares).toLocaleString(), fmtPx(f.px), fmtUsd(f.notional)]))}\n\nSettles T+1. Darryl has it.\n\nJim`, kind: 'fill', tags: ['Trading'], threadId: parent?.threadId, ticketId: q.ticketId })
            activity('jim-halpert', `✅ Filled ${fills.map(f => f.ticker).join(', ')}`)
            post('jim-halpert', `✅ Filled for the ${bookById(q.book).short}: ${fills.map(f => `${f.side} ${fmtUsd(f.notional)} ${f.ticker}`).join(', ')}.`)
          }
        }
      } catch (e) { console.warn('[ops] queue item failed:', e.message) }
    }
    save()
  }

  // ------------------------------------------------------------- seed
  function seed(now) {
    const T = (title, priority, type, assignee, reporter, status, desc, plan, extra = {}) => createTicket({ title, priority, type, assignee, reporter, status, desc, plan, ...extra })
    T('Sabre OMS: FIX drop-copy disconnects at the open', 'P1', 'Tech', 'gabe-lewis', 'jim-halpert', 'In Progress', 'Drop-copy session to the prime broker drops for ~40s at 9:30 most days. Fills reconcile late.', [{ to: 'In Progress', say: 'Vendor says it is a heartbeat timeout. Testing a longer interval tonight.' }, { to: 'Review', say: 'Patched heartbeat to 30s. No drops this morning.' }, { to: 'Done', by: 'jim-halpert', say: 'Clean open two days running. Closing.' }])
    T('Stress test: +100bp rates shock on the Income Fund', 'P1', 'Risk', 'dwight-schrute', 'robert-california', 'To Do', 'Parallel +100bp shift, credit spreads +50bp. Report loss vs. the 6% drawdown limit.', [{ to: 'In Progress', say: 'Running the shock. Stanley is not cooperating.' }, { to: 'Review', say: 'Loss under the shock: about 5.1% of NAV. Inside the limit. Barely.' }, { to: 'Done', by: 'robert-california', say: 'Reviewed at IC. Good work.' }])
    T('Reconcile custodian cash vs. book — Income Fund', 'P2', 'Ops', 'roy-anderson', 'darryl-philbin', 'To Do', 'Month-end cash rec. Custodian statement vs. Sabre.')
    T('Refresh LLY GLP-1 model before earnings', 'P2', 'Research', 'karen-filippelli', 'oscar-martinez', 'In Progress', 'Update volume assumptions and pricing for the new indication.')
    T('Q3 LP letter — final draft', 'P2', 'Client', 'pam-beesly', 'andy-bernard', 'In Progress', 'Quarterly letter to Limited Partners.', [{ to: 'Review', say: 'Final draft ready — needs Michael.' }], { needsMichael: true })
    T('Fix rounding in the daily P&L sheet ("Kevin cents")', 'P3', 'Finance', 'kevin-malone', 'angela-martin', 'Backlog', 'Daily P&L is off by a few cents most days. Find the formula.', [{ to: 'To Do', say: 'Found it. Maybe.' }, { to: 'In Progress', say: 'It was a ROUNDDOWN. I made it ROUNDUP. More money.', by: 'kevin-malone' }, { to: 'Review', say: 'Fixed for real. Angela, please check.' }, { to: 'Done', by: 'angela-martin', say: 'Correct. Finally.' }])
    T('VWAP slicing for orders > $5M', 'P2', 'Trading', 'jim-halpert', 'dwight-schrute', 'Backlog', 'Large orders should be sliced over the session, max 10% of volume.')
    T('Move BTC to a qualified custodian', 'P1', 'Digital', 'ryan-howard', 'toby-flenderson', 'To Do', 'Compliance requires qualified custody for client crypto. Currently on an exchange.', [{ to: 'In Progress', say: 'Talking to three custodians. One of them is a guy I met at a party.' }, { to: 'In Progress', say: 'Shortlisted two regulated ones. Dropped the party guy.', progress: true }, { to: 'Review', say: 'Signed with a regulated custodian. Toby?' }, { to: 'Done', by: 'toby-flenderson', say: 'Paperwork checks out. Thank you, Ryan.' }])
    T('Mandate engine: add issuer concentration check', 'P2', 'Compliance', 'angela-martin', 'toby-flenderson', 'In Progress', 'Catch the same issuer held across stock + bond lines.')
    T('Social sentiment tracker', 'P3', 'Intel', 'kelly-kapoor', 'ryan-howard', 'Backlog', 'Track retail chatter on our top 20 holdings. Not from Kelly\'s phone.')
    T('Annual conduct training schedule', 'P3', 'Culture', 'holly-flax', 'toby-flenderson', 'To Do', 'Book sessions for all 26 staff.')
    T('Due diligence: private credit fund (Creed\'s "guy")', 'P2', 'Alts', 'creed-bratton', 'robert-california', 'Backlog', 'Proper DD before any commitment. Toby to review.')
    sendEmail({ from: 'pam-beesly', to: ['michael'], subject: 'Welcome to the new inbox! 📬', body: `Hi Michael,\n\nGabe set up the firm's inbox and project board. From now on:\n\n- **Dwight** sends risk checks (8:00 and through the day) — market indicators, regime, VaR.\n- **Oscar & Karen** send the alpha report at 8:20 — every signal back-tested, with the ones you can use.\n- The **PMs** send their books at the close, and rebalance proposals come to you for approval.\n- **Jim** asks for your orders at 9:20 — just reply "buy NVDA" and he'll work it.\n- Everyone else emails when they need something from you.\n\nThe **Board** tab has all our tickets. Drag them, or click one to move it.\n\nPam`, kind: 'note', tags: ['Team'], at: now })
  }

  // ------------------------------------------------------------- loop
  async function tick() {
    if (busy) return
    busy = true
    try {
      const now = clock.now()
      if (S.queue.some(q => q.due <= now)) await refreshPrices().catch(() => {})
      runQueue(now)
      const due = []
      for (const job of JOBS) {
        const occ = latestOccurrence(job, now)
        if (occ == null) continue
        if (occ > (S.lastRun[job.id] ?? 0)) due.push({ job, occ })
      }
      due.sort((a, b) => a.occ - b.occ)
      for (const { job, occ } of due) {
        S.lastRun[job.id] = occ
        if (job.chance && seededChance(job.id + occ) > job.chance) continue
        if (now - occ > 20 * 3600e3) continue          // long ago (you skipped past it) — don't replay
        try {
          await refreshPrices()
          await job.run({ at: occ, now })
        } catch (e) { console.warn(`[ops] job ${job.id} failed:`, e.message) }
        save()
        await sleep(900)
      }
      workTickets(now)
    } finally { busy = false }
  }

  async function boot() {
    if (S.booted) return
    const now = clock.now()
    await refreshPrices(true)
    seed(now)
    // the day so far: what's already happened today shows up in the inbox
    for (const job of JOBS) S.lastRun[job.id] = latestOccurrence(job, now) ?? 0
    for (const b of BOOKS) bookState(b)
    const p = nyParts(now)
    const at = now
    await jobGabe({ at }).catch(() => {})
    await jobRisk({ at, morning: true }).catch(e => console.warn('[ops] risk', e.message))
    await jobAlpha({ at }).catch(e => console.warn('[ops] alpha', e.message))
    if (marketPhase(now) === 'open') await jobDeskOpen({ at }).catch(() => {})
    else if (marketPhase(now) === 'after') { await jobBooksEod({ at }).catch(() => {}); await jobKevin({ at }).catch(() => {}) }
    else await jobJimOrders({ at }).catch(() => {})
    S.lastWork = now
    S.booted = true
    save()
    changed('all')
  }

  let timer = null
  function start() {
    refreshPrices(true).catch(() => {}).then(() => boot()).catch(e => console.warn('[ops] boot failed:', e.message)).finally(() => {
      timer = setInterval(() => tick().catch(() => {}), 15_000)
      timer.unref?.()
    })
  }

  // ------------------------------------------------------------- API
  function books() {
    return BOOKS.map(b => {
      const st = S.books[b.id]
      if (!st?.positions || !prices.size) return { id: b.id, name: b.name, short: b.short, pm: b.pm, pmName: nameOf(b.pm), team: b.team, nav: b.nav, positions: [] }
      const mark = markBook(eff(b), st.positions, prices)
      const risk = bookRisk(b, mark, prices, st.peakNav)
      return {
        id: b.id, name: b.name, short: b.short, pm: b.pm, pmName: nameOf(b.pm), team: b.team, inception: b.nav, nav: mark.nav, dayPnl: mark.dayPnl, dayRet: mark.dayRet,
        sinceInception: mark.nav / b.nav - 1, positions: mark.positions.map(p => ({ ticker: p.ticker, name: p.name, px: p.px, dayChg: p.dayChg, value: p.value, weight: p.weight, target: p.target, drift: p.drift, dayPnl: p.dayPnl, upnl: p.upnl, source: p.source })),
        risk: { varPct: risk.varPct, var95: risk.var95, vol: risk.vol, beta: risk.beta, drawdown: risk.drawdown, breaches: risk.breaches.map(x => x.text) }, limits: b.limits,
        history: st.history ?? [], sources: mark.sources,
      }
    })
  }

  async function state() {
    if (Date.now() - pricesAt > 3 * MIN || Math.abs(clock.now() - pricesFor) > 10 * MIN) await refreshPrices().catch(() => {})
    const now = clock.now()
    const inbox = S.emails.filter(e => e.to.includes('michael') || e.cc.includes('michael') || e.from === 'michael')
    const p = nyParts(now)
    const sprintNo = Math.floor((Date.UTC(...p.date.split('-').map((x, i) => (i === 1 ? x - 1 : +x))) - Date.UTC(2026, 0, 5)) / (14 * DAY)) + 1
    return {
      now, phase: marketPhase(now),
      sprint: { name: `Sprint ${sprintNo}` },
      emails: inbox.slice(-250).map(e => ({ ...e, fromName: nameOf(e.from), toNames: e.to.map(nameOf), ccNames: e.cc.map(nameOf) })),
      unread: inbox.filter(e => !e.read).length,
      tickets: S.tickets.map(t => ({ ...t, plan: undefined, assigneeName: nameOf(t.assignee), reporterName: nameOf(t.reporter) })),
      risk: S.risk, alphas: S.alphas, books: books(),
      trades: S.trades.slice(-40).reverse(),
      schedule: JOBS.map(j => ({ id: j.id, days: j.days, at: j.at })),
      columns: COLUMNS,
    }
  }

  return {
    start, tick, state,
    context: () => { try { return context() } catch { return '' } },
    answer: (slug, text) => { try { return prices.size ? opsAnswer(slug, text) : null } catch { return null } },
    readEmail(id, read = true) { const e = S.emails.find(x => x.id === id); if (!e) return { ok: false }; e.read = read; changed('emails'); return { ok: true } },
    readAll() { for (const e of S.emails) e.read = true; changed('emails'); return { ok: true } },
    async action(id, action) { const e = S.emails.find(x => x.id === id); if (!e || !e.actions?.some(a => a.id === action)) return { ok: false, error: 'no such action' }; await refreshPrices().catch(() => {}); return handleAction(e, action) },
    async reply(id, text) {
      const e = S.emails.find(x => x.id === id)
      if (!e) return { ok: false }
      e.read = true
      const target = e.from === 'michael' ? e.to[0] : e.from
      const mine = sendEmail({ from: 'michael', to: [target], cc: [...new Set([...e.to, ...e.cc].filter(x => x !== 'michael' && x !== target))], subject: reSubject(e.subject), body: text, threadId: e.threadId, kind: 'reply' })
      setTimeout(() => michaelReplied(mine, text).catch(err => console.warn('[ops] reply failed:', err.message)), 2500)
      return { ok: true, id: mine.id }
    },
    async compose(to, subject, body) {
      if (!emp(to)) return { ok: false, error: 'unknown recipient' }
      const m = sendEmail({ from: 'michael', to: [to], subject: subject || '(no subject)', body, kind: 'note' })
      setTimeout(() => michaelReplied(m, `${subject}\n${body}`).catch(() => {}), 3000)
      return { ok: true, id: m.id }
    },
    createTicket(t) {
      if (!t.title) return { ok: false, error: 'title required' }
      const x = createTicket({ title: String(t.title).slice(0, 140), desc: String(t.desc ?? '').slice(0, 2000), priority: ['P0', 'P1', 'P2', 'P3'].includes(t.priority) ? t.priority : 'P2', type: String(t.type ?? 'General').slice(0, 20), assignee: emp(t.assignee) ? t.assignee : 'jim-halpert', reporter: 'michael', status: COLUMNS.includes(t.status) ? t.status : 'To Do' })
      sendEmail({ from: x.assignee, subject: `Re: ${x.id} ${x.title}`, body: `Got it, Michael — ${x.id} is on my board. ${x.priority === 'P0' ? 'Dropping everything.' : x.priority === 'P1' ? "I'll get on it today." : "I'll get to it this sprint."}\n\n${firstOf(x.assignee)}`, kind: 'reply', tags: [x.type], ticketId: x.id, at: clock.now() + 2 * MIN })
      return { ok: true, ticket: x }
    },
    async updateTicket(id, b) {
      await refreshPrices().catch(() => {})
      const t = ticketById(id)
      if (!t) return { ok: false }
      if (b.priority && ['P0', 'P1', 'P2', 'P3'].includes(b.priority)) t.priority = b.priority
      if (b.assignee && emp(b.assignee)) t.assignee = b.assignee
      if (b.comment) t.comments.push({ by: 'michael', text: String(b.comment).slice(0, 1000), at: clock.now() })
      if (b.status && COLUMNS.includes(b.status) && b.status !== t.status) { moveTicket(id, b.status, 'michael'); onBoardMove(t, b.status) }
      t.updated = clock.now()
      changed('tickets')
      return { ok: true, ticket: t }
    },
    async run(job) {
      const f = MANUAL[job]
      if (!f) return { ok: false, error: `jobs: ${Object.keys(MANUAL).join(', ')}` }
      await refreshPrices()
      await f({ at: clock.now(), now: clock.now() })
      save()
      return { ok: true }
    },
    jobs: Object.keys(MANUAL),
  }
}
