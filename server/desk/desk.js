/**
 * desk.js — the Dunder Mifflin Capital portfolio desk.
 *
 * Give it a portfolio and the office goes to work:
 *   Erin logs it → Michael calls everyone in → Kevin runs the numbers →
 *   Dwight / Oscar / Stanley / Kelly / Ryan / Angela (+ Meredith / Carol when relevant)
 *   analyse it in parallel as separate AI agents → desk huddle (in-character argument) →
 *   Jim builds the execution plan → Pam writes the client report → Toby adds the
 *   disclaimer → Michael signs off.
 *
 * Each analyst walks into the pixel office, works at a desk, posts in the chat,
 * and leaves when done. The full write-up lands in reports/<id>/report.md and
 * is served at http://127.0.0.1:3334/reports/<id>.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import { emp, empByRole, loadDeskConfig, PROJECT_DIR, FIRM } from './roster.js'
import { analyseBook, bookForPrompt, buildTrades, normaliseTargets, projectWeights } from './analytics.js'
import { classify } from './classify.js'
import { claudeAvailable, runClaude, extractJson } from './llm.js'
import { analystPrompt, huddlePrompt, executionPrompt, reportPrompt, kickoffLine } from './prompts.js'
import { offline } from './offline.js'
import { buildReportMarkdown, reportHtml } from './report.js'
import { onCall, meeting } from './staff.js'

const REPORTS_DIR = join(PROJECT_DIR, 'reports')
const STATE_DIR = join(homedir(), '.agent-office')
const LATEST_FILE = join(STATE_DIR, 'desk-latest.json')
const SERVER_URL = 'http://127.0.0.1:3334'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Analysts that always work a book, in the order they're called in
const CORE_ANALYSTS = ['risk-manager', 'quant-researcher', 'income-strategist', 'sentiment-analyst', 'digital-assets', 'fund-controller']

const SECTION_HEADINGS = {
  'pnl-controller': "Kevin's numbers (P&L & reconciliation)",
  'risk-manager': 'Risk management',
  'quant-researcher': 'Quant & fundamental research',
  'income-strategist': 'Income & rates',
  'sentiment-analyst': 'Market sentiment',
  'digital-assets': 'Digital assets & alternatives',
  'commodities-trader': 'Commodities',
  'real-assets': 'Real estate & real assets',
  'fund-controller': 'Mandate compliance',
}

const WORK_STATUS = {
  'pnl-controller': 'adding it up (calculator is helping)',
  'risk-manager': 'stress-testing the book. Bears. Beets. Drawdowns.',
  'quant-researcher': 'running correlations, actually',
  'income-strategist': 'clipping coupons until 5pm',
  'sentiment-analyst': 'checking the timeline OMG',
  'digital-assets': 'disrupting the allocation',
  'fund-controller': 'auditing against the mandate. In pen.',
  'commodities-trader': 'checking gold. and the bar menu',
  'real-assets': 'checking cap rates',
  'client-reporting': 'making the report look nice',
}

function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'book' }

function runId(client) {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${slugify(client)}`
}

async function pool(items, size, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

function withinLimits(targets, limits) {
  for (const t of targets) {
    if (t.ticker !== 'CASH' && !t.info?.fund && t.target > limits.maxPosition + 0.5) return false
  }
  const spec = targets.filter(t => t.info?.spec || t.info?.cls === 'crypto').reduce((s, t) => s + t.target, 0)
  if (spec > limits.maxSpec + 0.5) return false
  const cash = targets.find(t => t.ticker === 'CASH')?.target ?? 0
  return cash >= limits.cashMin - 0.5 && cash <= limits.cashMax + 0.5
}

export function createDesk({ broadcast, addMessage, activeAgents }) {
  let running = null
  let latest = null
  try { if (existsSync(LATEST_FILE)) latest = JSON.parse(readFileSync(LATEST_FILE, 'utf8')) } catch {}

  // ---- chat + office helpers -------------------------------------------------
  function say(slugOrEmp, text) {
    const e = typeof slugOrEmp === 'string' ? emp(slugOrEmp) : slugOrEmp
    if (!e || !text) return
    const msg = addMessage({ sender: e.name, role: e.role, text: String(text).slice(0, 2000) })
    broadcast({ type: 'chat_message', ...msg })
  }
  function system(text) {
    const msg = addMessage({ sender: 'system', text, isSystem: true })
    broadcast({ type: 'chat_message', ...msg, isSystem: true })
  }
  function walkIn(e, id, task) {
    const record = { id, name: e.short, role: e.role, task, state: 'new-hire', spawnedAt: Date.now(), desk: true }
    activeAgents.set(id, record)
    broadcast({ type: 'agent_spawned', agent: record, timestamp: Date.now() })
  }
  function working(id, status) {
    const a = activeAgents.get(id)
    if (a) { a.state = 'working'; a.status = status }
    broadcast({ type: 'agent_working', agentId: id, status, desk: true, timestamp: Date.now() })
  }
  function walkOut(id, result) {
    // Staff you called onto the floor stay there after helping with the book
    if ([...onCall.values()].some(v => v.id === id)) return
    const a = activeAgents.get(id)
    if (a) { a.state = 'completed'; setTimeout(() => activeAgents.delete(id), 40_000) }
    broadcast({ type: 'agent_completed', agentId: id, result: String(result || '').slice(0, 120), desk: true, timestamp: Date.now() })
  }
  function deskUpdate(extra = {}) {
    broadcast({ type: 'desk_update', ...publicStatus(), ...extra, timestamp: Date.now() })
  }

  function tickerSummary(book) {
    if (!book) return null
    return {
      id: book.id, client: book.clientName, totalValue: book.totalValue,
      positions: book.positions.map(p => ({ ticker: p.ticker, weight: p.weight, pnlPct: p.pnlPct, ret1y: p.ret1y })),
      vol: book.risk.vol, var95: book.risk.var95_1d, failing: book.checks.filter(c => !c.pass).length,
    }
  }

  function publicStatus() {
    return {
      status: running ? 'running' : 'idle',
      stage: running?.stage,
      running: running ? { id: running.id, client: running.client, startedAt: running.startedAt } : null,
      book: running?.book ?? null,   // the book currently on the desk (ticker tape shows this while running)
      latest,
    }
  }

  // ---- one agent turn --------------------------------------------------------
  async function agentTurn(ctx, role, promptFn, offlineFn, { walk = true, minMs = 6000 } = {}) {
    const e = empByRole(role)
    const onFloor = onCall.get(role)
    const id = onFloor?.id ?? `desk-${ctx.id}-${role}`
    const t0 = Date.now()
    if (walk) {
      if (!onFloor) {
        walkIn(e, id, `${e.short}: ${ctx.book.clientName}`.slice(0, 50))
        await sleep(1200)
      }
      working(id, WORK_STATUS[role] ?? 'working the book')
    }
    let out = null
    let mode = 'offline'
    if (ctx.useLLM) {
      try {
        const text = await runClaude(promptFn(), { model: ctx.cfg.model, liveResearch: ctx.cfg.liveResearch, timeoutSec: ctx.cfg.timeoutSec })
        out = extractJson(text)
        if (out) mode = 'llm'
        else console.warn(`[desk] ${role}: reply wasn't JSON, using template`)
      } catch (err) {
        console.warn(`[desk] ${role}: LLM failed (${err.message}), using template`)
      }
    }
    if (!out) out = offlineFn()
    const elapsed = Date.now() - t0
    if (elapsed < minMs) await sleep(minMs - elapsed)
    return { e, id, out, mode }
  }

  // ---- the run ---------------------------------------------------------------
  async function run(parsed, { requestedBy = 'Boss' } = {}) {
    if (running) throw new Error(`The desk is busy with ${running.client}. Try again when Michael finishes his speech.`)
    if (!parsed.positions.length) throw new Error('No positions found. Try: /portfolio AAPL 30%, MSFT 20%, TLT 30%, CASH 20%')

    const cfg = loadDeskConfig()
    const client = parsed.mandate.clientName || 'House Account'
    const id = runId(client)
    running = { id, client, startedAt: Date.now(), stage: 'intake' }
    const ctx = { id, cfg, useLLM: cfg.llm === 'claude' && claudeAvailable() }
    deskUpdate()

    const visuals = []
    try {
      say('erin-hannon', `${FIRM.name}, this is Erin! I logged ${parsed.positions.filter(p => p.ticker !== "CASH").length} positions for ${client}${parsed.mandate.raw ? ` (${parsed.mandate.risk} mandate)` : ''}. Routing it to the desk! I think.`)
      if (cfg.llm === 'claude' && !ctx.useLLM) system('⚠️ Claude CLI not found — the desk is running on templates (offline mode). Install Claude Code for full AI analysis.')

      running.stage = 'pricing'
      deskUpdate()
      const book = await analyseBook(parsed, { marketData: cfg.marketData, id })
      ctx.book = book
      const bookJson = bookForPrompt(book)
      running.stage = 'analysis'
      running.book = tickerSummary(book)
      deskUpdate()
      await sleep(cfg.paceMs / 2)
      say('michael-scott', kickoffLine(book))
      if (book.risk.source === 'model' && cfg.marketData !== 'off') system('📉 Live prices unavailable — risk uses model estimates. Add "@price" to positions for exact values.')

      // Kevin first — everyone else needs his numbers
      const kevin = await agentTurn(ctx, 'pnl-controller', () => analystPrompt(empByRole('pnl-controller'), bookJson), () => offline['pnl-controller'](book), { minMs: 4000 })
      visuals.push(kevin.id)
      say(kevin.e, kevin.out.chat)

      // Analysts in parallel
      const roles = [...CORE_ANALYSTS]
      if (book.byClass.some(c => c.name === 'commodity')) roles.splice(3, 0, 'commodities-trader')
      if (book.byClass.some(c => c.name === 'realestate')) roles.splice(3, 0, 'real-assets')
      const analysts = await pool(roles, Math.max(1, cfg.concurrency), async (role, i) => {
        await sleep(i < cfg.concurrency ? i * 1500 : 0)
        const r = await agentTurn(ctx, role, () => analystPrompt(empByRole(role), bookJson), () => offline[role](book))
        visuals.push(r.id)
        say(r.e, r.out.chat)
        return r
      })

      const findings = [kevin, ...analysts].map(r => ({
        role: r.e.role, name: r.e.name, title: r.e.title, emoji: r.e.emoji,
        headline: r.out.headline || '', flags: Array.isArray(r.out.flags) ? r.out.flags : [],
        actions: Array.isArray(r.out.actions) ? r.out.actions : [], analysis_md: r.out.analysis_md || '', mode: r.mode,
      }))

      // Desk huddle — the characters argue about the real findings
      running.stage = 'huddle'
      deskUpdate()
      const cast = ['michael-scott', 'jim-halpert', 'dwight-schrute', 'oscar-martinez', 'angela-martin', 'stanley-hudson', 'kelly-kapoor', 'ryan-howard', 'kevin-malone', 'toby-flenderson']
      if (roles.includes('commodities-trader')) cast.push('meredith-palmer')
      if (roles.includes('real-assets')) cast.push('carol-stills')
      let huddle = null
      if (ctx.useLLM) {
        try {
          const res = extractJson(await runClaude(huddlePrompt(bookJson, findings, cast), { model: cfg.model, timeoutSec: cfg.timeoutSec }))
          if (Array.isArray(res?.lines)) huddle = res.lines.filter(l => emp(l.speaker) && l.line).slice(0, 12)
        } catch (err) { console.warn('[desk] huddle failed:', err.message) }
      }
      if (!huddle?.length) huddle = offline.huddle(book)
      // The desk huddle happens in the conference room — everyone walks in, argues, walks out
      const ownMeeting = !meeting.active
      if (ownMeeting) broadcast({ type: 'meeting_start', reason: `Desk huddle — ${client}`, timestamp: Date.now() })
      system(`☕ Desk huddle in the conference room — ${client}`)
      await sleep(Math.max(cfg.paceMs * 2, 4000)) // give everyone time to find a chair
      for (const l of huddle) { await sleep(cfg.paceMs); say(l.speaker, l.line) }
      if (ownMeeting) broadcast({ type: 'meeting_end', timestamp: Date.now() })
      // Analysts head home after the huddle
      for (const v of visuals) walkOut(v, '')

      // Jim builds the execution plan
      running.stage = 'execution'
      deskUpdate()
      const jimE = emp('jim-halpert')
      const jim = await agentTurn(ctx, 'assistant', () => executionPrompt(jimE, bookJson, findings), () => offline.execution(book), { walk: false, minMs: 2000 })
      let targets = book.baseline.targets
      let vetoNote = null
      if (jim.out.targets) {
        const norm = normaliseTargets(jim.out.targets, book, classify)
        if (norm && withinLimits(norm, book.limits)) targets = norm
        else {
          vetoNote = "Angela rejected Jim's first allocation (it broke the mandate). The desk used the compliant baseline instead."
          await sleep(cfg.paceMs / 2)
          say('angela-martin', "Jim's allocation breaks the mandate. Rejected. We're using the compliant baseline. Don't make that face, Jim.")
        }
      }
      const notes = new Map((jim.out.order_notes || []).map(n => [String(n.ticker).toUpperCase(), n]))
      const trades = buildTrades(book, targets).map(t => ({ ...t, ...(notes.get(t.ticker) ? { order_type: notes.get(t.ticker).order_type, urgency: notes.get(t.ticker).urgency, note: notes.get(t.ticker).note } : {}) }))
      const beforeAfter = {
        before: projectWeights(book, book.positions.map(p => ({ ticker: p.ticker, target: p.weight, info: p.info }))),
        after: projectWeights(book, targets),
      }
      await sleep(cfg.paceMs / 2)
      say(jimE, jim.out.chat)

      // Pam writes the report; Michael signs off
      running.stage = 'report'
      deskUpdate()
      const pamE = emp('pam-beesly')
      const pam = await agentTurn(ctx, 'client-reporting', () => reportPrompt(pamE, emp('michael-scott'), bookJson, findings, trades, beforeAfter), () => offline.report(book, findings, trades, beforeAfter), { minMs: 5000 })
      visuals.push(pam.id)

      const disclaimer = `This review was produced by AI agents role-playing characters at a fictional parody trading firm. It is for educational and entertainment purposes only and is **not** investment, tax, or legal advice. Figures are estimates based on the data you provided${book.risk.source === 'historical' ? ' and one year of public daily prices' : ' and simple model assumptions'}; verify prices, costs and suitability with a licensed professional before trading. Past performance does not guarantee future results.`

      const sections = findings.map(f => ({ heading: SECTION_HEADINGS[f.role] ?? f.title, name: f.name, title: f.title, emoji: f.emoji, analysis_md: f.analysis_md }))
      const md = buildReportMarkdown({
        book, sections,
        huddle: huddle.map(h => ({ name: emp(h.speaker).name, line: h.line })),
        execution: { name: jimE.name, title: jimE.title, analysis_md: jim.out.analysis_md, targets, vetoNote },
        trades, beforeAfter, summary: pam.out.executive_summary_md, signoff: pam.out.michael_signoff, disclaimer,
      })

      const dir = join(REPORTS_DIR, id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'report.md'), md)
      writeFileSync(join(dir, 'report.html'), reportHtml(md, `${FIRM.name} — ${client}`))
      writeFileSync(join(dir, 'book.json'), JSON.stringify({ book, findings, huddle, targets, trades, beforeAfter, modes: { llm: ctx.useLLM } }, null, 2))

      const url = `${SERVER_URL}/reports/${id}`
      say(pamE, `${pam.out.chat} ${url}`)
      walkOut(pam.id, '')
      await sleep(cfg.paceMs)
      say('toby-flenderson', "I just have to remind everyone this isn't investment advice. I put a disclosure at the bottom of the report.")
      await sleep(cfg.paceMs / 1.5)
      say('michael-scott', pam.out.michael_signoff || 'Great work, everybody.')

      latest = {
        ...tickerSummary(book), createdAt: book.createdAt, reportUrl: url, mandate: book.mandate.risk,
        risk: { vol: book.risk.vol, var95_1d: book.risk.var95_1d, equityShockPct: book.risk.equityShock.pct, rateShockPct: book.risk.rateShock.pct, beta: book.risk.beta },
        failingChecks: book.checks.filter(c => !c.pass).map(c => `${c.rule} (actual ${c.actual})`),
        headlines: Object.fromEntries(findings.map(f => [f.name, f.headline])),
        trades: trades.map(t => `${t.side} ${t.ticker} ${t.fromWeight}%→${t.toWeight}% (~$${t.dollars.toLocaleString()})`),
        targets: targets.map(t => `${t.ticker} ${t.target}%`),
        afterTrades: beforeAfter.after,
      }
      try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(LATEST_FILE, JSON.stringify(latest, null, 2)) } catch {}
      return { id, url }
    } catch (err) {
      console.error('[desk] run failed:', err)
      system(`🔥 The desk hit a problem: ${err.message}`)
      for (const v of visuals) walkOut(v, '')
      throw err
    } finally {
      running = null
      deskUpdate()
    }
  }

  function listReports() {
    if (!existsSync(REPORTS_DIR)) return []
    return readdirSync(REPORTS_DIR).filter(d => existsSync(join(REPORTS_DIR, d, 'report.html'))).sort().reverse()
  }

  function reportFile(id, kind = 'html') {
    if (!/^[\w-]+$/.test(id)) return null
    const p = join(REPORTS_DIR, id, kind === 'md' ? 'report.md' : kind === 'json' ? 'book.json' : 'report.html')
    return existsSync(p) ? p : null
  }

  return { run, status: publicStatus, listReports, reportFile, isRunning: () => !!running }
}
