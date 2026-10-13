/**
 * Agent Office - WebSocket + HTTP Event Server
 *
 * Runs on port 3334.
 * - React frontend connects via ws://localhost:3334/ws
 * - Claude Code hook script POSTs to http://localhost:3334/event
 * - GET /roster returns discovered MCP servers
 */

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { addMessage, getMessages, markSeen, addReaction } from './chat-db.js'
import db from './chat-db.js'
import { createDesk } from './desk/desk.js'
import { createClock } from './desk/clock.js'
import { createTalk, setOpsHook } from './desk/talk.js'
import { createBriefing } from './desk/briefing.js'
import { createMarketBell, isMarketOpen } from './desk/market.js'
import { createGroupChat } from './desk/groupchat.js'
import { createOperations } from './desk/operations.js'
import { avStatus } from './desk/alphavantage.js'
import { createStaff } from './desk/staff.js'
import { parsePortfolioText, parsePortfolioJson, PORTFOLIO_HELP } from './desk/parser.js'
import { ROSTER, FIRM } from './desk/roster.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const NOTIFY_SCRIPT = join(__dirname, '..', 'scripts', 'notify.sh')

function sendNotification(title, msg) {
  try {
    const child = execFile('bash', [NOTIFY_SCRIPT, title, msg], { timeout: 3000 })
    child.unref()
  } catch {}
}

const PORT = 3334

// ---------------------------------------------------------------------------
// Auth token — generated on startup, written to /tmp/agent-office-token
// ---------------------------------------------------------------------------

const AUTH_TOKEN = randomBytes(32).toString('hex')
const RUNTIME_DIR = join(homedir(), '.agent-office')
try { mkdirSync(RUNTIME_DIR, { recursive: true }) } catch {}
const TOKEN_FILE = join(RUNTIME_DIR, 'auth-token')

try {
  writeFileSync(TOKEN_FILE, AUTH_TOKEN, { mode: 0o600 })
} catch (err) {
  console.warn('[auth] Could not write token file:', err.message)
}

// ---------------------------------------------------------------------------
// Allowed origins
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS = new Set([
  'http://localhost:3333',
  'http://localhost:3334',
])

function isAllowedOrigin(origin) {
  if (!origin) return true  // null origin (Electron, file://, curl)
  return ALLOWED_ORIGINS.has(origin)
}

// ---------------------------------------------------------------------------
// MCP server discovery
// ---------------------------------------------------------------------------

/**
 * Read ~/.claude/settings.json and any .claude.json in cwd to discover
 * configured MCP servers. Returns an array of server-name strings.
 */
function discoverMcpServers() {
  const servers = new Set()

  const candidates = [
    join(homedir(), '.claude', 'settings.json'),
    join(homedir(), '.claude.json'),
    join(process.cwd(), '.claude.json'),
  ]

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue
    try {
      const raw = readFileSync(filePath, 'utf8')
      const data = JSON.parse(raw)
      const mcpServers = data.mcpServers ?? data.mcp_servers ?? {}
      for (const name of Object.keys(mcpServers)) {
        servers.add(name)
      }
    } catch {
      // Malformed JSON or unreadable file — skip silently
    }
  }

  return Array.from(servers)
}

// ---------------------------------------------------------------------------
// Agent state tracking
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} agentId -> agent object */
const activeAgents = new Map()

// The trading desk — turns /portfolio requests into a full in-character review
const desk = createDesk({ broadcast: (p) => broadcast(p), addMessage, activeAgents })
// The office phone — call any employee onto the floor
const staff = createStaff({ broadcast: (p) => broadcast(p), addMessage, activeAgents })
const clock = createClock({ broadcast: (p) => broadcast(p) })
const talk = createTalk({ broadcast: (p) => broadcast(p), addMessage })
const briefing = createBriefing({ broadcast: (p) => broadcast(p), addMessage, staff })
const bell = createMarketBell({ clock, staff, broadcast: (p) => broadcast(p), addMessage })
const groupChat = createGroupChat({ broadcast: (p) => broadcast(p), addMessage, marketOpen: () => isMarketOpen(clock.now()) })
// The firm's working day — risk checks, alpha report, book updates, emails, the project board
const ops = createOperations({ broadcast: (p) => broadcast(p), addMessage, clock })
ops.start()
setOpsHook({ context: ops.context, answer: ops.answer })

/**
 * Generate a stable agent ID from the event payload.
 * Uses the provided id, or derives one from name+role.
 */
function resolveAgentId(agent) {
  if (agent.id) return agent.id
  const slug = `${agent.name ?? 'agent'}-${agent.role ?? 'worker'}`
  return slug.toLowerCase().replace(/[^a-z0-9-]/g, '-')
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

const KNOWN_EVENT_TYPES = new Set([
  'agent_spawned',
  'agent_working',
  'agent_completed',
  'mcp_call',
  'mcp_done',
])

const MAX_STRING_LEN = 200

function clampString(val, max = MAX_STRING_LEN) {
  if (typeof val !== 'string') return undefined
  return val.slice(0, max)
}

function validateEvent(body) {
  if (!body || typeof body !== 'object') return 'Missing body'
  if (!body.type || typeof body.type !== 'string') return 'Missing event type'
  if (!KNOWN_EVENT_TYPES.has(body.type)) return `Unknown event type: ${body.type}`
  return null
}

// ---------------------------------------------------------------------------
// Express + HTTP server
// ---------------------------------------------------------------------------

const app = express()
app.use(express.json({ limit: '10kb' }))

// CORS for local dev — only allow known localhost origins
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && !isAllowedOrigin(origin)) {
    return res.status(403).json({ error: 'Forbidden origin' })
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  next()
})

app.options('*', (_req, res) => res.sendStatus(204))

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agents: activeAgents.size, clients: wss?.clients.size ?? 0 })
})

// MCP server roster
app.get('/roster', (_req, res) => {
  const mcpServers = discoverMcpServers()
  res.json({
    mcpServers,
    activeAgents: Array.from(activeAgents.values()),
  })
})

/**
 * POST /event — receives hook events from agent-tracker.sh
 *
 * Requires Authorization: Bearer <token> header (token is in /tmp/agent-office-token).
 *
 * Accepted body shapes:
 *   { type: "agent_spawned",   agent: { name, role, task, id? } }
 *   { type: "agent_working",   agentId, status }
 *   { type: "agent_completed", agentId, result }
 *   { type: "mcp_call",        server, tool, agentId? }
 *   { type: "mcp_done",        server, agentId? }
 */
app.post('/event', (req, res) => {
  // Auth check
  const authHeader = req.headers['authorization'] ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const body = req.body

  // Validate event type
  const validationError = validateEvent(body)
  if (validationError) {
    return res.status(400).json({ error: validationError })
  }

  // Clamp string fields to prevent oversized payloads reaching the frontend
  const sanitised = {
    ...body,
    agent: body.agent ? {
      ...body.agent,
      name:   clampString(body.agent.name),
      role:   clampString(body.agent.role),
      task:   clampString(body.agent.task),
      id:     clampString(body.agent.id),
    } : undefined,
    agentId: clampString(body.agentId),
    status:  clampString(body.status),
    result:  clampString(body.result),
    server:  clampString(body.server),
    tool:    clampString(body.tool),
  }

  const event = processEvent(sanitised)
  if (event) {
    broadcast(event)
  }

  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

function handleSlashCommand(cmd) {
  switch (cmd) {
    case '/status': {
      const agentCount = activeAgents.size
      const working = Array.from(activeAgents.values()).filter(a => a.state === 'working').length
      const clients = wss?.clients?.size ?? 0
      return `📊 ${agentCount} agents active, ${working} working, ${clients} clients connected`
    }
    case '/agents': {
      const agents = Array.from(activeAgents.values())
      if (agents.length === 0) return '🏢 Office is quiet — no agents active'
      return agents.map(a => `${a.name} (${a.role}) — ${a.state}`).join(', ')
    }
    case '/clear': {
      db.prepare('DELETE FROM messages').run()
      return '🧹 Chat cleared'
    }
    case '/help':
      return '📋 Commands: /portfolio <holdings> — send a book to the trading desk, /meeting [topic] — everyone to the conference room (/meeting end to wrap up), /desk — desk status, /roster — who does what, /reports — past client reports, /status — office stats, /agents — list agents, /clear — wipe chat history, /the-office — toggle the trading floor theme'
    case '/desk': {
      const st = desk.status()
      if (st.status === 'running') return `📈 Desk is working on ${st.running.client} — stage: ${st.stage}`
      if (st.latest) return `📈 Desk idle. Last book: ${st.latest.client} ($${Math.round(st.latest.totalValue).toLocaleString()}) — ${st.latest.reportUrl}`
      return '📈 Desk idle. Send one with /portfolio AAPL 30%, MSFT 20%, TLT 30%, CASH 20%'
    }
    case '/roster': {
      const depts = ROSTER.departments.map(d => {
        const people = ROSTER.employees.filter(e => e.department === d.id).map(e => `${e.name} (${e.title})`)
        return people.length ? `${d.name} [was ${d.formerly}]: ${people.join(', ')}` : null
      }).filter(Boolean)
      return `🏢 ${FIRM.fullName} — ${depts.join(' • ')}`
    }
    case '/reports': {
      const list = desk.listReports().slice(0, 5)
      if (!list.length) return '📄 No reports yet. Send a book with /portfolio'
      return '📄 Recent reports: ' + list.map(id => `http://127.0.0.1:${PORT}/reports/${id}`).join('  ')
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Chat — user messages from the office UI
// ---------------------------------------------------------------------------

/**
 * POST /chat — receives a message typed in the office Slack panel
 * No auth required (comes from the UI, not hooks)
 */
app.post('/chat', (req, res) => {
  const { sender, text, to } = req.body ?? {}
  if (!sender || !text) {
    return res.status(400).json({ error: 'Missing sender or text' })
  }

  // Slash command detection — handle before saving as normal message
  if (typeof text === 'string' && text.startsWith('/')) {
    const parts = text.split(' ')
    const cmd = parts[0]

    // /meeting [reason] — everyone on the floor to the conference room; /meeting end — back to desks
    if (/^\/meeting$/i.test(cmd)) {
      const userMsg = addMessage({ sender: clampString(sender), text: clampString(text, 2000) })
      broadcast({ type: 'chat_message', ...userMsg })
      const arg = text.slice(cmd.length).trim()
      if (/^(end|over|stop|done)$/i.test(arg)) staff.endMeeting()
      else {
        staff.startMeeting(arg || 'Meeting')
        const m = addMessage({ sender: 'Michael Scott', role: 'boss', text: `Conference room, everybody! ${arg ? `Topic: ${arg}.` : ''} Five minutes ago!` })
        broadcast({ type: 'chat_message', ...m })
      }
      return res.json({ ok: true })
    }

    // /market — is the market open (office clock) + Alpha Vantage usage
    if (/^\/market$/i.test(cmd)) {
      const userMsg = addMessage({ sender: clampString(sender), text: clampString(text, 2000) })
      broadcast({ type: 'chat_message', ...userMsg })
      const m = bell.status(), av = avStatus()
      const label = { open: '🟢 OPEN', pre: '🟡 pre-market', after: '🟠 after hours', closed: '🔴 closed (weekend/holiday)' }[m.phase]
      const avLine = av.configured ? `Alpha Vantage: ${av.callsToday} call${av.callsToday === 1 ? '' : 's'} today${av.limited ? ' — daily limit reached, using Yahoo/model data until tomorrow' : ''}; ${av.cachedQuotes} cached quote${av.cachedQuotes === 1 ? '' : 's'}.` : 'Alpha Vantage: no key set (firm/desk.secrets.json) — using Yahoo/model data.'
      const sys = addMessage({ sender: 'system', text: `📈 Market ${label} · ${m.ny} (office clock). Regular session 9:30–16:00 ET, Mon–Fri.\n${avLine}`, isSystem: true })
      broadcast({ type: 'chat_message', ...sys, isSystem: true })
      return res.json({ ok: true })
    }

    // /briefing AAPL [question] — all-hands: everyone gives their take, Jim wraps up
    if (/^\/(briefing|allhands|all-hands)$/i.test(cmd)) {
      const userMsg = addMessage({ sender: clampString(sender), text: clampString(text, 2000) })
      broadcast({ type: 'chat_message', ...userMsg })
      const rest = text.slice(cmd.length).trim()
      const [ticker, ...q] = rest.split(/\s+/)
      const r = briefing.run(ticker, q.join(' '))
      if (!r.ok) {
        const m = addMessage({ sender: 'system', text: `📋 ${r.error}`, isSystem: true })
        broadcast({ type: 'chat_message', ...m, isSystem: true })
      }
      return res.json(r)
    }

    // /risk, /alphas, /books, /pnl … — have that person do their job right now
    const OPS_CMDS = { '/risk': 'risk', '/alphas': 'alpha', '/alpha': 'alpha', '/books': 'books', '/pnl': 'pnl', '/mandate': 'mandate', '/settle': 'settle', '/macro': 'macro', '/buzz': 'buzz', '/crypto': 'crypto' }
    if (OPS_CMDS[cmd.toLowerCase()]) {
      const userMsg = addMessage({ sender: clampString(sender), text: clampString(text, 2000) })
      broadcast({ type: 'chat_message', ...userMsg })
      ops.run(OPS_CMDS[cmd.toLowerCase()]).catch(e => console.warn('[ops]', e.message))
      return res.json({ ok: true })
    }

    // /portfolio <holdings> | <mandate> — hand a book to the trading desk
    if (/^\/(portfolio|book)$/i.test(cmd)) {
      const userMsg = addMessage({ sender: clampString(sender), text: clampString(text, 2000) })
      broadcast({ type: 'chat_message', ...userMsg })
      const args = text.slice(cmd.length).trim()
      const reply = (t) => { const m = addMessage({ sender: 'system', text: t, isSystem: true }); broadcast({ type: 'chat_message', ...m, isSystem: true }) }
      if (!args) { reply(PORTFOLIO_HELP); return res.json({ ok: true }) }
      if (desk.isRunning()) { reply('📈 The desk is busy with another book. Try /desk for status.'); return res.json({ ok: true }) }
      const parsed = parsePortfolioText(args)
      if (!parsed.positions.length) { reply(`Couldn't read any positions. ${parsed.warnings.join('; ')}\n${PORTFOLIO_HELP}`); return res.json({ ok: true }) }
      desk.run(parsed, { requestedBy: sender }).catch(() => {})
      return res.json({ ok: true, desk: 'started' })
    }

    const cmdResult = handleSlashCommand(cmd)
    if (cmdResult) {
      const userMsg = addMessage({ sender: clampString(sender), text: clampString(text, 2000) })
      broadcast({ type: 'chat_message', ...userMsg })
      const sysMsg = addMessage({ sender: 'system', text: cmdResult, isSystem: true })
      broadcast({ type: 'chat_message', ...sysMsg, isSystem: true })
      return res.json({ ok: true })
    }
  }

  const msg = addMessage({
    sender: clampString(sender),
    text: clampString(text, 2000),
  })

  // Broadcast to all WS clients
  broadcast({ type: 'chat_message', ...msg })

  // Smart notification — ping when "claude" or "@claude" is mentioned
  if (/claude/i.test(text)) {
    sendNotification('Office Chat', clampString(sender) + ': ' + text.slice(0, 50))
  }

  // Write to webhook file so Claude can detect new messages
  try {
    const webhookPath = join(homedir(), '.agent-office', 'last-chat')
    writeFileSync(webhookPath, JSON.stringify(msg), 'utf8')
  } catch {}

  console.log(`[chat] ${msg.sender}: ${msg.text}`)
  // Talking to someone face to face on the floor → they answer in character
  if (to && typeof to === 'string') talk.reply(to, String(text).slice(0, 2000)).catch(() => {})
  // Asked the whole floor → whoever's field it is answers (respects the AI On/Off switch)
  else if (req.body?.boss && !briefing.isRunning()) groupChat.answer(String(text).slice(0, 2000)).catch(() => {})
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Video mode — when enabled, GET /chat filters out scripted video messages
// so external Claude sessions only see real agent messages.
// Toggle via POST /chat/video-mode  { enabled: true/false }
// ---------------------------------------------------------------------------
let videoPaused = false
let videoPausedSince = 0

app.post('/chat/video-mode', (req, res) => {
  videoPaused = !!req.body?.enabled
  videoPausedSince = videoPaused ? Date.now() : 0
  console.log(`[video-mode] chat polling ${videoPaused ? 'PAUSED' : 'RESUMED'}`)
  res.json({ ok: true, videoPaused })
})

/**
 * GET /chat — read recent chat messages (for Claude to read via terminal)
 * ?since=<timestamp> returns only messages after that time
 * When video mode is active, only returns messages from before video started
 * (i.e. hides the scripted video messages but keeps old real ones)
 */
app.get('/chat', (req, res) => {
  const since = parseInt(req.query.since) || 0
  let messages = getMessages({ since, limit: 50 })
  if (videoPaused && videoPausedSince) {
    // Hide any messages created after video mode was enabled (scripted messages)
    messages = messages.filter(m => m.timestamp < videoPausedSince)
  }
  res.json({ messages })
})

/**
 * POST /chat/reply — Claude replies as an agent in the office Slack
 * Body: { sender: "AgentName", role: "code-reviewer", text: "message" }
 */
app.post('/chat/reply', (req, res) => {
  const { sender, role, text } = req.body ?? {}
  if (!text) {
    return res.status(400).json({ error: 'Missing text' })
  }

  const msg = addMessage({
    sender: clampString(sender || 'Claude'),
    role: clampString(role || 'default'),
    text: clampString(text, 2000),
  })

  // Broadcast as a chat message — the frontend will attribute it to an agent
  broadcast({ type: 'chat_message', ...msg })

  console.log(`[reply] ${msg.sender}: ${msg.text}`)
  res.json({ ok: true })
})

/**
 * POST /chat/seen — mark a message as seen
 * Body: { messageId: number }
 */
app.post('/chat/seen', (req, res) => {
  const { messageId } = req.body ?? {}
  if (!messageId) {
    return res.status(400).json({ error: 'Missing messageId' })
  }
  markSeen(messageId)
  broadcast({ type: 'chat_seen', messageId })
  res.json({ ok: true })
})

/**
 * POST /chat/react — add or toggle an emoji reaction on a message
 * Body: { messageId: number, emoji: string }
 */
app.post('/chat/react', (req, res) => {
  const { messageId, emoji } = req.body ?? {}
  if (!messageId || !emoji) {
    return res.status(400).json({ error: 'Missing messageId or emoji' })
  }
  const reactions = addReaction(messageId, clampString(emoji, 10))
  broadcast({ type: 'chat_reaction', messageId, reactions })
  res.json({ ok: true, reactions })
})

/**
 * POST /chat/typing — broadcast a typing indicator
 * Body: { sender: string }
 */
app.post('/chat/typing', (req, res) => {
  const { sender } = req.body ?? {}
  if (!sender) {
    return res.status(400).json({ error: 'Missing sender' })
  }
  broadcast({ type: 'chat_typing', sender: clampString(sender) })
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Trading desk API
// ---------------------------------------------------------------------------

/**
 * POST /portfolio — start a desk review.
 * Body: { text: "AAPL 30%, MSFT 20% | moderate" }  or
 *       { name, mandate, notional, positions: [{ ticker, weight|shares|value, price, cost }] }
 */
app.post('/portfolio', (req, res) => {
  const body = req.body ?? {}
  if (desk.isRunning()) return res.status(409).json({ error: 'Desk is busy', status: desk.status() })
  const parsed = typeof body.text === 'string' ? parsePortfolioText(body.text) : parsePortfolioJson(body)
  if (!parsed.positions.length) return res.status(400).json({ error: 'No positions', warnings: parsed.warnings })
  const m = addMessage({ sender: 'system', text: `📥 Portfolio received via API (${parsed.positions.length} positions)`, isSystem: true })
  broadcast({ type: 'chat_message', ...m, isSystem: true })
  desk.run(parsed).catch(() => {})
  res.json({ ok: true, started: true, positions: parsed.positions.map(p => p.ticker), warnings: parsed.warnings })
})

app.get('/portfolio/status', (_req, res) => res.json(desk.status()))

// ---- Office phone -----------------------------------------------------------
app.get('/staff', (_req, res) => res.json(staff.directory()))
app.post('/staff/call', async (req, res) => {
  const role = String(req.body?.role ?? '')
  if (role === 'all-hands') return res.json(await staff.allHands())
  res.json(await staff.call(role))
})
app.post('/staff/meeting', (req, res) => {
  const action = String(req.body?.action ?? 'start')
  if (action === 'end') return res.json(staff.endMeeting())
  if (action === 'all-staff') return res.json(staff.allStaffMeeting())
  if (action === 'planning') return res.json(staff.planningCall(String(req.body?.dept ?? '')))
  res.json(staff.startMeeting(String(req.body?.reason ?? 'Meeting')))
})
app.post('/staff/desks', (_req, res) => res.json(staff.goToDesks()))

// Walk-up conversations — Michael meets someone on the floor
app.post('/talk/encounter', (req, res) => {
  const role = String(req.body?.role ?? '')
  const place = req.body?.place ? String(req.body.place).slice(0, 60) : undefined
  talk.encounter(role, { place }).catch(() => {})
  res.json({ ok: true })
})
app.post('/talk/end', (req, res) => res.json(talk.end(String(req.body?.role ?? ''))))
// Michael says something in the floating chat box → only that person hears it (not the group chat)
app.post('/talk/say', (req, res) => {
  const role = String(req.body?.role ?? ''), text = String(req.body?.text ?? '').slice(0, 2000)
  if (!role || !text) return res.status(400).json({ ok: false })
  talk.reply(role, text).catch(() => {})
  res.json({ ok: true })
})
app.get('/talk/history', (req, res) => res.json({ history: talk.history(String(req.query.role ?? '')) }))


// The firm's work — inbox, project board, risk, books, alphas
app.get('/ops/state', async (_req, res) => { try { res.json(await ops.state()) } catch (e) { res.status(500).json({ error: e.message }) } })
app.post('/ops/email/:id/read', (req, res) => res.json(ops.readEmail(req.params.id, req.body?.read !== false)))
app.post('/ops/email/read-all', (_req, res) => res.json(ops.readAll()))
app.post('/ops/email/:id/action', async (req, res) => res.json(await ops.action(req.params.id, String(req.body?.action ?? ''))))
app.post('/ops/email/:id/reply', async (req, res) => {
  const text = String(req.body?.text ?? '').slice(0, 4000).trim()
  if (!text) return res.status(400).json({ ok: false })
  res.json(await ops.reply(req.params.id, text))
})
app.post('/ops/email', async (req, res) => {
  const b = req.body ?? {}
  if (!b.to || !String(b.body ?? '').trim()) return res.status(400).json({ ok: false, error: 'to and body required' })
  res.json(await ops.compose(String(b.to), String(b.subject ?? '').slice(0, 200), String(b.body).slice(0, 4000)))
})
app.post('/ops/ticket', (req, res) => res.json(ops.createTicket(req.body ?? {})))
app.post('/ops/ticket/:id', async (req, res) => res.json(await ops.updateTicket(req.params.id, req.body ?? {})))
app.post('/ops/run/:job', async (req, res) => { try { res.json(await ops.run(req.params.job)) } catch (e) { res.status(500).json({ ok: false, error: e.message }) } })

// Office clock — forward only
app.get('/clock', (_req, res) => res.json(clock.snapshot()))
app.get('/market', (_req, res) => res.json({ ...bell.status(), alphaVantage: avStatus() }))
app.post('/clock', (req, res) => {
  const b = req.body ?? {}
  if (b.action === 'advance') { const r = clock.advance(Number(b.hours ?? 2) * 3600 * 1000); bell.tick(); ops.tick().catch(() => {}); return res.json(r) }
  if (b.action === 'skip') { const r = clock.skipTo(b.at); bell.tick(); ops.tick().catch(() => {}); return res.json(r) }
  res.status(400).json({ ok: false, error: 'action must be advance or skip' })
})
app.post('/staff/dismiss', (req, res) => {
  const role = String(req.body?.role ?? '')
  res.json(role === 'all' ? staff.dismissAll() : staff.dismiss(role))
})
app.get('/roster/firm', (_req, res) => res.json(ROSTER))

app.get('/reports', (_req, res) => {
  res.json({ reports: desk.listReports().map(id => ({ id, url: `http://127.0.0.1:${PORT}/reports/${id}` })) })
})

app.get('/reports/:id', (req, res) => {
  const raw = req.params.id
  const m = raw.match(/^([\w-]+?)(?:\.(md|json|html))?$/)
  if (!m) return res.status(404).send('Not found')
  const file = desk.reportFile(m[1], m[2] || 'html')
  if (!file) return res.status(404).send('Report not found')
  const type = m[2] === 'md' ? 'text/markdown; charset=utf-8' : m[2] === 'json' ? 'application/json' : 'text/html; charset=utf-8'
  res.type(type).send(readFileSync(file, 'utf8'))
})

// ---------------------------------------------------------------------------
// Cron/chat-monitor state — toggle from the frontend UI
// ---------------------------------------------------------------------------

const cronStatePath = join(homedir(), '.agent-office', 'chat-poll-state')

app.get('/chat/cron-state', (_req, res) => {
  try {
    const data = readFileSync(cronStatePath, 'utf8')
    res.json(JSON.parse(data))
  } catch {
    res.json({ paused: false, consecutive_idle_count: 0, last_seen_timestamp: 0 })
  }
})

app.post('/chat/cron-state', (req, res) => {
  try {
    let state = {}
    try { state = JSON.parse(readFileSync(cronStatePath, 'utf8')) } catch {}
    state.paused = !!req.body?.paused
    writeFileSync(cronStatePath, JSON.stringify(state), 'utf8')
    console.log(`[cron] Chat monitor ${state.paused ? 'PAUSED' : 'RESUMED'}`)
    res.json({ ok: true, paused: state.paused })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ---------------------------------------------------------------------------
// Event processing — normalise incoming hook payloads
// ---------------------------------------------------------------------------

function processEvent(body) {
  switch (body.type) {
    case 'agent_spawned': {
      const agent = body.agent ?? {}
      const id = resolveAgentId(agent)
      const record = {
        id,
        name:   agent.name  ?? 'Agent',
        role:   agent.role  ?? 'general-purpose',
        task:   agent.task  ?? agent.description ?? '',
        state:  'new-hire',
        spawnedAt: Date.now(),
      }
      activeAgents.set(id, record)
      console.log(`[+] Agent spawned: ${record.name} (${record.role}) — ${id}`)

      // Proactive message — announce task in chat
      const taskShort = (record.task ?? '').slice(0, 50)
      if (taskShort) {
        const chatMsg = addMessage({ sender: record.name, role: record.role, text: `starting: ${taskShort}` })
        broadcast({ type: 'chat_message', ...chatMsg })
      }

      return { type: 'agent_spawned', agent: record, timestamp: Date.now() }
    }

    case 'agent_working': {
      const id = body.agentId
      if (id && activeAgents.has(id)) {
        const agent = activeAgents.get(id)
        agent.state = 'working'
        agent.status = body.status ?? ''
        activeAgents.set(id, agent)
      }
      return { type: 'agent_working', agentId: id, status: body.status, timestamp: Date.now() }
    }

    case 'agent_completed': {
      const id = body.agentId
      if (id && activeAgents.has(id)) {
        const agent = activeAgents.get(id)
        agent.state = 'completed'
        activeAgents.set(id, agent)
        // Remove after a short grace period so frontends can animate exit
        setTimeout(() => activeAgents.delete(id), 10_000)

        // Proactive message — announce completion in chat
        const resultShort = (body.result ?? 'done').slice(0, 50)
        const chatMsg = addMessage({ sender: agent.name, role: agent.role, text: `done: ${resultShort}` })
        broadcast({ type: 'chat_message', ...chatMsg })

        // Smart notification — alert on failure
        if (/error|fail/i.test(body.result ?? '')) {
          sendNotification('Agent Failed', agent.name + ' failed')
        }
      }
      console.log(`[-] Agent completed: ${id}`)
      return { type: 'agent_completed', agentId: id, result: body.result, timestamp: Date.now() }
    }

    case 'mcp_call': {
      const record = {
        id:     `mcp-${body.server}-${Date.now()}`,
        name:   body.server ?? 'mcp',
        role:   body.server ?? 'default',
        server: body.server,
        tool:   body.tool,
        state:  'working',
        spawnedAt: Date.now(),
      }
      // Track MCP agents transiently
      activeAgents.set(record.id, record)
      console.log(`[mcp] ${body.server} / ${body.tool}`)
      return { type: 'mcp_call', server: body.server, tool: body.tool, agentId: record.id, timestamp: Date.now() }
    }

    case 'mcp_done': {
      // Clean up any mcp agent entries for this server
      for (const [id, agent] of activeAgents.entries()) {
        if (agent.server === body.server && agent.state === 'working') {
          activeAgents.delete(id)
        }
      }
      return { type: 'mcp_done', server: body.server, timestamp: Date.now() }
    }

    default:
      console.warn(`[?] Unknown event type: ${body.type}`)
      return null
  }
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

const httpServer = createServer(app)

const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

wss.on('connection', (ws, req) => {
  // Origin validation — allow localhost origins and null (Electron/file://)
  const origin = req.headers.origin
  if (origin && !isAllowedOrigin(origin)) {
    console.warn(`[ws] Rejected connection from disallowed origin: ${origin}`)
    ws.close(1008, 'Forbidden origin')
    return
  }

  const ip = req.socket.remoteAddress ?? 'unknown'
  console.log(`[ws] Client connected from ${ip} (total: ${wss.clients.size})`)

  // Send current state snapshot immediately on connect
  const snapshot = {
    type: 'snapshot',
    activeAgents: Array.from(activeAgents.values()),
    mcpServers: discoverMcpServers(),
    timestamp: Date.now(),
  }
  ws.send(JSON.stringify(snapshot))

  ws.on('close', () => {
    console.log(`[ws] Client disconnected (remaining: ${wss.clients.size})`)
  })

  ws.on('error', (err) => {
    console.error(`[ws] Client error:`, err.message)
  })
})

/**
 * Broadcast a JSON message to all connected WebSocket clients.
 */
function broadcast(payload) {
  const msg = JSON.stringify(payload)
  let sent = 0
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg)
      sent++
    }
  }
  if (sent > 0) {
    console.log(`[broadcast] ${payload.type} -> ${sent} client(s)`)
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

httpServer.listen(PORT, '127.0.0.1', () => {
  const mcpServers = discoverMcpServers()
  console.log(`
╔═══════════════════════════════════════════╗
║         Agent Office Server v1.0          ║
╠═══════════════════════════════════════════╣
║  HTTP  http://localhost:${PORT}              ║
║  WS    ws://localhost:${PORT}/ws             ║
║  POST  http://localhost:${PORT}/event        ║
║  GET   http://localhost:${PORT}/roster       ║
╚═══════════════════════════════════════════╝`)

  console.log(`  Auth token written to: ${TOKEN_FILE}`)

  if (mcpServers.length > 0) {
    console.log(`  MCP servers discovered: ${mcpServers.join(', ')}`)
  } else {
    console.log('  No MCP servers found in ~/.claude/settings.json')
  }
  console.log()
})

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[error] Port ${PORT} is already in use. Is the server already running?`)
  } else {
    console.error('[error]', err)
  }
  process.exit(1)
})
