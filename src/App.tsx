import React, { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react'
import './styles/office.css'
import './styles/rooms.css'
import SlackChat, { ChatMessage } from './components/SlackChat'
import Character from './components/Character'
import FurnitureRenderer from './components/FurnitureRenderer'
import { Agent, OfficeEvent, AGENT_CONFIGS } from './types'
import { getCurrentPhase, getPhaseLabel, phaseAt, nightAt, type DayPhase } from './daylight'
import OfficeClock from './components/OfficeClock'
import { EMPLOYEE_BY_ROLE, departmentOf } from './firm'
import DirectChat, { type DirectMsg } from './components/DirectChat'
import OpsDesk, { type OpsState, type OpsTab } from './components/OpsDesk'
import { EMPLOYEE_BY_SLUG } from './firm'
import { ROOMS, type AgentSpot } from './rooms'
import { useAgentSocket } from './hooks/useAgentSocket'
import * as sfx from './sounds'
import {
  assignSpot,
  createAgent,
  stepToward,
  findWaypointPath,
  WALK_SPEED,
  BREAK_MIN_DESK_TIME,
  BREAK_CHANCE_PER_SEC,
  BREAK_DURATION,
  spawnMessage,
  workMessage,
  doneMessage,
  coffeeMessage,
  waterMessage,
} from './agentManager'
import { BOSS_ROLE, BOSS_NAME } from './config'
import TickerTape, { type DeskState } from './components/TickerTape'
import StaffPhone from './components/StaffPhone'
import { SCRANTON_ROOM, FLOOR, FLOOR_SPOTS, roomPhrase, IS_ISO, findGridPath, pctToWorld, worldToPct, walkable, roomAt, facingToward, seatAt, nearestWalkable } from './floor'
import FloorCamera, { type CameraApi } from './components/FloorCamera'
import { getCharacterBaseForRole, themedDisplayName, getSpritePath } from './theme'
import { ROLE_TO_CHAR } from './config'
import { FIRM } from './firm'
import { pickEvent } from './events'
import { getInteraction } from './interactions'
import {
  useTheme, getRoomImage, getAngelaCat, getTheme,
  OFFICE_SIM_TOOL_MESSAGES, OFFICE_SIM_BOSS_PROMPTS,
  assignCharacterToRole, releaseRole, nextUnusedOfficeCharacter, displayNameFromSlug,
} from './theme'

// ---------------------------------------------------------------------------
// Placement helper — loaded via ?helper query param
// ---------------------------------------------------------------------------
const PlacementHelper = lazy(() => import('./components/PlacementHelper'))
const params = new URLSearchParams(window.location.search)
const isHelperMode = params.has('helper')
const isSimMode = params.has('sim') || params.has('video')
const isVideoMode = params.has('video')
// Why: allow ?theme=office on demo/sim URLs to preload Dunder Mifflin mode
import { setTheme as _setTheme } from './theme'
if (params.get('theme') === 'office') { _setTheme('office') }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** how far the office clock is ahead of real time (forward-only; set from the server) */
let officeClockOffsetMs = 0
function timeNow(): string {
  return new Date(Date.now() + officeClockOffsetMs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

let nextMsgId = 1
function makeMsgId() { return nextMsgId++ }

// Room: the full Scranton floor when the trading-floor (Office) theme is on, otherwise the classic room.
// Why: positions are percentages of the room art, so the room is fixed per page load
// (toggling the theme reloads the page). ?classic forces the old single room.
const FLOOR_MODE = getTheme() === 'office' && !params.has('classic') && !isSimMode
const MAIN_ROOM = FLOOR_MODE ? SCRANTON_ROOM : ROOMS['main-office']
/** Iso map: tile-built Scranton with a close-up camera, depth-sorted sprites and grid pathfinding */
const ISO_MODE = FLOOR_MODE && IS_ISO
const FLOOR_SPEED = ISO_MODE ? 0.85 : FLOOR_MODE ? 1.7 : 1
const ENTRY = MAIN_ROOM.entryPoint           // door position (%)
const COFFEE_SPOT = MAIN_ROOM.agentSpots.find(s => s.type === 'coffee') ?? null
const WATER_SPOTS  = MAIN_ROOM.agentSpots.filter(s => s.type === 'water')

// Agent that is walking toward door to leave has this as targetPosition
const DOOR_TARGET = { x: ENTRY.x, y: ENTRY.y }

const FILING_SPOT = MAIN_ROOM.agentSpots.find(s => s.type === 'filing') ?? null

// Waypoints for the main office
const MAIN_WAYPOINTS = MAIN_ROOM.waypoints ?? []

/**
 * Compute a pathQueue from one position to another using the main-office
 * waypoint graph.  Returns an array of intermediate {x,y} steps — the agent
 * should walk through each in order, then continue straight to targetPosition.
 */
function computePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x: number; y: number }[] {
  if (ISO_MODE) return findGridPath(from, to)
  if (MAIN_WAYPOINTS.length === 0) {
    console.warn('[pathfinding] No waypoints loaded!')
    return []
  }
  return findWaypointPath(from.x, from.y, to.x, to.y, MAIN_WAYPOINTS,
    FLOOR_MODE ? { jitter: 0.25, detours: false } : {})
}

// ---------------------------------------------------------------------------
// Scranton floor seating — everyone has a home desk; desk-mates float
// ---------------------------------------------------------------------------
function slugForRole(role: string): string {
  return getCharacterBaseForRole(role, ROLE_TO_CHAR[role] ?? 'employee-3')
}

/** Pick a spot for a role on the floor: their own desk if free, otherwise float somewhere sociable. */
function assignFloorSeat(agents: Agent[], role: string): { spot: AgentSpot; home: string | null } | null {
  const taken = new Set(agents.map(a => a.assignedSpotId).filter(Boolean))
  const slug = slugForRole(role)
  const home = FLOOR.seats[slug] ?? null
  if (home && !taken.has(home)) return { spot: FLOOR_SPOTS[home] as AgentSpot, home }
  // Desk-mate is at the desk (or no desk at all) → float
  const free = FLOOR.floatSpots.filter(id => !taken.has(id))
  if (free.length) return { spot: FLOOR_SPOTS[free[Math.floor(Math.random() * free.length)]] as AgentSpot, home }
  // Floor is packed: any spare desk, then any free desk
  const spare = FLOOR.spots.filter(s => s.type === 'desk' && !taken.has(s.id) && !(FLOOR.deskOwners[s.id]?.length))
  const anyDesk = spare[0] ?? FLOOR.spots.find(s => s.type === 'desk' && !taken.has(s.id))
  return anyDesk ? { spot: anyDesk as AgentSpot, home } : null
}

// Roles that go to the filing cabinet instead of their desk (browsing codebase)
const FILING_ROLES = new Set(['Explore', 'general-purpose'])

// The boss — always in the office, permanent desk (spot-1)
const BOSS_ID = `boss-${BOSS_NAME.toLowerCase()}`
const BOSS_SPOT = MAIN_ROOM.agentSpots.find(s => s.id === 'spot-1') ?? MAIN_ROOM.agentSpots.find(s => s.type === 'desk') ?? null

function createBoss(): Agent {
  const cfg = AGENT_CONFIGS[BOSS_ROLE] ?? AGENT_CONFIGS['default']
  const spot = BOSS_SPOT ?? { id: 'spot-temp', type: 'desk' as const, x: 28.9, y: 66 }
  const entry = MAIN_ROOM.entryPoint
  const target = { x: spot.x, y: spot.y }
  return {
    id: BOSS_ID,
    name: cfg.title,
    type: 'subagent',
    role: BOSS_ROLE,
    state: 'new-hire',
    position: { x: entry.x, y: entry.y },
    targetPosition: target,
    deskPosition: target,
    room: 'main-office',
    assignedRoom: 'main-office',
    assignedSpotId: spot.id,
    spriteFacing: spot.spriteFacing,
    task: 'Running the show',
    statusText: 'clocked in',
    color: cfg.color,
    emoji: cfg.emoji,
    hiredAt: Date.now(),
    pathQueue: computePath(entry, target),
  }
}

// Claude — the assistant, always in the office at spot-2
const CLAUDE_ID = 'assistant-claude'
const CLAUDE_ROLE = 'assistant'
const CLAUDE_SPOT = MAIN_ROOM.agentSpots.find(s => s.id === 'spot-2') ?? null

function createClaude(): Agent {
  const cfg = AGENT_CONFIGS[CLAUDE_ROLE] ?? AGENT_CONFIGS['default']
  const spot = CLAUDE_SPOT ?? { id: 'spot-2', type: 'desk' as const, x: 37.9, y: 68.2, spriteFacing: 'rear-right' as const }
  const entry = MAIN_ROOM.entryPoint
  const target = { x: spot.x, y: spot.y }
  return {
    id: CLAUDE_ID,
    name: cfg.title,
    type: 'subagent',
    role: CLAUDE_ROLE,
    state: 'new-hire',
    position: { x: entry.x, y: entry.y },
    targetPosition: target,
    deskPosition: target,
    room: 'main-office',
    assignedRoom: 'main-office',
    assignedSpotId: spot.id,
    spriteFacing: spot.spriteFacing,
    task: 'Office assistant',
    statusText: 'clocked in',
    color: cfg.color,
    emoji: cfg.emoji,
    hiredAt: Date.now() + 500, // arrives just after the boss
    pathQueue: computePath(entry, target),
  }
}

// How close (in %-units) an agent must be to their target before we consider
// them "arrived"
const ARRIVAL_THRESHOLD = 0.3

// ---------------------------------------------------------------------------
// Per-agent runtime metadata (not stored in Agent itself to avoid re-renders)
// ---------------------------------------------------------------------------
// Minimum time (ms) an agent stays visible after spawning before they can leave
const MIN_VISIBLE_TIME = 30_000

interface AgentMeta {
  /** Scranton floor: this character's own desk (may be taken by a desk-mate) */
  homeSpot?: string | null
  /** Scranton floor: conference-room seat while a meeting is on */
  meetingSpot?: string | null
  /** Scranton floor: last time a floater wandered to a new spot */
  lastWander?: number
  /** Iso map: Michael is walking somewhere you clicked — stand there when he arrives */
  manualWalk?: boolean
  /** Timestamp when agent spawned */
  spawnedAt: number
  /** Timestamp when agent arrived at their desk */
  arrivedAtDeskAt: number | null
  /** Timestamp when agent entered idle state */
  idleSince: number | null
  /** Is agent currently on a break (coffee/water) */
  onBreak: boolean
  /** When the break started */
  breakStartedAt: number | null
}

// ---------------------------------------------------------------------------
// Side-effect descriptor — computed during state updates, flushed after
// ---------------------------------------------------------------------------
type SfxEffect = 'doorOpen' | 'typing' | 'celebration' | 'coffee' | 'alarm' | 'error' | 'powerDown' | 'notification'

interface PendingEffect {
  msg?: { sender: string; role: string; color: string; text: string; isSystem?: boolean }
  sfx?: SfxEffect
  furnitureState?: { id: string; state: string }
}

// ---------------------------------------------------------------------------
// App component
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cinematic simulation data — realistic agent activity for screen recording
// ---------------------------------------------------------------------------
const SIM_SCENARIOS = [
  {
    role: 'security-auditor',
    task: 'Auditing auth middleware for session token vulnerabilities',
    slackMessages: [
      '🔍 scanning auth middleware...',
      '⚠️ found session tokens stored in localStorage — flagging',
      '🔐 checking CORS configuration on API endpoints',
      '📋 reviewing JWT expiry and refresh flow',
      '✅ auth audit complete — 2 issues found, PRs drafted',
    ],
  },
  {
    role: 'frontend-developer',
    task: 'Building responsive dashboard with real-time charts',
    slackMessages: [
      '🎨 scaffolding dashboard layout with grid system',
      '📊 integrating chart library — testing with live data',
      '💅 adding dark mode support to all components',
      '🧪 writing component tests for chart rendering',
      '🚀 dashboard ready for review',
    ],
  },
  {
    role: 'code-reviewer',
    task: 'Reviewing PR #487 — payment processing refactor',
    slackMessages: [
      '👀 opening PR #487 — 23 files changed',
      '🔍 checking error handling in payment flow',
      '💡 suggesting async/await instead of .then chains',
      '⚡ found a potential race condition in webhook handler',
      '✅ review complete — approved with 3 suggestions',
    ],
  },
]

// Extra random slack chatter between agents
const SIM_CHATTER = [
  { sender: 'Debugger', role: 'debugger', msg: 'found a null pointer in the auth handler, patching now' },
  { sender: 'Frontend', role: 'frontend-developer', msg: 'the new dark mode toggle is looking clean' },
  { sender: 'Security', role: 'security-auditor', msg: 'heads up — that API key should be in env vars, not hardcoded' },
  { sender: 'Reviewer', role: 'code-reviewer', msg: 'lgtm on the PR, just one nit on the error handling' },
  { sender: 'DBA', role: 'database-architect', msg: 'added an index on user_id, queries are 10x faster now' },
  { sender: 'DevOps', role: 'devops-engineer', msg: 'staging deploy is green, promoting to prod' },
  { sender: 'Claude', role: 'assistant', msg: 'the printer jammed again. third time today.' },
  { sender: 'Tester', role: 'test-engineer', msg: 'coverage is at 94%, just need the edge cases' },
  { sender: 'PerfEng', role: 'performance-engineer', msg: 'shaved 200ms off the initial load, LCP is under 2s' },
  { sender: 'Frontend', role: 'frontend-developer', msg: 'responsive layout done, looks great on mobile' },
  { sender: 'Claude', role: 'assistant', msg: 'someone get the coffee machine, its making that sound again' },
  { sender: 'Architect', role: 'architect-reviewer', msg: 'the new module boundary looks solid, good separation' },
  { sender: 'AI Eng', role: 'ai-engineer', msg: 'embeddings are indexed, RAG pipeline is live' },
  { sender: 'TS Pro', role: 'typescript-pro', msg: 'fixed the generic inference, no more any casts' },
  { sender: 'Antony', role: 'boss', msg: 'anyone want a Red Bull?' },
  { sender: 'Antony', role: 'boss', msg: 'ship it, we\'ll fix it in prod' },
  { sender: 'Antony', role: 'boss', msg: 'how are we looking on the dashboard?' },
]

// Dunder Mifflin Capital chatter — used when the trading-floor theme is active
const OFFICE_SIM_CHATTER = [
  { sender: 'Debugger', role: 'debugger', msg: 'found a bug in the order router — Creed. again.' },
  { sender: 'Frontend', role: 'frontend-developer', msg: 'new client report template looks cleaner than Dwight\'s desk' },
  { sender: 'Security', role: 'security-auditor', msg: 'heads up — Dwight is running another surprise flash-crash drill' },
  { sender: 'Reviewer', role: 'code-reviewer', msg: 'the position recon ties out. approved.' },
  { sender: 'DBA', role: 'database-architect', msg: 'indexed the trade blotter by ticker. like the old days with reams.' },
  { sender: 'DevOps', role: 'devops-engineer', msg: 'market data feed is green. Darryl says don\'t touch it.' },
  { sender: 'Claude', role: 'assistant', msg: 'Michael is in the conference room explaining options to a plant.' },
  { sender: 'Tester', role: 'test-engineer', msg: 'back-tested the strategy. it worked in 1999. and only in 1999.' },
  { sender: 'PerfEng', role: 'performance-engineer', msg: 'order latency down 200ms. Stanley still leaves at 5.' },
  { sender: 'Claude', role: 'assistant', msg: 'someone tell Ryan a WUPHF token is not an asset class.' },
  { sender: 'Architect', role: 'architect-reviewer', msg: 'the Finer Things Club charter now includes a dividend policy' },
  { sender: 'AI Eng', role: 'ai-engineer', msg: 'teaching the sentiment model to recognise Kelly\'s group chats' },
  { sender: 'Antony', role: 'boss', msg: "anyone want to go to Chili's? I'm long Baby Back Ribs." },
  { sender: 'Antony', role: 'boss', msg: 'buy high, sell higher. PARKOUR!' },
  { sender: 'Antony', role: 'boss', msg: 'how are we doing on the P&L today?' },
  { sender: 'Antony', role: 'boss', msg: "I'm not superstitious, but I am a little stitious about earnings season." },
  { sender: 'Debugger', role: 'debugger', msg: 'Bears. Beets. Bear markets.' },
  { sender: 'Security', role: 'security-auditor', msg: 'Identity theft is not a joke, Jim! Neither is a leaked API key!' },
  { sender: 'Reviewer', role: 'code-reviewer', msg: "that's what she said" },
  { sender: 'Frontend', role: 'frontend-developer', msg: 'I feel God in this Bloomberg terminal tonight' },
  { sender: 'Tester', role: 'test-engineer', msg: 'Would I rather be feared or loved by the market? Easy. Both.' },
  { sender: 'DevOps', role: 'devops-engineer', msg: 'I declare... a margin call!' },
  { sender: 'Risk', role: 'risk-manager', msg: 'FACT: concentration kills. so do bears.' },
  { sender: 'P&L', role: 'pnl-controller', msg: 'P&L is up. I think. Calculator says keleven.' },
  { sender: 'Income', role: 'income-strategist', msg: 'bond coupon came in. I\'m going home.' },
]

const App: React.FC = () => {
  // All hooks must be at the top — before any conditional returns.
  const theme = useTheme() // Why: re-render rooms + agents when /the-office toggles
  const [agents, setAgents] = useState<Agent[]>(() => [createBoss(), createClaude()])
  const agentMetaRef = useRef<Map<string, AgentMeta>>(new Map([
    [BOSS_ID, { spawnedAt: Date.now(), arrivedAtDeskAt: Date.now(), idleSince: null, onBreak: false, breakStartedAt: null }],
    [CLAUDE_ID, { spawnedAt: Date.now(), arrivedAtDeskAt: Date.now(), idleSince: null, onBreak: false, breakStartedAt: null }],
  ]))

  // ---- Scranton floor: meetings, zoom, room size ----------------------------
  const meetingActiveRef = useRef(false)
  /** Planning calls only pull one segment (+ Michael); null = everyone on the floor */
  const meetingRolesRef = useRef<Set<string> | null>(null)
  const [meetingOn, setMeetingOn] = useState(false)
  const [zoom, setZoom] = useState(1)
  const roomRef = useRef<HTMLDivElement>(null)
  const [roomW, setRoomW] = useState(0)
  useEffect(() => {
    const el = roomRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setRoomW(el.clientWidth))
    ro.observe(el)
    setRoomW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  /** Character sprite height on the floor map scales with the map (and zoom). */
  const floorSpriteH = Math.max(20, Math.round(roomW * FLOOR.spriteScale))

  const freeMeetingSeat = (agentsNow: Agent[]): string | null => {
    const used = new Set(agentsNow.map(a => agentMetaRef.current.get(a.id)?.meetingSpot).filter(Boolean))
    return [...FLOOR.meetingSeats, ...FLOOR.meetingStanding].find(id => !used.has(id)) ?? null
  }

  // NB: bookkeeping (agentMetaRef) happens *outside* the setAgents updaters — React may run
  // updaters twice in dev (StrictMode), so they must be pure.

  /** Everyone on the floor walks to the conference room (Michael takes the front). */
  const startMeeting = useCallback((reason?: string, roles?: string[] | null) => {
    if (!FLOOR_MODE) return
    meetingActiveRef.current = true
    meetingRolesRef.current = roles?.length ? new Set(roles) : null
    setMeetingOn(true)
    const order = [...FLOOR.meetingSeats, ...FLOOR.meetingStanding]
    const used = new Set<string>()
    const assign = new Map<string, string>()
    const byPriority = [...agentsRef.current].sort((a, b) => (a.id === BOSS_ID ? -1 : b.id === BOSS_ID ? 1 : 0))
    for (const a of byPriority) {
      if (a.state === 'completed') continue
      if (meetingRolesRef.current && a.id !== BOSS_ID && !meetingRolesRef.current.has(a.role)) continue
      const meta = agentMetaRef.current.get(a.id)
      if (!meta) continue
      const seatId = meta.meetingSpot && !used.has(meta.meetingSpot) ? meta.meetingSpot : order.find(id => !used.has(id))
      if (!seatId) continue
      used.add(seatId)
      meta.meetingSpot = seatId
      meta.onBreak = false
      assign.set(a.id, seatId)
    }
    setAgents(prev => prev.map(a => {
      const seatId = assign.get(a.id)
      if (!seatId || a.state === 'completed') return a
      const seat = FLOOR_SPOTS[seatId]
      return {
        ...a, state: 'walking-to-desk' as const,
        targetPosition: { x: seat.x, y: seat.y }, pathQueue: computePath(a.position, seat),
        spriteFacing: seat.spriteFacing, statusText: reason ? `📋 ${reason}` : 'to the conference room',
      }
    }))
  }, [])

  /** Meeting over — everyone back to their own spot. */
  const endMeeting = useCallback(() => {
    meetingActiveRef.current = false
    meetingRolesRef.current = null
    setMeetingOn(false)
    const attendees = new Set<string>()
    for (const [id, meta] of agentMetaRef.current) {
      if (meta.meetingSpot) { attendees.add(id); meta.meetingSpot = null; meta.idleSince = null }
    }
    setAgents(prev => prev.map(a => {
      if (!attendees.has(a.id) || a.state === 'completed') return a
      const desk = FLOOR_SPOTS[a.assignedSpotId ?? '']
      return {
        ...a, state: 'walking-to-desk' as const,
        targetPosition: { ...a.deskPosition }, pathQueue: computePath(a.position, a.deskPosition),
        spriteFacing: desk?.spriteFacing ?? a.spriteFacing, statusText: 'back to my desk',
      }
    }))
  }, [])

  /** 🪑 Go to desk: everyone (but Michael — you're driving him) to their own desk.
   *  A shared desk goes to whoever is sitting there, else its first owner (Pam before Erin);
   *  the other sharer and the visitors find a shared space — kitchen, break room, waiting area… */
  const goToDesks = useCallback(() => {
    if (!FLOOR_MODE) return
    meetingActiveRef.current = false
    meetingRolesRef.current = null
    setMeetingOn(false)
    const people = agentsRef.current.filter(a => a.state !== 'completed' && a.id !== BOSS_ID)
    const homeOf = (a: Agent) => FLOOR.seats[slugForRole(a.role)] ?? null
    const ownerRank = (a: Agent) => {
      const h = homeOf(a)
      const i = h ? (FLOOR.deskOwners[h] ?? []).indexOf(slugForRole(a.role)) : -1
      return i < 0 ? 99 : i
    }
    const taken = new Set<string>(['spot-1'])
    const assign = new Map<string, { spot: string; home: boolean }>()
    for (const a of people) {          // already sitting at your own desk → keep it
      const h = homeOf(a)
      if (h && a.assignedSpotId === h && !taken.has(h)) { taken.add(h); assign.set(a.id, { spot: h, home: true }) }
    }
    for (const a of [...people].sort((x, y) => ownerRank(x) - ownerRank(y))) {   // claim your desk if it's free
      if (assign.has(a.id)) continue
      const h = homeOf(a)
      if (h && !taken.has(h)) { taken.add(h); assign.set(a.id, { spot: h, home: true }) }
    }
    const shared = FLOOR.floatSpots.filter(id => !taken.has(id)).sort(() => Math.random() - 0.5)
    const spare = FLOOR.spots.filter(sp => sp.type === 'desk' && !taken.has(sp.id) && !(FLOOR.deskOwners[sp.id]?.length)).map(sp => sp.id)
    for (const a of people) {          // desk-sharers without the desk + visitors → shared spaces
      if (assign.has(a.id)) continue
      const id = shared.shift() ?? spare.shift()
      if (id) { taken.add(id); assign.set(a.id, { spot: id, home: false }) }
    }
    for (const [id, as] of assign) {
      const meta = agentMetaRef.current.get(id)
      if (!meta) continue
      meta.meetingSpot = null
      meta.onBreak = false
      meta.breakStartedAt = null
      meta.idleSince = null
      meta.arrivedAtDeskAt = null
      if (!as.home) meta.lastWander = Date.now()
    }
    setAgents(prev => prev.map(a => {
      const as = assign.get(a.id)
      if (!as || a.state === 'completed') return a
      const sp = FLOOR_SPOTS[as.spot]
      return {
        ...a, assignedSpotId: as.spot, deskPosition: { x: sp.x, y: sp.y }, targetPosition: { x: sp.x, y: sp.y },
        pathQueue: computePath(a.position, sp), state: 'walking-to-desk' as const, spriteFacing: sp.spriteFacing,
        statusText: as.home ? 'back to my desk' : `desk's taken — ${roomPhrase(as.spot)}`,
      }
    }))
  }, [])

  // Desk-mates and floaters: take your desk back when it frees up; otherwise wander now and then.
  useEffect(() => {
    if (!FLOOR_MODE) return
    const t = setInterval(() => {
      const now = Date.now()
      const current = agentsRef.current
      const taken = new Set(current.map(a => a.assignedSpotId).filter(Boolean) as string[])
      const moves = new Map<string, { spotId: string; status: string }>()
      for (const a of current) {
        const meta = agentMetaRef.current.get(a.id)
        if (!meta || meta.meetingSpot || a.id === BOSS_ID || a.id === CLAUDE_ID) continue
        if (a.state !== 'working' && a.state !== 'idle') continue
        let move: { spotId: string; status: string } | null = null
        if (meta.homeSpot && a.assignedSpotId !== meta.homeSpot && !taken.has(meta.homeSpot)) {
          move = { spotId: meta.homeSpot, status: 'my turn at the desk' }
        } else if (a.assignedSpotId && FLOOR.floatSpots.includes(a.assignedSpotId) &&
                   now - (meta.lastWander ?? 0) > 40000 + Math.random() * 40000) {
          const free = FLOOR.floatSpots.filter(id => !taken.has(id) && id !== a.assignedSpotId)
          if (free.length) {
            const id = free[Math.floor(Math.random() * free.length)]
            move = { spotId: id, status: `wandering ${roomPhrase(id)}` }
          }
        }
        if (!move) continue
        if (a.assignedSpotId) taken.delete(a.assignedSpotId)
        taken.add(move.spotId)
        meta.lastWander = now
        meta.arrivedAtDeskAt = null
        moves.set(a.id, move)
      }
      if (!moves.size) return
      setAgents(prev => prev.map(a => {
        const m = moves.get(a.id)
        if (!m || a.state === 'completed') return a
        const sp = FLOOR_SPOTS[m.spotId]
        return {
          ...a, assignedSpotId: m.spotId, deskPosition: { x: sp.x, y: sp.y }, targetPosition: { x: sp.x, y: sp.y },
          pathQueue: computePath(a.position, sp), state: 'walking-to-desk' as const, spriteFacing: sp.spriteFacing, statusText: m.status,
        }
      }))
    }, 4000)
    return () => clearInterval(t)
  }, [])

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [deskState, setDeskState] = useState<DeskState | null>(null)
  const [chatTypingUser, setChatTypingUser] = useState<string | null>(null)
  const [lastSeenId, setLastSeenId] = useState<number | null>(null)
  const [muted, setMuted] = useState(false)
  const [dayPhase, setDayPhase] = useState<DayPhase>(getCurrentPhase())
  // Office clock (forward-only, kept by the server): office time = now + offset
  const [clockOffset, setClockOffset] = useState(0)
  const clockOffsetRef = useRef(0)
  clockOffsetRef.current = clockOffset
  officeClockOffsetMs = clockOffset
  useEffect(() => {
    if (!FLOOR_MODE) return
    fetch('http://127.0.0.1:3334/clock').then(r => r.json()).then(d => {
      if (typeof d.offsetMs === 'number') setClockOffset(d.offsetMs)
    }).catch(() => {})
  }, [])
  const [dayNightMode, setDayNightMode] = useState<'auto' | 'day' | 'night'>('auto')

  // Compressed day cycle: 10 min = 24 hours
  // nightOpacity: 0 = full day, 1 = full night
  const [nightOpacity, setNightOpacity] = useState(0)

  // Track interactive furniture state (coffee on/off, filing open/closed)
  const [furnitureStates, setFurnitureStates] = useState<Record<string, string>>({})

  // Visual flicker state for power-flicker event
  const [flickering, setFlickering] = useState(false)

  // Boss interaction cooldowns
  const interactionCooldowns = useRef<Map<string, number>>(new Map())

  // Boss interaction effect (shown above boss character)
  const [bossEffect, setBossEffect] = useState<string | null>(null)

  const handleFurnitureClick = useCallback((itemId: string) => {
    const interaction = getInteraction(itemId)
    if (!interaction) return

    // Check cooldown
    const now = Date.now()
    const lastUsed = interactionCooldowns.current.get(itemId) ?? 0
    if (now - lastUsed < interaction.cooldown) return
    interactionCooldowns.current.set(itemId, now)

    // Walk boss to the item
    const target = interaction.walkTo
    setAgents(prev => prev.map(a => {
      if (a.id !== BOSS_ID) return a
      return {
        ...a,
        state: 'walking-to-desk' as const,
        targetPosition: target,
        pathQueue: computePath(a.position, target),
        statusText: Array.isArray(interaction.chatMessage)
          ? interaction.chatMessage[Math.floor(Math.random() * interaction.chatMessage.length)]
          : interaction.chatMessage,
      }
    }))

    // Set up arrival watcher — when boss reaches target, trigger effects
    const checkArrival = setInterval(() => {
      const boss = agentsRef.current.find(a => a.id === BOSS_ID)
      if (!boss) { clearInterval(checkArrival); return }
      const dist = Math.sqrt((boss.position.x - target.x) ** 2 + (boss.position.y - target.y) ** 2)
      if (dist < 2) {
        clearInterval(checkArrival)

        // Play sound if specified
        if (interaction.sound === 'bell') sfx.playBell()
        else if (interaction.sound === 'notification') sfx.playNotification()
        else if (interaction.sound === 'coffee') sfx.playCoffee()

        // Show effect above boss
        setBossEffect(interaction.effect)
        setTimeout(() => setBossEffect(null), interaction.duration)

        // Post chat message
        const msg = Array.isArray(interaction.chatMessage)
          ? interaction.chatMessage[Math.floor(Math.random() * interaction.chatMessage.length)]
          : interaction.chatMessage
        const bossCfg = AGENT_CONFIGS[BOSS_ROLE] ?? AGENT_CONFIGS['default']
        // Use setMessages directly to avoid addMsg dependency ordering
        setMessages(prev => [...prev.slice(-50), {
          id: makeMsgId(),
          sender: bossCfg.title,
          senderSprite: BOSS_ROLE,
          senderColor: bossCfg.color,
          text: msg,
          channel: 'office-general',
          timestamp: timeNow(),
        }])

        // Furniture state change
        if (interaction.furnitureState) {
          const fs = interaction.furnitureState
          setFurnitureStates(prev => ({ ...prev, [fs.id]: fs.state }))
          if (fs.revertAfter) {
            setTimeout(() => {
              setFurnitureStates(prev => {
                const next = { ...prev }
                delete next[fs.id]
                return next
              })
            }, fs.revertAfter)
          }
        }

        // Walk boss back to desk after effect
        setTimeout(() => {
          setAgents(prev => prev.map(a => {
            if (a.id !== BOSS_ID) return a
            return {
              ...a,
              state: 'walking-to-desk' as const,
              targetPosition: { ...a.deskPosition },
              pathQueue: computePath(a.position, a.deskPosition),
              statusText: 'back to work',
            }
          }))
        }, interaction.duration + 500)
      }
    }, 200)

    // Safety: clear after 15s if boss never arrives
    setTimeout(() => clearInterval(checkArrival), 15000)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // We store agents in a ref as well so animation callbacks can read them
  // without needing to be re-created every render.
  const agentsRef = useRef<Agent[]>([])
  agentsRef.current = agents
  ;(window as unknown as { __office?: unknown }).__office = { agentsRef } // debug handle (read-only)

  // ---- Iso map: drive Michael yourself (D-pad / arrow keys / click-to-walk) ----
  /** world-axis direction Michael is being steered in; 0,0 = not steering */
  const manualDirRef = useRef({ du: 0, dv: 0 })
  const manualStopRef = useRef(false)
  const cameraRef = useRef<CameraApi>(null)
  const onManualMove = useCallback((du: number, dv: number) => {
    const was = manualDirRef.current.du || manualDirRef.current.dv
    manualDirRef.current = { du, dv }
    if (was && !du && !dv) manualStopRef.current = true
  }, [])
  const walkMichaelTo = useCallback((x: number, y: number) => {
    const meta = agentMetaRef.current.get(BOSS_ID)
    if (meta) meta.manualWalk = true
    const w = pctToWorld(x, y)
    // snap to the nearest spot he can actually stand on
    let best = { u: w.u, v: w.v }
    if (!walkable(w.u, w.v)) {
      let bd = Infinity
      for (let du = -3; du <= 3; du += 0.25) for (let dv = -3; dv <= 3; dv += 0.25) {
        if (walkable(w.u + du, w.v + dv) && du * du + dv * dv < bd) { bd = du * du + dv * dv; best = { u: w.u + du, v: w.v + dv } }
      }
      if (bd === Infinity) return
    }
    const t = worldToPct(best.u, best.v)
    setAgents(prev => prev.map(a => a.id !== BOSS_ID ? a : {
      ...a, state: 'walking-to-desk' as const, targetPosition: t, pathQueue: computePath(a.position, t),
    }))
  }, [])
  const sendMichaelHome = useCallback(() => {
    const meta = agentMetaRef.current.get(BOSS_ID)
    if (meta) meta.manualWalk = false
    cameraRef.current?.follow()
    setAgents(prev => prev.map(a => a.id !== BOSS_ID ? a : {
      ...a, state: 'walking-to-desk' as const, targetPosition: { ...a.deskPosition },
      pathQueue: computePath(a.position, a.deskPosition), spriteFacing: BOSS_SPOT?.spriteFacing ?? a.spriteFacing,
    }))
  }, [])
  // ---- Pick up & drop Michael ----
  const [carrying, setCarrying] = useState(false)
  const carryFromRef = useRef<{ x: number; y: number } | null>(null)
  const onPickMichael = useCallback((phase: 'start' | 'move' | 'drop', x: number, y: number) => {
    // hold him by the middle: feet hang about half his height below the cursor
    const roomEl = roomRef.current
    const h = roomEl ? roomEl.clientHeight : 1
    const sprite = roomEl ? roomEl.clientWidth * FLOOR.spriteScale : 80
    const feet = { x, y: Math.min(100, y + ((sprite * 0.42) / h) * 100) }
    const meta = agentMetaRef.current.get(BOSS_ID)
    if (phase === 'start') {
      const boss = agentsRef.current.find(a => a.id === BOSS_ID)
      carryFromRef.current = boss ? { ...boss.position } : null
      manualDirRef.current = { du: 0, dv: 0 }
      if (meta) meta.manualWalk = false
      setCarrying(true)
      if (!sfx.isMuted()) sfx.playNotification?.()
    }
    if (phase !== 'drop') {
      setAgents(prev => prev.map(a => a.id !== BOSS_ID ? a : {
        ...a, position: feet, targetPosition: feet, pathQueue: [], state: 'idle' as const,
      }))
      return
    }
    // drop: onto a free seat if he's over one, else the nearest floor he can stand on
    setCarrying(false)
    const others = agentsRef.current.filter(a => a.id !== BOSS_ID && a.state !== 'completed')
    const seat = seatAt(feet.x, feet.y, 0.9)
    const seatFree = seat && !others.some(o => Math.abs(o.position.x - seat.x) < 0.4 && Math.abs(o.position.y - seat.y) < 0.6)
    let land: { x: number; y: number } | null = seat && seatFree ? { x: seat.x, y: seat.y } : nearestWalkable(feet.x, feet.y, 3)
    if (!land) land = carryFromRef.current          // dropped off the building — put him back
    if (!land) return
    const atDesk = seat?.id === 'spot-1' && !!seatFree
    if (meta) { meta.idleSince = Date.now(); if (atDesk) meta.arrivedAtDeskAt = Date.now() }
    const l = land
    setAgents(prev => prev.map(a => a.id !== BOSS_ID ? a : {
      ...a, position: l, targetPosition: l, pathQueue: [],
      state: atDesk ? 'working' as const : 'idle' as const,
      spriteFacing: seat && seatFree ? seat.spriteFacing : 'front-left',
    }))
  }, [])

  // ---- Walk-up conversations: Michael stops next to someone → they greet him, chat goes to them ----
  const [talkPartner, setTalkPartner] = useState<{ id: string; role: string; name: string; color: string; title?: string; department?: string } | null>(null)
  /** the floating one-on-one chat: messages per person (kept for the session), and who's typing */
  const [dms, setDms] = useState<Map<string, DirectMsg[]>>(new Map())
  const [dmTyping, setDmTyping] = useState<string | null>(null)
  // The firm's work — inbox, project board, risk, books, alphas
  const [ops, setOps] = useState<OpsState | null>(null)
  const [opsOpen, setOpsOpen] = useState(false)
  const [opsTab, setOpsTab] = useState<OpsTab>('inbox')
  const [opsEmail, setOpsEmail] = useState<string | null>(null)
  const [mailToasts, setMailToasts] = useState<{ id: string; threadId: string; from: string; fromName: string; subject: string; high: boolean }[]>([])
  const opsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshOps = useCallback(() => {
    if (opsTimer.current) clearTimeout(opsTimer.current)
    opsTimer.current = setTimeout(() => {
      fetch('http://127.0.0.1:3334/ops/state').then(r => r.json()).then((d: OpsState) => { if (d && Array.isArray(d.emails)) setOps(d) }).catch(() => {})
    }, 250)
  }, [])
  useEffect(() => { refreshOps(); const t = setInterval(refreshOps, 60_000); return () => clearInterval(t) }, [refreshOps])
  const openOps = useCallback((tab: OpsTab, threadId: string | null = null) => {
    setOpsTab(tab); if (threadId) setOpsEmail(threadId); setOpsOpen(true); refreshOps()
  }, [refreshOps])
  const avatarFor = useCallback((slug: string) => {
    const role = slug === 'michael' ? BOSS_ROLE : (EMPLOYEE_BY_SLUG[slug]?.role ?? 'default')
    return getSpritePath(`role-${role}`, role, ROLE_TO_CHAR[role] ?? 'employee-3', 'front-right')
  }, [])
  const dmTypingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const addDm = useCallback((role: string, m: DirectMsg) => setDms(prev => {
    const n = new Map(prev); n.set(role, [...(prev.get(role) ?? []), m].slice(-60)); return n
  }), [])
  const partnerInfo = (role: string) => ({ title: EMPLOYEE_BY_ROLE[role]?.title, department: departmentOf(role)?.name })
  const talkPartnerRef = useRef<typeof talkPartner>(null)
  talkPartnerRef.current = talkPartner
  const metAtRef = useRef(new Map<string, number>())          // agent id → last time Michael met them
  const bossStillSinceRef = useRef<{ x: number; y: number; since: number } | null>(null)
  /** speech bubbles over heads: agent id → text, until */
  const [bubbles, setBubbles] = useState<Map<string, { text: string; until: number }>>(new Map())
  const sayBubble = useCallback((agentId: string, text: string, ms = 7000) => {
    setBubbles(prev => { const n = new Map(prev); n.set(agentId, { text, until: Date.now() + ms }); return n })
    setTimeout(() => setBubbles(prev => {
      const b = prev.get(agentId)
      if (!b || b.until > Date.now()) return prev
      const n = new Map(prev); n.delete(agentId); return n
    }), ms + 50)
  }, [])
  const endTalk = useCallback(() => {
    const p = talkPartnerRef.current
    if (!p) return
    setTalkPartner(null)
    fetch('http://127.0.0.1:3334/talk/end', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: p.role }) }).catch(() => {})
  }, [])
  /** clicked someone: Michael is on his way over — don't end the chat just because he's far away yet */
  const approachRef = useRef<{ until: number } | null>(null)
  const talkTo = useCallback((id: string) => {
    if (id === BOSS_ID) return
    const all = agentsRef.current
    const p = all.find(a => a.id === id), boss = all.find(a => a.id === BOSS_ID)
    if (!p || !boss || p.state === 'completed') return
    const cur = talkPartnerRef.current
    if (cur && cur.id !== id) endTalk()
    const pw = pctToWorld(p.position.x, p.position.y), bw = pctToWorld(boss.position.x, boss.position.y)
    const near = Math.hypot(pw.u - bw.u, pw.v - bw.v) < 2.2
    metAtRef.current.set(id, Date.now())
    if (!cur || cur.id !== id) {
      const cfg = AGENT_CONFIGS[p.role] ?? AGENT_CONFIGS['default']
      const name = EMPLOYEE_BY_ROLE[p.role]?.name ?? themedDisplayName(p.role, p.name)
      setTalkPartner({ id: p.id, role: p.role, name, color: cfg.color, ...partnerInfo(p.role) })
      fetch('http://127.0.0.1:3334/talk/encounter', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: p.role, place: p.assignedSpotId ? roomPhrase(p.assignedSpotId) : undefined }),
      }).catch(() => {})
    }
    if (near) return
    // stand next to them, on the side Michael is coming from
    let best: { u: number; v: number } | null = null, bd = Infinity
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * Math.PI * 2
      for (const r of [1.0, 1.4, 1.8]) {
        const u = pw.u + r * Math.cos(ang), v = pw.v + r * Math.sin(ang)
        if (!walkable(u, v)) continue
        const d = Math.hypot(u - bw.u, v - bw.v) + r * 3
        if (d < bd) { bd = d; best = { u, v } }
      }
    }
    if (!best) return
    approachRef.current = { until: Date.now() + 2500 }
    const t = worldToPct(best.u, best.v)
    walkMichaelTo(t.x, t.y)
  }, [endTalk, walkMichaelTo])

  useEffect(() => {
    if (!ISO_MODE) return
    const t = setInterval(() => {
      const all = agentsRef.current
      const boss = all.find(a => a.id === BOSS_ID)
      if (!boss) return
      const bw = pctToWorld(boss.position.x, boss.position.y)
      const bossRoom = roomAt(boss.position.x, boss.position.y)
      const now = Date.now()
      // has Michael stopped? (passing by doesn't count — he has to stop next to you)
      const st = bossStillSinceRef.current
      if (!st || Math.abs(st.x - boss.position.x) > 0.05 || Math.abs(st.y - boss.position.y) > 0.05) {
        bossStillSinceRef.current = { x: boss.position.x, y: boss.position.y, since: now }
      }
      const still = now - (bossStillSinceRef.current?.since ?? now) > 600 && boss.state !== 'walking-to-desk'
      const dist = (a: Agent) => { const w = pctToWorld(a.position.x, a.position.y); return Math.hypot(w.u - bw.u, w.v - bw.v) }
      // walked away → conversation over
      const partner = talkPartnerRef.current
      if (partner && approachRef.current) {
        if (boss.state === 'walking-to-desk' || now < approachRef.current.until) return   // still walking over
        approachRef.current = null
      }
      if (partner) {
        const p = all.find(a => a.id === partner.id)
        if (!p || p.state === 'completed' || dist(p) > 4.5 || roomAt(p.position.x, p.position.y) !== bossRoom) endTalk()
        return
      }
      if (!still || meetingActiveRef.current) return   // no walk-up chit-chat in the middle of a meeting
      let best: Agent | null = null, bd = 2.1
      for (const a of all) {
        if (a.id === BOSS_ID || a.state === 'completed' || a.state === 'walking-to-desk' || a.state === 'new-hire') continue
        if (roomAt(a.position.x, a.position.y) !== bossRoom) continue
        const d = dist(a)
        if (d < bd && now - (metAtRef.current.get(a.id) ?? 0) > 90_000) { bd = d; best = a }
      }
      if (!best) return
      metAtRef.current.set(best.id, now)
      const cfg = AGENT_CONFIGS[best.role] ?? AGENT_CONFIGS['default']
      const name = EMPLOYEE_BY_ROLE[best.role]?.name ?? themedDisplayName(best.role, best.name)
      setTalkPartner({ id: best.id, role: best.role, name, color: cfg.color, ...partnerInfo(best.role) })
      const place = best.assignedSpotId ? roomPhrase(best.assignedSpotId) : undefined
      fetch('http://127.0.0.1:3334/talk/encounter', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: best.role, place }),
      }).catch(() => {})
    }, 400)
    return () => clearInterval(t)
  }, [endTalk])

  const getPeople = useCallback(() => agentsRef.current
    .map(a => ({ id: a.id, x: a.position.x, y: a.position.y, color: a.color, boss: a.id === BOSS_ID })), [])

  // Pending side-effects: computed during state updater, flushed in useEffect
  const pendingEffectsRef = useRef<PendingEffect[]>([])
  const recentChatKeysRef = useRef<Set<string>>(new Set())
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Agents currently showing typing indicator (before a Slack message)
  const [typingAgents, setTypingAgents] = useState<Set<string>>(new Set())

  // Video mode: auto-type text into the Slack input
  const [autoTypeText, setAutoTypeText] = useState<string | undefined>(undefined)

  // ---------------------------------------------------------------------------
  // Slack chat helpers
  // ---------------------------------------------------------------------------

  // ---- Who's talking to whom (for the iso map: people turn to face each other) ----
  /** agent id → the agent they're talking with, until when */
  const convoRef = useRef(new Map<string, { with: string; until: number }>())
  const recentSpeakersRef = useRef<{ id: string; at: number }[]>([])
  const [gazeTick, setGazeTick] = useState(0)
  /** per person: glancing at Michael until, and when they might glance next */
  const glanceRef = useRef(new Map<string, { until: number; next: number }>())
  const noteSpeaker = (sender: string, role: string) => {
    if (!ISO_MODE) return
    const all = agentsRef.current
    const a = role === BOSS_ROLE ? all.find(x => x.id === BOSS_ID)
      : all.find(x => x.role === role) ?? all.find(x => x.name === sender)
    if (!a) return
    const now = Date.now()
    const recent = recentSpeakersRef.current.filter(r => now - r.at < 25000 && r.id !== a.id)
    const partner = recent[recent.length - 1]
    if (partner) {
      convoRef.current.set(a.id, { with: partner.id, until: now + 20000 })
      convoRef.current.set(partner.id, { with: a.id, until: now + 20000 })
      setGazeTick(t => t + 1)
    }
    recentSpeakersRef.current = [...recent.slice(-6), { id: a.id, at: now }]
  }
  // conversations expire → re-evaluate who's looking where every couple of seconds
  useEffect(() => {
    if (!ISO_MODE) return
    const t = setInterval(() => setGazeTick(x => x + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const addMsg = useCallback((
    sender: string,
    role: string,
    color: string,
    text: string,
    isSystem = false,
  ) => {
    if (!isSystem) noteSpeaker(sender, role)
    setMessages(prev => [...prev.slice(-50), {
      id: makeMsgId(),
      sender,
      senderSprite: role,
      senderColor: color,
      text,
      channel: 'office-general',
      timestamp: timeNow(),
      isSystem,
      reactions: undefined,
    }])
  }, [])

  // ---------------------------------------------------------------------------
  // Flush side-effects after state updates
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const effects = pendingEffectsRef.current
    if (effects.length === 0) return
    pendingEffectsRef.current = []

    for (const fx of effects) {
      if (fx.msg && !fx.msg.isSystem) {
        // Show typing indicator 500ms before message appears
        const role = fx.msg.role
        const agentId = agents.find(a => a.role === role)?.id
        if (agentId) {
          setTypingAgents(prev => new Set(prev).add(agentId))
          setTimeout(() => {
            setTypingAgents(prev => {
              const next = new Set(prev)
              next.delete(agentId)
              return next
            })
            addMsg(fx.msg!.sender, fx.msg!.role, fx.msg!.color, fx.msg!.text, fx.msg!.isSystem)
          }, 500)
        } else {
          addMsg(fx.msg.sender, fx.msg.role, fx.msg.color, fx.msg.text, fx.msg.isSystem)
        }
      } else if (fx.msg) {
        addMsg(fx.msg.sender, fx.msg.role, fx.msg.color, fx.msg.text, fx.msg.isSystem)
      }
      if (fx.sfx && !sfx.isMuted()) {
        switch (fx.sfx) {
          case 'doorOpen':    sfx.playDoorOpen(); break
          case 'typing':      sfx.playTyping(); break
          case 'celebration': sfx.playCelebration(); break
          case 'coffee':      sfx.playCoffee(); break
          case 'alarm':       sfx.playAlarm(); break
          case 'error':       sfx.playError(); break
          case 'powerDown':   sfx.playPowerDown(); break
          case 'notification': sfx.playNotification(); break
        }
      }
      if (fx.furnitureState) {
        const { id, state } = fx.furnitureState
        setFurnitureStates(prev => ({ ...prev, [id]: state }))
      }
    }
  })

  // Boss & Claude arrival messages (ref guard prevents StrictMode double-fire)
  const arrivedRef = useRef(false)
  useEffect(() => {
    if (arrivedRef.current) return
    arrivedRef.current = true
    const bossCfg = AGENT_CONFIGS[BOSS_ROLE] ?? AGENT_CONFIGS['default']
    addMsg(bossCfg.title, BOSS_ROLE, bossCfg.color, '👑 clocked in')
    const claudeCfg = AGENT_CONFIGS[CLAUDE_ROLE] ?? AGENT_CONFIGS['default']
    setTimeout(() => {
      addMsg(claudeCfg.title, CLAUDE_ROLE, claudeCfg.color, '🤖 clocked in')
    }, 1500)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------------------
  // Day/night cycle — compressed: 10 min = 24 hours
  // Timeline (600s total):
  //   0-60s:    dawn transition (night→day fade)
  //   60-300s:  daytime (full day)
  //   300-360s: dusk transition (day→night fade)
  //   360-600s: nighttime (full night)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const CYCLE_MS = 10 * 60 * 1000 // 10 minutes
    const startTime = Date.now()
    let lastPhase: DayPhase | null = null

    const tick = () => {
      if (FLOOR_MODE) {
        // Scranton floor: the light follows the office clock (real time + however far you've skipped ahead)
        const d = new Date(Date.now() + clockOffsetRef.current)
        setNightOpacity(nightAt(d))
        const ph = phaseAt(d)
        if (ph !== lastPhase) { lastPhase = ph; setDayPhase(ph) }
        return
      }
      const elapsed = (Date.now() - startTime) % CYCLE_MS
      const t = elapsed / 1000 // seconds into cycle

      let opacity: number
      let phase: DayPhase

      if (t < 60) {
        // Dawn: fade night→day (1→0)
        opacity = 1 - (t / 60)
        phase = 'dawn'
      } else if (t < 300) {
        // Daytime
        opacity = 0
        phase = t < 180 ? 'morning' : 'afternoon'
      } else if (t < 360) {
        // Dusk: fade day→night (0→1)
        opacity = (t - 300) / 60
        phase = 'dusk'
      } else {
        // Nighttime
        opacity = 1
        phase = 'night'
      }

      setNightOpacity(opacity)

      if (phase !== lastPhase) {
        lastPhase = phase
        setDayPhase(phase)
      }
    }

    tick() // initial
    const interval = setInterval(tick, 500) // update every 500ms for smooth fade
    return () => clearInterval(interval)
  }, [])

  // ---------------------------------------------------------------------------
  // WebSocket event handler
  // ---------------------------------------------------------------------------

  const handleEvent = useCallback((event: OfficeEvent) => {
    // Trading desk status → ticker tape (not an agent event)
    if (event.type === 'desk_update') {
      setDeskState(event as unknown as DeskState)
      return
    }
    if (event.type === 'meeting_start') {
      const ev = event as { reason?: string; roles?: string[] | null }
      startMeeting(ev.reason, ev.roles)
      return
    }
    if (event.type === 'meeting_end') {
      endMeeting()
      return
    }
    if (event.type === 'chat_message' && (event as unknown as { talk?: boolean }).talk) {
      const role = (event as unknown as { role?: string }).role
      const a = agentsRef.current.find(x => x.role === role)
      if (a && event.text) sayBubble(a.id, event.text)
    }
    if ((event.type as string) === 'dm_typing') {
      const ev = event as unknown as { role: string }
      setDmTyping(ev.role)
      if (dmTypingTimer.current) clearTimeout(dmTypingTimer.current)
      dmTypingTimer.current = setTimeout(() => setDmTyping(null), 15000)
      return
    }
    if ((event.type as string) === 'dm_message') {
      const ev = event as unknown as { role: string; text: string; at: number }
      addDm(ev.role, { from: 'staff', text: ev.text, at: ev.at })
      setDmTyping(prev => (prev === ev.role ? null : prev))
      const a = agentsRef.current.find(x => x.role === ev.role)
      if (a) sayBubble(a.id, ev.text)
      if (!sfx.isMuted()) sfx.playNotification()
      return
    }
    if ((event.type as string) === 'ops_update') { refreshOps(); return }
    if ((event.type as string) === 'ops_email') {
      const ev = event as unknown as { id: string; threadId: string; from: string; fromName: string; subject: string; priority?: string | null }
      setMailToasts(prev => [...prev.filter(t => t.id !== ev.id), { id: ev.id, threadId: ev.threadId ?? ev.id, from: ev.from, fromName: ev.fromName, subject: ev.subject, high: ev.priority === 'high' }].slice(-3))
      setTimeout(() => setMailToasts(prev => prev.filter(t => t.id !== ev.id)), 9000)
      if (!sfx.isMuted()) sfx.playNotification()
      refreshOps()
      return
    }
    if ((event.type as string) === 'staff_activity') {
      const ev = event as unknown as { role: string; text: string }
      const a = agentsRef.current.find(x => x.role === ev.role)
      if (a && !talkPartnerRef.current) sayBubble(a.id, ev.text, 5000)
      return
    }
    if ((event.type as string) === 'market_bell') {
      if (!sfx.isMuted()) sfx.playBell()
      return
    }
    if ((event.type as string) === 'clock_update') {
      const ev = event as unknown as { offsetMs: number; now: number; jumpedMs?: number }
      setClockOffset(prev => Math.max(prev, ev.offsetMs))   // never back
      if (ev.jumpedMs && ev.jumpedMs > 0) {
        const h = ev.jumpedMs / 3600000
        const span = h >= 48 ? `${Math.round(h / 24)} days` : h >= 1 ? `${Math.round(h * 10) / 10}h` : `${Math.round(h * 60)} min`
        const d = new Date(ev.now)
        const when = d.toLocaleString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) + ', ' +
          d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        setTimeout(() => addMsg('system', 'default', '#888', `⏩ Office clock jumped ahead ${span} — it's now ${when}.`, true), 0)
      }
      return
    }
    if ((event.type as string) === 'go_to_desks') {
      goToDesks()
      return
    }
    const effects: PendingEffect[] = []

    setAgents(prev => {
      switch (event.type) {
        // ── New agent spawned ────────────────────────────────────────────────
        case 'agent_spawned': {
          const raw = event.agent ?? {}
          const id   = raw.id   ?? `agent-${Date.now()}`
          const name = raw.name ?? 'Agent'
          const role = raw.role ?? 'general-purpose'
          const task = raw.task

          // Already tracked? Skip.
          if (prev.some(a => a.id === id)) return prev

          // Filing roles go to the filing cabinet, others get a desk
          const isFiler = FILING_ROLES.has(role)
          const filingTaken = isFiler && FILING_SPOT !== null && prev.some(a => a.assignedSpotId === FILING_SPOT.id)

          let spot
          let homeSpot: string | null = null
          if (FLOOR_MODE) {
            const seat = assignFloorSeat(prev, role)
            spot = seat?.spot ?? null
            homeSpot = seat?.home ?? null
          } else if (isFiler && !filingTaken && FILING_SPOT !== null) {
            spot = FILING_SPOT
          } else {
            spot = assignSpot(prev, MAIN_ROOM.agentSpots)
          }

          if (!spot) {
            const cfg = AGENT_CONFIGS[role] ?? AGENT_CONFIGS['default']
            effects.push({ msg: { sender: name, role, color: cfg.color, text: 'waiting for a desk...' } })
            return prev
          }

          const agentBase = createAgent({ id, name, role, task, spot })
          let agent: Agent = {
            ...agentBase,
            pathQueue: computePath(agentBase.position, agentBase.targetPosition),
          }
          if (FLOOR_MODE && homeSpot && spot.id !== homeSpot) {
            agent.statusText = `desk's taken — hanging out ${roomPhrase(spot.id)}`
          }

          // Initialise runtime meta
          const newMeta: AgentMeta = {
            spawnedAt: Date.now(),
            arrivedAtDeskAt: null,
            idleSince: null,
            onBreak: false,
            breakStartedAt: null,
            homeSpot,
            lastWander: Date.now(),
          }
          // A meeting is on → walk straight into the conference room
          if (FLOOR_MODE && meetingActiveRef.current && (!meetingRolesRef.current || meetingRolesRef.current.has(role))) {
            const seatId = freeMeetingSeat(prev)
            if (seatId) {
              const ms = FLOOR_SPOTS[seatId]
              newMeta.meetingSpot = seatId
              agent = { ...agent, targetPosition: { x: ms.x, y: ms.y }, pathQueue: computePath(agent.position, ms),
                spriteFacing: ms.spriteFacing, statusText: 'heading into the meeting' }
            }
          }
          agentMetaRef.current.set(id, newMeta)

          const cfg = AGENT_CONFIGS[role] ?? AGENT_CONFIGS['default']
          effects.push({
            msg: { sender: name, role, color: cfg.color, text: task ? `📋 ${task}` : spawnMessage() },
            sfx: 'doorOpen',
          })

          return [...prev, agent]
        }

        // ── Agent started working / status update ──────────────────────────
        case 'agent_working': {
          const id = event.agentId ?? event.agent?.id
          const statusMsg = event.status ?? workMessage()

          if (id) {
            // Targeted update — specific agent
            return prev.map(a => {
              if (a.id !== id) return a
              const cfg = AGENT_CONFIGS[a.role] ?? AGENT_CONFIGS['default']
              // Desk analysts show their status as a speech bubble only — their chat line comes later
              if (!event.desk) {
                effects.push({
                  msg: { sender: a.name, role: a.role, color: cfg.color, text: `⚡ ${statusMsg}` },
                })
              }
              return { ...a, state: 'working' as const, statusText: statusMsg }
            })
          }

          // No agentId — broadcast to a random working agent (tool use from main thread)
          const workers = prev.filter(a => a.state === 'working' && a.id !== BOSS_ID)
          if (workers.length > 0) {
            const target = workers[Math.floor(Math.random() * workers.length)]
            const cfg = AGENT_CONFIGS[target.role] ?? AGENT_CONFIGS['default']
            effects.push({
              msg: { sender: target.name, role: target.role, color: cfg.color, text: `⚡ ${statusMsg}` },
            })
            return prev.map(a =>
              a.id === target.id ? { ...a, statusText: statusMsg } : a
            )
          }

          return prev
        }

        // ── Agent completed task ─────────────────────────────────────────────
        case 'agent_completed': {
          const id = event.agentId ?? event.agent?.id
          if (!id) return prev

          // Delay departure if agent hasn't been visible long enough
          const completeMeta = agentMetaRef.current.get(id)
          if (completeMeta) {
            const elapsed = Date.now() - completeMeta.spawnedAt
            if (elapsed < MIN_VISIBLE_TIME) {
              const delay = MIN_VISIBLE_TIME - elapsed
              setTimeout(() => handleEvent(event), delay)
              return prev
            }
          }

          return prev.map(a => {
            if (a.id !== id) return a
            const cfg = AGENT_CONFIGS[a.role] ?? AGENT_CONFIGS['default']
            const resultMsg = event.result ?? doneMessage()
            // Why: desk analysts already posted their findings in character — just play the sfx
            const isDeskAgent = event.desk || a.id.startsWith('desk-')
            effects.push(isDeskAgent
              ? { sfx: 'celebration' }
              : {
                  msg: { sender: a.name, role: a.role, color: cfg.color, text: `✅ ${resultMsg}` },
                  sfx: 'celebration',
                })

            // Boss replies to completed tasks
            const bossCfg = AGENT_CONFIGS[BOSS_ROLE] ?? AGENT_CONFIGS['default']
            const bossReplies = [
              `nice work ${a.name} 👊`,
              `solid 🔥`,
              `ship it!`,
              `great stuff, grab a Red Bull`,
              `legend 💯`,
              `good job, who\'s next?`,
              `that was quick, another one?`,
              `clean work 👌`,
              `cheers ${a.name}`,
              `merged. next task loading...`,
            ]
            // Why: when Office theme is on, Michael Scott occasionally lands his signature line.
            const isMichael = getTheme() === 'office'
            const michaelReplies = [
              `nice trade ${a.name} 👊`,
              `I declare... PROFIT!`,
              `World's Best Managing Partner approves 🏆`,
              `that's going in the Dundies reel`,
              `buy high, sell higher. legend 💯`,
            ]
            const reply = isMichael && Math.random() < 0.25
              ? `That's what she said 😏`
              : isMichael
                ? michaelReplies[Math.floor(Math.random() * michaelReplies.length)]
                : bossReplies[Math.floor(Math.random() * bossReplies.length)]
            if (!isDeskAgent) {
              effects.push({
                msg: { sender: bossCfg.title, role: BOSS_ROLE, color: bossCfg.color, text: reply },
              })
            }

            // Mark as completed and start walking to door
            const meta = agentMetaRef.current.get(a.id)
            if (meta) {
              meta.arrivedAtDeskAt = null
              meta.onBreak = false
            }
            // Close filing cabinet if this agent was using it
            if (a.assignedSpotId === 'spot-filing') {
              effects.push({ furnitureState: { id: 'filing-1', state: 'closed' } })
            }

            return {
              ...a,
              state: 'completed' as const,
              targetPosition: { ...DOOR_TARGET },
              statusText: event.result ?? doneMessage(),
              pathQueue: computePath(a.position, DOOR_TARGET),
            }
          })
        }

        // ── MCP call started ─────────────────────────────────────────────────
        case 'mcp_call': {
          const server = (event as any).server ?? ''
          const tool = (event as any).tool ?? ''
          const id = event.agentId ?? event.agent?.id
          if (!id) return prev
          const mcpMsg = `🔌 ${server} → ${tool}`
          return prev.map(a => {
            if (a.id !== id) return a
            const cfg = AGENT_CONFIGS[a.role] ?? AGENT_CONFIGS['default']
            effects.push({ msg: { sender: a.name, role: a.role, color: cfg.color, text: mcpMsg } })
            return { ...a, statusText: `${server}.${tool}` }
          })
        }

        // ── MCP call finished ────────────────────────────────────────────────
        case 'mcp_done': {
          const id = event.agentId ?? event.agent?.id
          if (!id) return prev
          return prev.map(a =>
            a.id === id
              ? { ...a, statusText: event.result ?? 'done' }
              : a
          )
        }

        // ── Typing indicator ─────────────────────────────────────────────
        case 'chat_typing': {
          if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
          setChatTypingUser((event as any).sender ?? '')
          typingTimeoutRef.current = setTimeout(() => setChatTypingUser(null), 10000)
          return prev
        }

        // ── Emoji reactions on a message ──────────────────────────────────
        case 'chat_reaction': {
          const { messageId, reactions } = event as any
          if (messageId && reactions) {
            setMessages(prev => prev.map(m =>
              m.id === messageId ? { ...m, reactions } : m
            ))
          }
          return prev
        }

        // ── Read receipt ──────────────────────────────────────────────────
        case 'chat_seen': {
          setLastSeenId((event as any).messageId ?? null)
          return prev
        }

        // ── Chat message from server (Claude replying via an agent) ──────
        case 'chat_message': {
          const sender = event.sender ?? 'Agent'
          const text = event.text ?? ''
          const ts = (event as any).timestamp as number | undefined

          // Clear typing indicator when Claude sends a real message
          setChatTypingUser(null)

          // Skip messages from the boss — those are added locally by onSendMessage
          const bossCfg = AGENT_CONFIGS[BOSS_ROLE] ?? AGENT_CONFIGS['default']
          if (sender === bossCfg.title || sender.toLowerCase() === bossCfg.title.toLowerCase()) {
            return prev
          }

          // Deduplicate by timestamp+text — skip if we already have this exact message
          const dedupKey = `${ts ?? 0}:${text}`
          if (recentChatKeysRef.current.has(dedupKey)) {
            return prev
          }
          recentChatKeysRef.current.add(dedupKey)
          // Keep the set from growing unbounded
          if (recentChatKeysRef.current.size > 50) {
            const first = recentChatKeysRef.current.values().next().value
            if (first !== undefined) recentChatKeysRef.current.delete(first)
          }

          // Server-side system notices (slash-command results, desk status) render as system lines
          if ((event as any).isSystem || sender === 'system') {
            setTimeout(() => addMsg('system', 'default', '#888', text, true), 0)
            return prev
          }

          const role = (event as any).role as string | undefined
          let msgSender: string, msgRole: string, msgColor: string

          // If sender is "Claude" (from AI watcher/bridge), always attribute to Claude
          if (sender.toLowerCase() === 'claude') {
            const claudeCfg = AGENT_CONFIGS[CLAUDE_ROLE] ?? AGENT_CONFIGS['default']
            msgSender = claudeCfg.title; msgRole = CLAUDE_ROLE; msgColor = claudeCfg.color
          } else if (role && AGENT_CONFIGS[role]) {
            const cfg = AGENT_CONFIGS[role]
            msgSender = cfg.title; msgRole = role; msgColor = cfg.color
          } else {
            // Attribute to a working agent or fall back to Claude
            const workers = prev.filter(a => a.id !== BOSS_ID && a.id !== CLAUDE_ID && a.state === 'working')
            if (workers.length > 0) {
              const agent = workers[Math.floor(Math.random() * workers.length)]
              const cfg = AGENT_CONFIGS[agent.role] ?? AGENT_CONFIGS['default']
              msgSender = agent.name; msgRole = agent.role; msgColor = cfg.color
            } else {
              const claudeCfg = AGENT_CONFIGS[CLAUDE_ROLE] ?? AGENT_CONFIGS['default']
              msgSender = claudeCfg.title; msgRole = CLAUDE_ROLE; msgColor = claudeCfg.color
            }
          }
          // Use setTimeout to escape the setAgents updater before calling addMsg
          setTimeout(() => addMsg(msgSender, msgRole, msgColor, text), 0)
          return prev
        }

        default:
          return prev
      }
    })

    // Schedule effects to be flushed after state settles
    pendingEffectsRef.current.push(...effects)
  }, [])

  // ---------------------------------------------------------------------------
  // WebSocket connection
  // ---------------------------------------------------------------------------

  useAgentSocket({ onEvent: handleEvent, url: 'ws://localhost:3334/ws', disabled: isSimMode })

  // ---------------------------------------------------------------------------
  // Simulation loop — spawns/completes fake agents (only in ?sim mode)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!isSimMode) return
    const timers: ReturnType<typeof setTimeout>[] = []
    const intervals: ReturnType<typeof setInterval>[] = []

    // ---- Office-theme rotation sim: 10 staff, constant door churn, cycles all 22 ----
    if (getTheme() === 'office' && !isVideoMode) {
      // Why: roles are synthetic "dm-0..dm-9" so each slot gets its own cast entry
      const STAFF_COUNT = 10
      const ROTATION_MS = 9000 // Why: fast enough to see all 22 in <2 min
      const ROLES = ['debugger', 'code-reviewer', 'frontend-developer', 'fullstack-developer',
                      'test-engineer', 'security-auditor', 'devops-engineer',
                      'architect-reviewer', 'performance-engineer', 'ai-engineer'] as const
      let lastRetired: string | null = null

      const spawnSlot = (slotIdx: number, initialDelay = 0) => {
        const role = `dm-slot-${slotIdx}`
        const baseRole = ROLES[slotIdx % ROLES.length]
        const cfg = AGENT_CONFIGS[baseRole] ?? AGENT_CONFIGS['default']
        const slug = nextUnusedOfficeCharacter(new Set(lastRetired ? [lastRetired] : []))
        const displayName = displayNameFromSlug(slug)

        timers.push(setTimeout(() => {
          // Why: force this synthetic role to map to the chosen Office character
          assignCharacterToRole(role, slug)
          handleEvent({
            type: 'agent_spawned',
            agent: {
              id: `dm-${slotIdx}-${Date.now()}`,
              name: displayName,
              role, // synthetic — so castByRole maps uniquely
              task: `Dunder Mifflin — ${displayName}`,
            },
          })
          timers.push(setTimeout(() => {
            addMsg(displayName, role, cfg.color, `clocked in — ${displayName} reporting`)
          }, 1000))
        }, initialDelay))
      }

      // Spawn 10 staff staggered over first 8s
      for (let i = 0; i < STAFF_COUNT; i++) {
        spawnSlot(i, i * 800)
      }

      // Rotation: every ROTATION_MS, retire oldest agent, spawn a new one in its slot
      let nextSlotToRotate = 0
      intervals.push(setInterval(() => {
        const slotIdx = nextSlotToRotate % STAFF_COUNT
        nextSlotToRotate++
        const role = `dm-slot-${slotIdx}`

        // Find the current agent for this slot and complete it (walks to door, exits)
        setAgents(prev => {
          const agent = prev.find(a => a.role === role)
          if (agent) {
            lastRetired = null // will be set after release
            handleEvent({
              type: 'agent_completed',
              agentId: agent.id,
              result: `${agent.name} heading out for a pretzel`,
            })
          }
          return prev
        })

        // After the exit animation, release the cast slot and spawn replacement
        timers.push(setTimeout(() => {
          releaseRole(role)
          spawnSlot(slotIdx, 800) // small gap before new hire walks in
        }, 3500))
      }, ROTATION_MS))

      // Periodic Office chatter from random staff
      intervals.push(setInterval(() => {
        setAgents(prev => {
          const staff = prev.filter(a => a.role.startsWith('dm-slot-'))
          if (staff.length === 0) return prev
          const speaker = staff[Math.floor(Math.random() * staff.length)]
          const lines = OFFICE_SIM_TOOL_MESSAGES[ROLES[parseInt(speaker.role.split('-')[2], 10) % ROLES.length]] ?? []
          const line = lines[Math.floor(Math.random() * lines.length)] ?? 'selling paper'
          const cfg = AGENT_CONFIGS[ROLES[0]] ?? AGENT_CONFIGS['default']
          addMsg(speaker.name, speaker.role, cfg.color, line)
          return prev
        })
      }, 4500))

      return () => {
        timers.forEach(t => clearTimeout(t))
        intervals.forEach(i => clearInterval(i))
      }
    }

    // Helper: post a message with an optional typing indicator beforehand.
    // showTyping=true will set a typing state for ~1.5s before the message appears.
    const postWithTyping = (
      sender: string,
      role: string,
      msg: string,
      delay: number,
      showTyping: boolean,
    ) => {
      if (showTyping) {
        timers.push(setTimeout(() => {
          setChatTypingUser(sender)
        }, delay))
        timers.push(setTimeout(() => {
          const cfg = AGENT_CONFIGS[role] ?? AGENT_CONFIGS['default']
          setChatTypingUser(null)
          addMsg(sender, role, cfg.color, msg)
        }, delay + 1500))
      } else {
        timers.push(setTimeout(() => {
          const cfg = AGENT_CONFIGS[role] ?? AGENT_CONFIGS['default']
          addMsg(sender, role, cfg.color, msg)
        }, delay))
      }
    }

    // Helper: add a random emoji reaction to the second-to-last chat message.
    const reactToLastMsg = (delay: number) => {
      timers.push(setTimeout(() => {
        setMessages(prev => {
          const target = prev[prev.length - 2]
          if (target && !target.reactions?.length) {
            const emoji = ['👍', '🔥', '😂', '🚀', '💯'][Math.floor(Math.random() * 5)]
            return prev.map(m => m.id === target.id ? { ...m, reactions: [emoji] } : m)
          }
          return prev
        })
      }, delay))
    }

    // Phase 1: Stagger-spawn 3 agents (1s, 3s, 5s) with proactive "starting:" messages
    SIM_SCENARIOS.forEach((sim, i) => {
      const cfg = AGENT_CONFIGS[sim.role] ?? AGENT_CONFIGS['default']
      const spawnAt = 1000 + i * 2500
      timers.push(setTimeout(() => {
        handleEvent({
          type: 'agent_spawned',
          agent: {
            id: `sim-${sim.role}`,
            name: cfg.title,
            role: sim.role,
            task: sim.task,
          },
        })
        // Proactive "starting:" message a moment after spawn
        timers.push(setTimeout(() => {
          addMsg(cfg.title, sim.role, cfg.color, `starting: ${sim.task}`)
        }, 1200))
      }, spawnAt))
    })

    // Phase 2: Drip-feed task progress messages
    const msgIndexes = SIM_SCENARIOS.map(() => 0)
    timers.push(setTimeout(() => {
      const progressInterval = setInterval(() => {
        // Pick a random agent to send a progress update
        const idx = Math.floor(Math.random() * SIM_SCENARIOS.length)
        const sim = SIM_SCENARIOS[idx]
        const msgIdx = msgIndexes[idx]
        if (msgIdx < sim.slackMessages.length) {
          const cfg = AGENT_CONFIGS[sim.role] ?? AGENT_CONFIGS['default']
          // Show typing indicator before every other progress message
          const useTyping = msgIdx % 2 === 0
          if (useTyping) {
            setChatTypingUser(cfg.title)
            timers.push(setTimeout(() => {
              setChatTypingUser(null)
              addMsg(cfg.title, sim.role, cfg.color, sim.slackMessages[msgIdx])
            }, 1500))
          } else {
            addMsg(cfg.title, sim.role, cfg.color, sim.slackMessages[msgIdx])
          }
          msgIndexes[idx]++

          // Add a reaction to the previous message after a short delay
          reactToLastMsg(3000)

          // Trigger ultra-think powerup on specific messages
          if (sim.slackMessages[msgIdx].includes('race condition') ||
              sim.slackMessages[msgIdx].includes('scanning') ||
              sim.slackMessages[msgIdx].includes('architecture')) {
            setAgents(prev => prev.map(a =>
              a.role === sim.role
                ? { ...a, statusText: 'ultra-think: deep analysis...' }
                : a
            ))
            // Clear ultra-think after a few seconds
            timers.push(setTimeout(() => {
              setAgents(prev => prev.map(a =>
                a.role === sim.role
                  ? { ...a, statusText: sim.slackMessages[msgIdx] }
                  : a
              ))
            }, 8000))
          }
        }
      }, 4000)
      intervals.push(progressInterval)
    }, 12000)) // start after agents have settled at desks

    // Phase 3: Random chatter between agents — typing indicator on every 3rd message
    timers.push(setTimeout(() => {
      let chatterIdx = 0
      const chatterInterval = setInterval(() => {
        // Why: pool chosen at fire time so /the-office toggle mid-sim swaps the chatter instantly
        const pool = getTheme() === 'office' ? OFFICE_SIM_CHATTER : SIM_CHATTER
        if (chatterIdx >= pool.length) {
          chatterIdx = 0 // loop
        }
        const chat = pool[chatterIdx]
        const showTyping = chatterIdx % 3 === 0
        postWithTyping(chat.sender, chat.role, chat.msg, 0, showTyping)

        // React to the previous message after some chatter
        if (chatterIdx % 4 === 2) {
          reactToLastMsg(4000)
        }

        chatterIdx++
      }, 7000)
      intervals.push(chatterInterval)
    }, 18000))

    // Phase 4: Spawn an Explore agent partway through (codebase search)
    timers.push(setTimeout(() => {
      const exploreCfg = AGENT_CONFIGS['Explore'] ?? AGENT_CONFIGS['default']
      handleEvent({
        type: 'agent_spawned',
        agent: {
          id: 'sim-explore',
          name: exploreCfg.title,
          role: 'Explore',
          task: 'Searching codebase for API endpoint patterns',
        },
      })
      timers.push(setTimeout(() => {
        addMsg(exploreCfg.title, 'Explore', exploreCfg.color, 'starting: Searching codebase for API endpoint patterns')
      }, 1200))
      // Explorer completes and leaves after 20s
      timers.push(setTimeout(() => {
        handleEvent({
          type: 'agent_completed',
          agentId: 'sim-explore',
          result: 'Found 12 API endpoints across 4 route files',
        })
        timers.push(setTimeout(() => {
          addMsg(exploreCfg.title, 'Explore', exploreCfg.color, 'done: Found 12 API endpoints across 4 route files')
        }, 800))
      }, 20000))
    }, 25000))

    // Phase 5: One agent completes task, walks to door, leaves — then a new one spawns
    timers.push(setTimeout(() => {
      handleEvent({
        type: 'agent_completed',
        agentId: 'sim-code-reviewer',
        result: 'PR #487 approved — ready to merge',
      })
      timers.push(setTimeout(() => {
        const reviewCfg = AGENT_CONFIGS['code-reviewer'] ?? AGENT_CONFIGS['default']
        addMsg(reviewCfg.title, 'code-reviewer', reviewCfg.color, 'done: PR #487 approved — ready to merge')
      }, 800))
      // Replacement agent arrives
      timers.push(setTimeout(() => {
        const cfg = AGENT_CONFIGS['debugger'] ?? AGENT_CONFIGS['default']
        handleEvent({
          type: 'agent_spawned',
          agent: {
            id: 'sim-debugger',
            name: cfg.title,
            role: 'debugger',
            task: 'Investigating null pointer in payment webhook handler',
          },
        })
        timers.push(setTimeout(() => {
          addMsg(cfg.title, 'debugger', cfg.color, 'starting: Investigating null pointer in payment webhook handler')
        }, 1200))
      }, 8000))
    }, 50000))

    return () => {
      timers.forEach(t => clearTimeout(t))
      intervals.forEach(i => clearInterval(i))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------------------
  // Video mode — scripted demo for TikTok recording (?video)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!isVideoMode) return
    const timers: ReturnType<typeof setTimeout>[] = []
    const bossCfg = AGENT_CONFIGS[BOSS_ROLE] ?? AGENT_CONFIGS['default']

    const officeSim0 = getTheme() === 'office'

    // 0-3s: Office is just Antony, settling in
    timers.push(setTimeout(() => {
      addMsg(bossCfg.title, BOSS_ROLE, bossCfg.color,
        officeSim0 ? "👑 World's Best Boss clocked in, let's sell some paper" : '👑 clocked in, lets get to work')
    }, 2000))

    // 4s: Antony types a question in Slack
    timers.push(setTimeout(() => {
      setAutoTypeText(officeSim0
        ? (OFFICE_SIM_BOSS_PROMPTS[0] ?? '/ultra-think audit our authentication system for security vulnerabilities')
        : '/ultra-think audit our authentication system for security vulnerabilities')
    }, 4000))

    // 8s: 3 agents spawn with ultra-think tasks (energy drinks!)
    timers.push(setTimeout(() => {
      const spawns = [
        { id: 'vid-security', role: 'security-auditor', name: 'Security', task: 'ultra-think: deep analysis of auth middleware vulnerabilities' },
        { id: 'vid-reviewer', role: 'code-reviewer', name: 'Reviewer', task: 'ultra-think: reviewing authentication token handling' },
        { id: 'vid-frontend', role: 'frontend-developer', name: 'Frontend', task: 'ultra-think: auditing client-side auth state management' },
      ]
      spawns.forEach((s, i) => {
        timers.push(setTimeout(() => {
          handleEvent({ type: 'agent_spawned', agent: s })
        }, i * 2000))
      })
    }, 8000))

    // 16s: Realistic tool output messages in Slack.
    // Why: swap to Office-themed chatter when /the-office mode is on at sim start
    const isOfficeSim = getTheme() === 'office'
    const defaultToolMessages = [
      { t: 16000, sender: 'Security', role: 'security-auditor', text: '⚡ reading src/auth/middleware.ts' },
      { t: 18000, sender: 'Reviewer', role: 'code-reviewer', text: '⚡ running: grep -r "jwt" src/' },
      { t: 20000, sender: 'Security', role: 'security-auditor', text: '⚠️ session tokens stored in localStorage — XSS risk' },
      { t: 22000, sender: 'Frontend', role: 'frontend-developer', text: '⚡ reading src/hooks/useAuth.ts' },
      { t: 24000, sender: 'Reviewer', role: 'code-reviewer', text: '🔍 checking CORS config on /api/auth endpoints' },
      { t: 26000, sender: 'Security', role: 'security-auditor', text: '🚨 JWT refresh token has no expiry set' },
      { t: 28000, sender: 'Frontend', role: 'frontend-developer', text: '⚡ editing src/auth/tokenStore.ts' },
      { t: 30000, sender: 'Reviewer', role: 'code-reviewer', text: '💡 suggesting httpOnly cookies instead of localStorage' },
    ]
    const toolMessages = isOfficeSim
      ? defaultToolMessages.map((m, i) => {
          const pool = OFFICE_SIM_TOOL_MESSAGES[m.role] ?? []
          return { ...m, text: pool[i % pool.length] ?? m.text }
        })
      : defaultToolMessages
    toolMessages.forEach(({ t, sender, role, text }) => {
      timers.push(setTimeout(() => {
        const cfg = AGENT_CONFIGS[role] ?? AGENT_CONFIGS['default']
        addMsg(sender, role, cfg.color, text)
      }, t))
    })

    // 25s: Antony types a follow-up
    timers.push(setTimeout(() => {
      setAutoTypeText(isOfficeSim ? (OFFICE_SIM_BOSS_PROMPTS[1] ?? 'how bad is the localStorage issue?') : 'how bad is the localStorage issue?')
    }, 25000))

    // 27s: Agent replies
    timers.push(setTimeout(() => {
      const cfg = AGENT_CONFIGS['security-auditor'] ?? AGENT_CONFIGS['default']
      addMsg('Security', 'security-auditor', cfg.color,
        isOfficeSim
          ? 'critical — Dwight-level bad. any XSS gives full account takeover. moving to httpOnly cookies now'
          : 'critical — any XSS gives full account takeover. moving to httpOnly cookies now')
    }, 27500))

    // 30s: Random chatter
    timers.push(setTimeout(() => {
      const cfg = AGENT_CONFIGS['frontend-developer'] ?? AGENT_CONFIGS['default']
      addMsg('Frontend', 'frontend-developer', cfg.color,
        isOfficeSim ? 'I can handle the cookie migration — easier than organizing the Dundies' : 'I can handle the cookie migration on the client side')
    }, 30000))

    timers.push(setTimeout(() => {
      const cfg = AGENT_CONFIGS['code-reviewer'] ?? AGENT_CONFIGS['default']
      addMsg('Reviewer', 'code-reviewer', cfg.color,
        isOfficeSim ? 'lgtm. ship it to Stamford, boom. roasted.' : 'lgtm on the approach, lets ship it')
    }, 32000))

    // 33s: Antony checks status with a slash command
    timers.push(setTimeout(() => {
      setAutoTypeText('/status')
    }, 33000))

    // 35s: Explorer spawns to check codebase
    timers.push(setTimeout(() => {
      handleEvent({
        type: 'agent_spawned',
        agent: { id: 'vid-explore', name: 'Explorer', role: 'Explore', task: 'Scanning auth-related files across codebase' },
      })
    }, 35000))

    // 38s: Pizza delivery event!
    timers.push(setTimeout(() => {
      addMsg('system', 'default', '#8b8d91',
        officeSim0 ? '🥨 IT\'S PRETZEL DAY' : '🍕 Pizza has arrived! Free lunch!', true)
      addMsg(bossCfg.title, BOSS_ROLE, bossCfg.color,
        officeSim0 ? "You don't understand. It's pretzel day." : 'Pizza in the lobby!')
      // Move all agents to door
      setAgents(prev => prev.map(a => ({
        ...a,
        state: 'walking-to-desk' as const,
        targetPosition: { x: 67.5, y: 48.9 },
        pathQueue: computePath(a.position, { x: 67.5, y: 48.9 }),
        statusText: 'Pizza Delivery',
      })))
      // Back to desks after 5s
      timers.push(setTimeout(() => {
        setAgents(prev => prev.map(a => ({
          ...a,
          state: 'walking-to-desk' as const,
          targetPosition: { ...a.deskPosition },
          pathQueue: computePath(a.position, a.deskPosition),
          statusText: 'back to work',
        })))
      }, 5000))
    }, 38000))

    // 45s: Agent chatter after pizza/pretzels
    timers.push(setTimeout(() => {
      const cfg = AGENT_CONFIGS['security-auditor'] ?? AGENT_CONFIGS['default']
      addMsg('Security', 'security-auditor', cfg.color,
        officeSim0 ? 'all the toppings. Stanley has been waiting all year.' : 'pineapple on pizza is a security vulnerability')
    }, 46000))

    timers.push(setTimeout(() => {
      const cfg = AGENT_CONFIGS['frontend-developer'] ?? AGENT_CONFIGS['default']
      addMsg('Frontend', 'frontend-developer', cfg.color,
        officeSim0 ? "that's what she said" : '😂')
    }, 47500))

    // 48s: Security completes
    timers.push(setTimeout(() => {
      handleEvent({
        type: 'agent_completed',
        agentId: 'vid-security',
        result: officeSim0
          ? 'Audit complete — beets secured. 3 critical issues booked into the Schrute Manual.'
          : 'Auth audit complete — 3 critical issues fixed, 2 PRs merged',
      })
    }, 48000))

    // 52s: Explorer completes
    timers.push(setTimeout(() => {
      handleEvent({
        type: 'agent_completed',
        agentId: 'vid-explore',
        result: officeSim0 ? 'Found 8 auth files — all filed under B for "Beet".' : 'Found 8 auth-related files, all updated',
      })
    }, 52000))

    // 55s: Antony wraps up
    timers.push(setTimeout(() => {
      setAutoTypeText(officeSim0 ? 'great work team — boom. roasted. 🥨' : 'great work team, ship it! 🚀')
    }, 55000))

    // 58s: Remaining agents complete
    timers.push(setTimeout(() => {
      handleEvent({ type: 'agent_completed', agentId: 'vid-reviewer',
        result: officeSim0 ? 'All PRs reviewed — Jim-approved.' : 'All PRs reviewed and approved' })
    }, 58000))

    timers.push(setTimeout(() => {
      handleEvent({ type: 'agent_completed', agentId: 'vid-frontend',
        result: officeSim0 ? 'Cookies deployed — Kevin took half for his chili.' : 'Cookie migration deployed to staging' })
    }, 60000))

    return () => timers.forEach(t => clearTimeout(t))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------------------
  // Animation loop — moves agents toward their targets each frame
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let rafId: number
    let lastTime = performance.now()

    function tick(now: number) {
      const dt = Math.min((now - lastTime) / 16.67, 3)
      lastTime = now

      const prev = agentsRef.current
      if (prev.length === 0) {
        rafId = requestAnimationFrame(tick)
        return
      }

      const nowMs = Date.now()
      let changed = false

      const next = prev.map(agent => {
        const meta = agentMetaRef.current.get(agent.id) ?? {
          spawnedAt: Date.now(),
          arrivedAtDeskAt: null,
          idleSince: null,
          onBreak: false,
          breakStartedAt: null,
        }
        agentMetaRef.current.set(agent.id, meta)

        const speed = WALK_SPEED * dt * FLOOR_SPEED

        if (ISO_MODE && agent.id === BOSS_ID) {
          const md = manualDirRef.current
          if (md.du || md.dv) {
            // steer with collisions: slide along walls and desks instead of stopping dead
            const w = pctToWorld(agent.position.x, agent.position.y)
            const step = 0.075 * dt
            let nu = w.u + md.du * step, nv = w.v + md.dv * step
            if (!walkable(nu, nv)) {
              if (md.du && walkable(nu, w.v)) nv = w.v
              else if (md.dv && walkable(w.u, nv)) nu = w.u
              else { nu = w.u; nv = w.v }
            }
            meta.manualWalk = false
            const pos = worldToPct(nu, nv)
            const sx = md.du + md.dv, sy = md.dv - md.du
            const facing = (sy >= 0 ? (sx >= 0 ? 'front-left' : 'front-right') : (sx >= 0 ? 'rear-right' : 'rear-left')) as Agent['spriteFacing']
            changed = true
            return { ...agent, position: pos, targetPosition: pos, pathQueue: [], state: 'walking-to-desk' as const, spriteFacing: facing }
          }
          if (manualStopRef.current) {
            manualStopRef.current = false
            meta.idleSince = nowMs
            changed = true
            return { ...agent, targetPosition: { ...agent.position }, pathQueue: [], state: 'idle' as const }
          }
        }

        // Walk toward the first waypoint in the queue, or directly to the
        // final targetPosition if the queue is empty.
        const queue = agent.pathQueue ?? []
        const immediateTarget = queue.length > 0 ? queue[0] : agent.targetPosition

        const { position, arrived } = stepToward(
          agent.position,
          immediateTarget,
          speed,
        )

        // Always update position (even if not arrived — this is the walking animation)
        const moved = position.x !== agent.position.x || position.y !== agent.position.y
        if (moved && agent.state !== 'working' && agent.state !== 'idle') {
          // Debug: log first few frames of movement
          if (Math.random() < 0.01) {
            const q = agent.pathQueue ?? []
            console.log(`[walk] ${agent.name} at (${agent.position.x.toFixed(1)},${agent.position.y.toFixed(1)}) → (${position.x.toFixed(1)},${position.y.toFixed(1)}) queue:${q.length} target:(${immediateTarget.x.toFixed(1)},${immediateTarget.y.toFixed(1)}) arrived:${arrived}`)
          }
        }
        let updated: Agent = moved
          ? (changed = true, { ...agent, position })
          : agent

        if (arrived) {
          // If there are more waypoints in the queue, pop the first one and
          // keep walking — don't trigger "arrived at final destination" yet.
          if (queue.length > 0) {
            const newQueue = queue.slice(1)
            updated = { ...agent, position, pathQueue: newQueue }
            changed = true
          } else {
            // Queue is empty — agent has reached (or is walking directly to)
            // their final targetPosition.
            const isAtDesk = (
              Math.abs(agent.targetPosition.x - agent.deskPosition.x) < ARRIVAL_THRESHOLD &&
              Math.abs(agent.targetPosition.y - agent.deskPosition.y) < ARRIVAL_THRESHOLD
            )
            const isAtDoor = (
              Math.abs(agent.targetPosition.x - DOOR_TARGET.x) < ARRIVAL_THRESHOLD &&
              Math.abs(agent.targetPosition.y - DOOR_TARGET.y) < ARRIVAL_THRESHOLD
            )

            if (agent.state === 'new-hire' || agent.state === 'walking-to-desk') {
              if (meta.meetingSpot && !isAtDesk) {
                // Sat down in the conference room — sit tight until the meeting ends
                meta.idleSince = nowMs
                updated = { ...agent, position, state: 'idle', statusText: agent.statusText }
                changed = true
              } else if (meta.manualWalk && !isAtDesk) {
                // Michael got where you clicked — he waits there
                meta.manualWalk = false
                meta.idleSince = nowMs
                updated = { ...agent, position, state: 'idle' }
                changed = true
              } else if (isAtDesk || agent.state === 'new-hire') {
                meta.manualWalk = false
                meta.arrivedAtDeskAt = nowMs
                meta.onBreak = false
                // Open filing cabinet if this agent's desk is the filing spot
                if (agent.assignedSpotId === 'spot-filing') {
                  setFurnitureStates(prev => ({ ...prev, 'filing-1': 'open' }))
                }
                updated = { ...agent, position, state: 'working', statusText: workMessage() }
                changed = true
              }
            } else if (agent.state === 'completed' && isAtDoor) {
              updated = { ...agent, position }
              changed = true
            } else if (agent.state === 'coffee-break') {
              if (!meta.onBreak) {
                meta.onBreak = true
                meta.breakStartedAt = nowMs
                // Toggle furniture state on arrival
                if (COFFEE_SPOT !== null && agent.id !== BOSS_ID) {
                  const atCoffee = Math.abs(position.x - COFFEE_SPOT.x) < 3 && Math.abs(position.y - COFFEE_SPOT.y) < 3
                  if (atCoffee) {
                    setFurnitureStates(prev => ({ ...prev, coffee: 'on' }))
                  }
                }
                const filingSpot = MAIN_ROOM.agentSpots.find(s => s.type === 'filing')
                const atFiling = filingSpot && Math.abs(position.x - filingSpot.x) < 3 && Math.abs(position.y - filingSpot.y) < 3
                if (atFiling) {
                  setFurnitureStates(prev => ({ ...prev, 'filing-1': 'open' }))
                }
                updated = { ...agent, position }
                changed = true
              } else {
                const waited = nowMs - (meta.breakStartedAt ?? nowMs)
                if (waited >= BREAK_DURATION) {
                  meta.onBreak = false
                  meta.breakStartedAt = null
                  meta.arrivedAtDeskAt = nowMs
                  // Toggle furniture state back on departure
                  setFurnitureStates(prev => ({ ...prev, coffee: 'off', 'filing-1': 'closed' }))
                  const newTarget = { ...agent.deskPosition }
                  updated = {
                    ...agent,
                    position,
                    state: 'walking-to-desk',
                    targetPosition: newTarget,
                    statusText: workMessage(),
                    pathQueue: computePath(position, newTarget),
                  }
                  changed = true
                }
              }
            } else {
              if (
                Math.abs(position.x - agent.position.x) > 0.01 ||
                Math.abs(position.y - agent.position.y) > 0.01
              ) {
                updated = { ...agent, position }
                changed = true
              }
            }
          }
        } else {
          // Still walking
          if (
            Math.abs(position.x - agent.position.x) > 0.001 ||
            Math.abs(position.y - agent.position.y) > 0.001
          ) {
            updated = { ...agent, position }
            changed = true
          }
        }

        // Random break trigger
        if (
          updated.state === 'working' &&
          meta.arrivedAtDeskAt !== null &&
          !meta.onBreak &&
          !meta.meetingSpot &&
          COFFEE_SPOT !== null
        ) {
          const deskTime = nowMs - meta.arrivedAtDeskAt
          if (deskTime >= BREAK_MIN_DESK_TIME) {
            const breakRoll = BREAK_CHANCE_PER_SEC * (dt / 60)
            if (Math.random() < breakRoll) {
              const useWater = Math.random() < 0.35 && WATER_SPOTS.length > 0
              const breakSpot = useWater
                ? WATER_SPOTS[Math.floor(Math.random() * WATER_SPOTS.length)]
                : COFFEE_SPOT

              meta.onBreak = false
              meta.arrivedAtDeskAt = null

              const cfg = AGENT_CONFIGS[updated.role] ?? AGENT_CONFIGS['default']
              const isBoss = updated.id === BOSS_ID
              const breakMsg = useWater ? waterMessage() : (isBoss ? 'grabbing a Red Bull' : coffeeMessage())
              const breakIcon = isBoss ? '🥫' : (useWater ? '💧' : '☕')
              addMsg(updated.name, updated.role, cfg.color, `${breakIcon} ${breakMsg}`)
              if (!sfx.isMuted()) sfx.playCoffee()

              const breakTarget = { x: breakSpot.x, y: breakSpot.y }
              updated = {
                ...updated,
                state: 'coffee-break',
                targetPosition: breakTarget,
                statusText: breakMsg,
                pathQueue: computePath(updated.position, breakTarget),
              }
              changed = true
            }
          }
        }

        return updated
      })

      // Prune completed agents at the door (never prune the boss)
      const pruned = next.filter(a => {
        if (a.id === BOSS_ID || a.id === CLAUDE_ID) return true
        if (a.state === 'completed') {
          const atDoor = (
            Math.abs(a.position.x - DOOR_TARGET.x) < ARRIVAL_THRESHOLD * 2 &&
            Math.abs(a.position.y - DOOR_TARGET.y) < ARRIVAL_THRESHOLD * 2
          )
          if (atDoor) {
            agentMetaRef.current.delete(a.id)
            return false
          }
        }
        return true
      })

      if (changed || pruned.length !== next.length) {
        // Why: only apply this frame if nobody else updated agents since we read them —
        // otherwise a queued update (meeting start/end, new hire, floater move) would be clobbered.
        // Skipping one frame is invisible; the next tick recomputes from fresh state.
        setAgents(current => (current === prev ? pruned : current))
      }

      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------------------
  // Random office events — fire every 60-120 seconds
  // ---------------------------------------------------------------------------

  useEffect(() => {
    // Percentage-based target positions for each event type (matching room layout)
    const EVENT_TARGETS: Record<string, { x: number; y: number }> = FLOOR_MODE ? FLOOR.eventTargets : {
      'fire-drill': { x: 67.5, y: 48.9 },
      'pizza':      { x: 67.5, y: 48.9 },
      'standup':    { x: 28.9, y: 66.0 },
      'birthday':   { x: 73.5, y: 56.7 },
      'printer-jam': { x: 83.8, y: 63 },
    }
    // Why: on the floor map a crowd shouldn't stack on one pixel
    const spread = (t: { x: number; y: number }) => FLOOR_MODE
      ? { x: t.x + (Math.random() - 0.5) * 6, y: t.y + (Math.random() - 0.5) * 5 }
      : { ...t }

    const bossCfg = AGENT_CONFIGS[BOSS_ROLE] ?? AGENT_CONFIGS['default']

    function fireEvent() {
      const event = pickEvent()

      // Post main slack announcement (system message)
      addMsg('system', 'default', '#8b8d91', event.slackAnnouncement, true)

      // Play associated sound
      if (event.sound && !sfx.isMuted()) {
        switch (event.sound) {
          case 'alarm':        sfx.playAlarm(); break
          case 'celebration':  sfx.playCelebration(); break
          case 'doorOpen':     sfx.playDoorOpen(); break
          case 'error':        sfx.playError(); break
          case 'powerDown':    sfx.playPowerDown(); break
          case 'notification': sfx.playNotification(); break
          case 'coffee':       sfx.playCoffee(); break
        }
      }

      // Manager message from boss
      if (event.managerMessage) {
        setTimeout(() => {
          addMsg(bossCfg.title, BOSS_ROLE, bossCfg.color, event.managerMessage!)
        }, 500)
      }

      // Staggered agent messages as reactions
      const messages = event.agentMessages ?? []
      const currentAgents = agentsRef.current
      // Build list of participating agents (include boss)
      const participants = currentAgents.filter(a => a.id === BOSS_ID || a.state === 'working' || a.state === 'coffee-break')

      // Pick ONE random agent message (not a wall of spam)
      if (messages.length > 0) {
        const text = messages[Math.floor(Math.random() * messages.length)]
        setTimeout(() => {
          const nonBoss = participants.filter(a => a.id !== BOSS_ID)
          if (nonBoss.length === 0) return
          const agent = nonBoss[Math.floor(Math.random() * nonBoss.length)]
          const cfg = AGENT_CONFIGS[agent.role] ?? AGENT_CONFIGS['default']
          addMsg(agent.name, agent.role, cfg.color, text)
        }, 1200)
      }

      // Handle event types
      if (event.type === 'all-move') {
        const target = EVENT_TARGETS[event.id] ?? (FLOOR_MODE ? FLOOR.entryPoint : { x: 67.5, y: 48.9 })
        if (FLOOR_MODE && meetingActiveRef.current) return // nobody leaves a meeting for pretzels. (they would.)

        // Move all agents (including boss) to target
        setAgents(prev => prev.map(a => {
          const t = spread(target)
          return {
            ...a,
            state: 'walking-to-desk' as const,
            targetPosition: t,
            statusText: event.name,
            pathQueue: computePath(a.position, t),
          }
        }))

        // After duration, send agents back to their desks
        setTimeout(() => {
          setAgents(prev => prev.map(a => ({
            ...a,
            state: 'walking-to-desk' as const,
            targetPosition: { ...a.deskPosition },
            statusText: 'back to work',
            pathQueue: computePath(a.position, a.deskPosition),
          })))
        }, event.duration)

      } else if (event.type === 'single-agent') {
        const target = EVENT_TARGETS[event.id] ?? (FLOOR_MODE ? FLOOR.eventTargets['printer-jam'] : { x: 83.8, y: 63 })
        if (FLOOR_MODE && meetingActiveRef.current) return
        // Pick a random non-boss working agent
        const workers = agentsRef.current.filter(a => a.id !== BOSS_ID && (a.state === 'working' || a.state === 'walking-to-desk'))
        if (workers.length > 0) {
          const chosen = workers[Math.floor(Math.random() * workers.length)]

          // Printer jam: break the printer when agent walks over
          if (event.id === 'printer-jam') {
            setFurnitureStates(prev => ({ ...prev, 'printer-1': 'broken' }))
          }

          setAgents(prev => prev.map(a => {
            if (a.id !== chosen.id) return a
            return {
              ...a,
              state: 'walking-to-desk' as const,
              targetPosition: { ...target },
              statusText: event.name,
              pathQueue: computePath(a.position, target),
            }
          }))
          // Return after duration, fix the printer
          setTimeout(() => {
            if (event.id === 'printer-jam') {
              setFurnitureStates(prev => ({ ...prev, 'printer-1': 'working' }))
            }
            setAgents(prev => prev.map(a => {
              if (a.id !== chosen.id) return a
              return {
                ...a,
                state: 'walking-to-desk' as const,
                targetPosition: { ...a.deskPosition },
                statusText: 'back to work',
                pathQueue: computePath(a.position, a.deskPosition),
              }
            }))
          }, event.duration)
        }

      } else if (event.type === 'visual-only') {
        // Power flicker: add CSS class for flicker animation
        setFlickering(true)
        setTimeout(() => setFlickering(false), event.duration)
      }
      // 'slack-only' events: messages already posted above — no movement
    }

    // Schedule first event after 60-120 seconds, then repeat
    function scheduleNext() {
      const delay = 60_000 + Math.random() * 60_000
      return setTimeout(() => {
        fireEvent()
        timerRef = scheduleNext()
      }, delay)
    }

    let timerRef = scheduleNext()
    return () => clearTimeout(timerRef)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addMsg])

  // ---------------------------------------------------------------------------
  // Ambient office sounds
  // ---------------------------------------------------------------------------

  useEffect(() => {
    // Start ambient hum (only if not muted)
    if (!sfx.isMuted()) {
      // Delay slightly to let AudioContext resume after first user interaction
      const startTimer = setTimeout(() => {
        sfx.playAmbientHum()
      }, 2000)
      return () => {
        clearTimeout(startTimer)
        sfx.stopAmbient()
      }
    }
    return () => sfx.stopAmbient()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keyboard clatter every 2-4 seconds when agents are working
  useEffect(() => {
    const interval = setInterval(() => {
      if (sfx.isMuted()) return
      const working = agentsRef.current.filter(a => a.state === 'working')
      if (working.length === 0) return
      sfx.playKeyboardClatter()
    }, 2000 + Math.random() * 2000)
    return () => clearInterval(interval)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Stop/start ambient when mute changes
  useEffect(() => {
    if (muted) {
      sfx.stopAmbient()
    } else {
      sfx.playAmbientHum()
    }
  }, [muted])

  // ---------------------------------------------------------------------------
  // Misc handlers
  // ---------------------------------------------------------------------------

  // Effective day phase (respects manual override)
  const effectivePhase: DayPhase = dayNightMode === 'auto' ? dayPhase
    : dayNightMode === 'day' ? 'morning' : 'night'
  const isNight = effectivePhase === 'night' || effectivePhase === 'dusk'

  const [volume, setVolume] = useState(sfx.getVolume())

  const handleToggleMute = useCallback(() => {
    const nowMuted = sfx.toggleMute()
    setMuted(nowMuted)
    setVolume(sfx.getVolume())
  }, [])

  const handleVolumeChange = useCallback((v: number) => {
    sfx.setVolume(v)
    setVolume(v)
    setMuted(v === 0)
  }, [])

  // Who is sitting (iso map): settled at a spot with a chair, couch or stool
  const seated = useMemo(() => {
    const out = new Set<string>()
    if (!ISO_MODE) return out
    for (const a of agents) {
      if (a.state === 'walking-to-desk' || a.state === 'new-hire' || a.state === 'completed' || a.state === 'coffee-break') continue
      if (seatAt(a.position.x, a.position.y, 0.3)) out.add(a.id)
    }
    return out
  }, [agents])

  // Where everyone is looking (iso map): Michael if he's in the room with you, otherwise
  // whoever you're talking with (if they're nearby), otherwise your screen / your spot's facing.
  const gaze = useMemo(() => {
    const out = new Map<string, Agent['spriteFacing']>()
    if (!ISO_MODE) return out
    void gazeTick
    const now = Date.now()
    const boss = agents.find(a => a.id === BOSS_ID)
    const bossRoom = boss ? roomAt(boss.position.x, boss.position.y) : null
    const byId = new Map(agents.map(a => [a.id, a]))
    for (const a of agents) {
      if (a.state === 'walking-to-desk' || a.state === 'new-hire' || a.state === 'completed') continue
      const room = roomAt(a.position.x, a.position.y)
      let target: Agent | undefined
      const partner = talkPartnerRef.current
      if (partner && boss && a.id === partner.id) target = boss                 // talking with Michael: face him
      else if (partner && a.id === BOSS_ID) target = byId.get(partner.id)        // …and he faces them
      else if (boss && a.id !== BOSS_ID && room && room === bossRoom) {
        // same room as Michael: people glance up now and then, then get back to their screens
        const g = glanceRef.current.get(a.id) ?? { until: 0, next: now + 800 + Math.random() * 4000 }
        if (now >= g.until && now >= g.next) {
          if (Math.random() < 0.3) { g.until = now + 2000 + Math.random() * 2500; g.next = g.until + 7000 + Math.random() * 12000 }
          else g.next = now + 4000 + Math.random() * 8000
        }
        glanceRef.current.set(a.id, g)
        if (now < g.until) target = boss
      } else glanceRef.current.delete(a.id)                                       // Michael left: eyes back on the screen
      if (!target) {
        const c = convoRef.current.get(a.id)
        const p = c && c.until > now ? byId.get(c.with) : undefined
        if (p && p.state !== 'completed') {
          const wa = pctToWorld(a.position.x, a.position.y), wp = pctToWorld(p.position.x, p.position.y)
          if (roomAt(p.position.x, p.position.y) === room || Math.hypot(wa.u - wp.u, wa.v - wp.v) < 10) target = p
        }
      }
      if (target) {
        const dx = target.position.x - a.position.x, dy = target.position.y - a.position.y
        if (Math.abs(dx) + Math.abs(dy) > 0.05) out.set(a.id, facingToward(dx, dy))
      }
    }
    return out
  }, [agents, gazeTick, talkPartner])

  // ---------------------------------------------------------------------------
  // Render — helper mode renders PlacementHelper in place of the full app
  // ---------------------------------------------------------------------------

  if (isHelperMode) {
    return (
      <Suspense fallback={<div style={{ color: '#666', padding: 20 }}>Loading helper...</div>}>
        <PlacementHelper />
      </Suspense>
    )
  }

  // Night art for the iso atlas (base layers cross-fade; sprites swap once it's dark)
  const isNightArt = dayNightMode === 'night' || (dayNightMode === 'auto' && nightOpacity > 0.5)

  const roomContent = (
        <>
          {/* Room backgrounds — both rendered, night crossfades via opacity. Theme swaps source art. */}
          <div
            key={`day-${theme}`}
            className="room-background"
            style={{ backgroundImage: `url(${FLOOR_MODE ? FLOOR.background.day : getRoomImage('day')})`,
              ...(FLOOR_MODE && FLOOR.pixelArt ? { imageRendering: 'pixelated' as const } : {}) }}
          />
          <div
            key={`night-${theme}`}
            className="room-background room-background-night"
            style={{
              backgroundImage: `url(${FLOOR_MODE ? FLOOR.background.night : getRoomImage('night')})`,
              ...(FLOOR_MODE && FLOOR.pixelArt ? { imageRendering: 'pixelated' as const } : {}),
              opacity: dayNightMode === 'auto' ? nightOpacity : dayNightMode === 'night' ? 1 : 0,
            }}
          />

          {/* Trading floor ticker tape — the desk's latest book scrolls across the top */}
          {theme === 'office' && !isHelperMode && !ISO_MODE && <TickerTape desk={deskState} />}

          {/* Scranton floor: every desk/chair/wall is its own sprite so people pass behind and in front of it */}
          {ISO_MODE && FLOOR.atlas && FLOOR.furniture.map((f, i) => {
            const at = FLOOR.atlas!
            const aw = f.aw ?? 1, ah = f.ah ?? 1
            return (
              <div key={i} className="iso-obj" style={{
                left: `${f.left}%`, top: `${f.top}%`, width: `${f.width}%`, height: `${f.height}%`, zIndex: f.z,
                backgroundImage: `url(${isNightArt ? at.night : at.day})`,
                backgroundSize: `${(at.width / aw) * 100}% ${(at.height / ah) * 100}%`,
                backgroundPosition: `${aw >= at.width ? 0 : ((f.ax ?? 0) / (at.width - aw)) * 100}% ${ah >= at.height ? 0 : ((f.ay ?? 0) / (at.height - ah)) * 100}%`,
              }} />
            )
          })}
          {FLOOR_MODE && !ISO_MODE && FLOOR.furniture.map((f, i) => (
            <img key={i} src={f.sprite} alt="" draggable={false} className="floor-sprite"
              style={{ left: `${f.left}%`, top: `${f.top}%`, width: `${f.width}%`, zIndex: f.z,
                filter: nightOpacity > 0.5 && dayNightMode !== 'day' ? 'brightness(0.8)' : undefined }} />
          ))}
          {FLOOR_MODE && (!ISO_MODE || roomW / FLOOR.size.width < 0.62) && FLOOR.labels.map(l => (
            <div key={l.id} className="floor-label" style={{ left: `${l.x}%`, top: `${l.y}%` }}>
              <span className="floor-label-name">{l.name}</span>
              {l.sub && zoom > 1 && <span className="floor-label-sub">{l.sub}</span>}
            </div>
          ))}

          {/* Furniture — apply interactive state overrides */}
          {!FLOOR_MODE && <FurnitureRenderer onItemClick={handleFurnitureClick} items={MAIN_ROOM.furniture.map(item => {
            const stateOverride = furnitureStates[item.id]
            if (!stateOverride) return item
            // Swap sprite based on state
            if (item.id === 'coffee' && stateOverride === 'on') {
              return { ...item, sprite: 'coffee-on' }
            }
            if (item.id === 'filing-1' && stateOverride === 'open') {
              return { ...item, sprite: 'filing-open' }
            }
            if (item.id === 'printer-1' && stateOverride === 'broken') {
              return { ...item, sprite: 'printer-broken' }
            }
            return item
          })} />}

          {/* Agents */}
          {agents.map(agent => {
            // Use spot zIndex override when agent is at their desk
            const spot = MAIN_ROOM.agentSpots.find(s => s.id === agent.assignedSpotId)
            const atDesk = Math.abs(agent.position.x - agent.deskPosition.x) < 1 &&
                           Math.abs(agent.position.y - agent.deskPosition.y) < 1
            // Floor map: avatars are always the top layer (sorted front-to-back among themselves)
            const zOverride = ISO_MODE
              ? (carrying && agent.id === BOSS_ID ? 9400 : 1000 + Math.round((agent.position.y + (FLOOR.iso?.personBias ?? 0)) * 50))
              : FLOOR_MODE
              ? 1000 + Math.round(agent.position.y * 10)
              : (atDesk && spot?.zIndex ? spot.zIndex : undefined)

            const meta = agentMetaRef.current.get(agent.id)
            const idleDurationMs =
              agent.state === 'idle' && meta?.idleSince
                ? Date.now() - meta.idleSince
                : 0

            return (
              <Character
                key={agent.id}
                agent={agent}
                idleDurationMs={idleDurationMs}
                zIndex={zOverride}
                isTyping={typingAgents.has(agent.id)}
                spriteHeight={FLOOR_MODE ? floorSpriteH : undefined}
                isoFacing={ISO_MODE}
                facingOverride={gaze.get(agent.id)}
                sitting={ISO_MODE && seated.has(agent.id)}
                pickable={ISO_MODE && agent.id === BOSS_ID}
                clickable={ISO_MODE && agent.id !== BOSS_ID && agent.state !== 'completed'}
                carried={ISO_MODE && agent.id === BOSS_ID && carrying}
              />
            )
          })}

          {/* Conversation bubbles — over everyone's heads, on the top layer */}
          {ISO_MODE && [...bubbles.entries()].map(([id, b]) => {
            const a = agents.find(x => x.id === id)
            if (!a || b.until < Date.now()) return null
            const roomH = roomRef.current?.clientHeight || 1
            const head = (floorSpriteH * (seated.has(id) ? 0.86 : 1.12)) / roomH * 100
            // Michael and whoever he's talking to: bubbles lean apart so they don't overlap
            const pair = talkPartner && (id === BOSS_ID || id === talkPartner.id)
              ? agents.find(x => x.id === (id === BOSS_ID ? talkPartner.id : BOSS_ID)) : undefined
            const side = pair ? (a.position.x <= pair.position.x ? ' side-left' : ' side-right') : ''
            return (
              <div key={`bub-${id}`} className={`talk-anchor${side}`}
                style={{ left: `${a.position.x}%`, top: `${a.position.y - head}%`, zIndex: 9200 }}>
                <div key={b.text} className={`talk-bubble${id === BOSS_ID ? ' michael' : ''}`}>{b.text}</div>
              </div>
            )
          })}

          {/* Nameplates — their own top layer so desks and walls never hide them */}
          {ISO_MODE && roomW / FLOOR.size.width >= 0.6 && agents.map(agent => {
            if (agent.state === 'completed' && !agentMetaRef.current.get(agent.id)) return null
            // packed meeting: only the person speaking keeps a nameplate, so the room stays readable
            if (meetingOn && agentMetaRef.current.get(agent.id)?.meetingSpot && !bubbles.has(agent.id)) return null
            const emp = EMPLOYEE_BY_ROLE[agent.role]
            const name = emp?.name ?? themedDisplayName(agent.role, agent.name)
            const showTitle = roomW / FLOOR.size.width >= 1.05 && emp?.title
            const lifted = carrying && agent.id === BOSS_ID
            return (
              <div key={`np-${agent.id}`} className={`char-nameplate${lifted ? ' lifted' : ''}${talkPartner?.id === agent.id ? ' talking' : ''}`}
                style={{ left: `${agent.position.x}%`, top: `${agent.position.y}%`, borderColor: agent.color, zIndex: 9100 }}>
                <span className="char-nameplate-name">{name}</span>
                {showTitle && <span className="char-nameplate-title">{emp!.title}</span>}
              </div>
            )
          })}

          {/* Angela's cat — follows whoever is cast as Angela in Office theme */}
          {(() => {
            const angela = getAngelaCat()
            if (!angela) return null
            const host = agents.find(a => a.role === angela.role)
            if (!host) return null
            return (
              <img
                src={angela.catSprite}
                alt="cat"
                className="angela-cat"
                style={{
                  position: 'absolute',
                  left: `${host.position.x + (ISO_MODE ? 0.9 : 2.2)}%`,
                  top: `${host.position.y}%`,
                  // Why: cats are 30-40% of ~78px character = ~24-30px tall
                  height: FLOOR_MODE ? Math.round(floorSpriteH * 0.34) : 28,
                  width: 'auto',
                  transform: 'translate(-50%, -10%)',
                  zIndex: ISO_MODE ? 1001 + Math.round((host.position.y + (FLOOR.iso?.personBias ?? 0)) * 50)
                    : FLOOR_MODE ? 1001 + Math.round(host.position.y * 10) : Math.round(host.position.y) + 1,
                  pointerEvents: 'none',
                  filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.4))',
                }}
                draggable={false}
              />
            )
          })()}

          {/* Boss interaction effect */}
          {bossEffect && (() => {
            const boss = agents.find(a => a.id === BOSS_ID)
            if (!boss) return null
            return (
              <div
                className="boss-interaction-effect"
                style={{
                  position: 'absolute',
                  left: `${boss.position.x}%`,
                  top: `${boss.position.y - (ISO_MODE ? 4 : 8)}%`,
                  transform: 'translate(-50%, -100%)',
                  zIndex: ISO_MODE ? 9600 : 999,
                  pointerEvents: 'none',
                }}
              >
                <img
                  src={bossEffect}
                  alt="interaction"
                  style={{ height: 32, width: 'auto', imageRendering: 'pixelated' }}
                />
              </div>
            )
          })()}

          {/* Day/night overlay */}
          <div className={`day-overlay ${effectivePhase}`} style={ISO_MODE ? { zIndex: 9500 } : FLOOR_MODE ? { zIndex: 2300 } : undefined} />
        </>
  )

  return (
    <div className="app-wrapper">
      <div className="title-bar">
        <div className="title-bar-dot" style={{ background: '#ff5f57' }} />
        <div className="title-bar-dot" style={{ background: '#febc2e' }} />
        <div className="title-bar-dot" style={{ background: '#28c840' }} />
        <span className="title-bar-text">{theme === 'office' ? `${FIRM.name.toUpperCase()} — TRADING FLOOR` : 'CLAUDE CODE — AGENT OFFICE'}</span>
        <button
          className="title-bar-daynight"
          onClick={() => setDayNightMode(prev =>
            prev === 'auto' ? 'day' : prev === 'day' ? 'night' : 'auto'
          )}
          title={`Mode: ${dayNightMode}`}
        >
          {dayNightMode === 'auto' ? 'AUTO' : dayNightMode === 'day' ? 'DAY' : 'NIGHT'}
        </button>
        {FLOOR_MODE && (
          <span className="title-ops">
            <button className={opsOpen && opsTab === 'inbox' ? 'on' : ''} onClick={() => (opsOpen && opsTab === 'inbox' ? setOpsOpen(false) : openOps('inbox'))} title="Email inbox">📧 Inbox{ops?.unread ? <b>{ops.unread}</b> : null}</button>
            <button className={opsOpen && opsTab === 'board' ? 'on' : ''} onClick={() => (opsOpen && opsTab === 'board' ? setOpsOpen(false) : openOps('board'))} title="Project board">📋 Board{ops && ops.tickets.some(t => t.needsMichael && t.status !== 'Done') ? <b className="warn">{ops.tickets.filter(t => t.needsMichael && t.status !== 'Done').length}</b> : null}</button>
            <button className={opsOpen && ['risk', 'books', 'alphas'].includes(opsTab) ? 'on' : ''} onClick={() => (opsOpen && ['risk', 'books', 'alphas'].includes(opsTab) ? setOpsOpen(false) : openOps('risk'))} title="Risk, books and alphas">📈 Desk{ops?.risk ? <i className={`dot ${ops.risk.regime.toLowerCase()}`} /> : null}</button>
          </span>
        )}
        {FLOOR_MODE && <OfficeClock offsetMs={clockOffset} />}
        <span className="title-bar-phase">{getPhaseLabel(effectivePhase)}</span>
      </div>

      <div className="app-body">
      <div className={`office-view${FLOOR_MODE ? ' floor-mode' : ''}${ISO_MODE ? ' iso-mode' : ''}${FLOOR_MODE && !ISO_MODE && zoom > 1 ? ' zoomed' : ''}`}>
        {/* Office phone — call any employee onto the floor */}
        {!isHelperMode && <StaffPhone meetingOn={meetingOn} />}
        {FLOOR_MODE && !ISO_MODE && (
          <div className="floor-zoom" role="group" aria-label="Zoom">
            <button onClick={() => setZoom(z => Math.max(1, z - 0.5))} disabled={zoom <= 1} title="Zoom out">−</button>
            <span>{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(z => Math.min(3, z + 0.5))} disabled={zoom >= 3} title="Zoom in">+</button>
          </div>
        )}
        {ISO_MODE && theme === 'office' && !isHelperMode && <TickerTape desk={deskState} />}
        {FLOOR_MODE && mailToasts.length > 0 && !opsOpen && (
          <div className="mail-toasts">
            {mailToasts.map(t => (
              <button key={t.id} className={`mail-toast${t.high ? ' high' : ''}`} onClick={() => { setMailToasts(p => p.filter(x => x.id !== t.id)); openOps('inbox', t.threadId) }}>
                <img src={avatarFor(t.from)} alt="" />
                <span><b>{t.fromName}</b><span>{t.subject}</span></span>
              </button>
            ))}
          </div>
        )}
        {ISO_MODE && talkPartner && (
          <DirectChat
            name={talkPartner.name}
            title={talkPartner.title}
            department={talkPartner.department}
            color={talkPartner.color}
            avatar={getSpritePath(`role-${talkPartner.role}`, talkPartner.role, ROLE_TO_CHAR[talkPartner.role] ?? 'employee-3', 'front-right')}
            messages={dms.get(talkPartner.role) ?? []}
            typing={dmTyping === talkPartner.role}
            onClose={endTalk}
            onSend={t => {
              const role = talkPartner.role
              addDm(role, { from: 'michael', text: t, at: Date.now() })
              sayBubble(BOSS_ID, t, 6000)
              fetch('http://127.0.0.1:3334/talk/say', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, text: t }),
              }).catch(() => {})
            }}
          />
        )}
        {ISO_MODE ? (
          <FloorCamera
            ref={cameraRef}
            mapW={FLOOR.size.width}
            mapH={FLOOR.size.height}
            worldRef={roomRef}
            worldClassName={`room-container${flickering ? ' flickering' : ''}`}
            minimap={FLOOR.minimap}
            labels={FLOOR.labels}
            getPeople={getPeople}
            onMove={onManualMove}
            onWalkTo={walkMichaelTo}
            onHome={sendMichaelHome}
            onPick={onPickMichael}
            onPersonClick={talkTo}
          >
            {roomContent}
          </FloorCamera>
        ) : (
        <div className="floor-scroll">
        <div
          ref={roomRef}
          className={`room-container${flickering ? ' flickering' : ''}`}
          style={{
            aspectRatio: FLOOR_MODE ? `${FLOOR.size.width}/${FLOOR.size.height}` : '4800/3584',
            width: FLOOR_MODE ? `${zoom * 100}%` : '100%',
            maxHeight: FLOOR_MODE && zoom > 1 ? 'none' : '100%',
            flex: 'none',
            position: 'relative',
          }}
        >
          {roomContent}
        </div>
        </div>
        )}
      </div>

      {opsOpen && (
        <OpsDesk state={ops} tab={opsTab} setTab={setOpsTab} onClose={() => setOpsOpen(false)} refresh={refreshOps} avatarFor={avatarFor} openEmail={opsEmail} setOpenEmail={setOpsEmail} />
      )}
      <SlackChat
        messages={messages}
        muted={muted}
        volume={volume}
        onToggleMute={handleToggleMute}
        onVolumeChange={handleVolumeChange}
        onSendMessage={(text) => {
          const bossCfg = AGENT_CONFIGS[BOSS_ROLE] ?? AGENT_CONFIGS['default']
          addMsg(bossCfg.title, BOSS_ROLE, bossCfg.color, text)
          setAutoTypeText(undefined)
          // #trading-floor is the group chat — one-on-ones happen in the floating box
          const to: string | undefined = undefined
          // Send to server so Claude can read it
          fetch('http://127.0.0.1:3334/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sender: bossCfg.title, text, boss: true, ...(to ? { to } : {}) }),
          }).catch(() => {})
        }}
        autoTypeText={autoTypeText}
        dayPhase={effectivePhase}
        typingUser={chatTypingUser}
        lastSeenId={lastSeenId}
        onReaction={(messageId, reactions) => {
          setMessages(prev => prev.map(m =>
            m.id === messageId ? { ...m, reactions } : m
          ))
        }}
      />
      </div>
    </div>
  )
}

export default App
