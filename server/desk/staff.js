/**
 * staff.js — the office phone. Call any Dunder Mifflin Capital employee onto
 * the floor: they walk in, take a desk, greet you in character, and stay
 * "on call" (your untargeted chat messages go to them) until dismissed or
 * they wander off after a while.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { ROSTER, empByRole, loadDeskConfig } from './roster.js'
import { personaBlock } from './prompts.js'
import { claudeAvailable, runClaude } from './llm.js'

const STATE_DIR = join(homedir(), '.agent-office')
const ON_CALL_FILE = join(STATE_DIR, 'on-call.json')
const LATEST_FILE = join(STATE_DIR, 'desk-latest.json')
const AUTO_LEAVE_MS = 10 * 60 * 1000

/** role → { id, name, calledAt } — shared with desk.js so a desk run reuses whoever is already on the floor */
export const onCall = new Map()

/** Conference-room meeting state (shared with desk.js for the desk huddle) */
export const meeting = { active: false, reason: '', roles: null, timer: null }

const NOT_CALLABLE = new Set(['boss', 'assistant']) // Michael is you; Jim never leaves his desk

function persist() {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    const list = [...onCall.entries()].map(([role, v]) => ({ role, name: v.name, calledAt: v.calledAt }))
      .sort((a, b) => b.calledAt - a.calledAt)
    writeFileSync(ON_CALL_FILE, JSON.stringify(list, null, 2))
  } catch {}
}

function deskContext() {
  try {
    if (!existsSync(LATEST_FILE)) return 'No portfolio has been reviewed yet today.'
    const d = JSON.parse(readFileSync(LATEST_FILE, 'utf8'))
    return `Latest book on the desk: ${d.client}, $${Math.round(d.totalValue).toLocaleString()}, holdings ${d.positions.map(p => `${p.ticker} ${p.weight}%`).join(', ')}. ` +
      `${d.failingChecks?.length ? `Mandate breaches: ${d.failingChecks.join('; ')}.` : 'Book is inside the mandate.'}`
  } catch { return '' }
}

const pick = a => a[Math.floor(Math.random() * a.length)]

export function createStaff({ broadcast, addMessage, activeAgents }) {
  persist() // clear stale on-call state from a previous run

  function say(e, text) {
    const msg = addMessage({ sender: e.name, role: e.role, text: String(text).slice(0, 600) })
    broadcast({ type: 'chat_message', ...msg })
  }

  function directory() {
    return {
      departments: ROSTER.departments.map(d => ({
        ...d,
        staff: ROSTER.employees.filter(e => e.department === d.id && !NOT_CALLABLE.has(e.role)).map(e => ({
          role: e.role, slug: e.slug, name: e.name, title: e.title, emoji: e.emoji, color: e.color,
          onFloor: onCall.has(e.role),
        })),
      })).filter(d => d.staff.length),
      onCall: [...onCall.keys()],
      meeting: meeting.active,
    }
  }

  /** Everyone on the floor walks into the conference room (the UI seats them; Michael takes the front). */
  /** roles: only these roles (plus Michael) go to the conference room; null = everyone on the floor */
  function startMeeting(reason = 'All-hands meeting', { durationMs = 4 * 60 * 1000, roles = null } = {}) {
    clearTimeout(meeting.timer)
    meeting.active = true
    meeting.reason = reason
    meeting.roles = roles
    broadcast({ type: 'meeting_start', reason, roles, timestamp: Date.now() })
    if (durationMs) meeting.timer = setTimeout(() => endMeeting({ quiet: true }), durationMs)
    return { ok: true, meeting: true }
  }

  function endMeeting({ quiet = false } = {}) {
    clearTimeout(meeting.timer)
    if (!meeting.active) return { ok: true, meeting: false }
    meeting.active = false
    broadcast({ type: 'meeting_end', timestamp: Date.now() })
    if (!quiet) say(empByRole('boss'), pick(['Okay, meeting adjourned! Back to work, everybody.', 'And... scene. Great meeting. Best meeting ever.', 'That concludes this meeting. Toby, you can leave first.']))
    return { ok: true, meeting: false }
  }

  function walkOut(role, { quiet = false } = {}) {
    const entry = onCall.get(role)
    if (!entry) return false
    clearTimeout(entry.timer)
    onCall.delete(role)
    persist()
    const a = activeAgents.get(entry.id)
    if (a) { a.state = 'completed'; setTimeout(() => activeAgents.delete(entry.id), 40_000) }
    broadcast({ type: 'agent_completed', agentId: entry.id, result: '', desk: true, timestamp: Date.now() })
    if (!quiet) {
      const e = empByRole(role)
      say(e, pick([`Okay, heading back. Call me if you need me.`, `Back to my desk.`, `I'll be around.`, e.catchphrases?.[0] ?? 'Bye.']))
    }
    return true
  }

  async function greet(e) {
    const fallback = `You called? ${pick(e.catchphrases ?? ['Reporting for duty.'])}`
    const cfg = loadDeskConfig()
    if (cfg.llm !== 'claude' || !claudeAvailable()) return fallback
    const prompt = `${personaBlock(e)}

${deskContext()}

The Managing Partner (Michael Scott — the user) just buzzed you on the office phone and called you onto the trading floor. You walk over. Say hello in character and offer one concrete thing you can do for him right now from your job (mention the latest book if it's relevant). 1–2 sentences, under 40 words. Reply with only what you say out loud.`
    try {
      const out = await runClaude(prompt, { model: cfg.model, timeoutSec: 60 })
      return out.replace(/^["']|["']$/g, '').trim() || fallback
    } catch { return fallback }
  }

  /** Call someone onto the floor. Returns { ok, already?, error? } */
  async function call(role, { greetWithLLM = true, quiet = false, stay = false } = {}) {
    const e = empByRole(role)
    if (!e || NOT_CALLABLE.has(role)) return { ok: false, error: 'Nobody by that role works here.' }
    if (onCall.has(role)) {
      if (!quiet) say(e, pick(['I\'m right here.', 'Still here!', 'Yes? I\'m literally at the desk.']))
      return { ok: true, already: true }
    }
    const id = `staff-${role}-${Date.now()}`
    // stay: on the floor until dismissed (market hours) — otherwise wander off after a while
    const entry = { id, name: e.name, calledAt: Date.now(), timer: stay ? null : setTimeout(() => walkOut(role), AUTO_LEAVE_MS) }
    onCall.set(role, entry)
    persist()

    const record = { id, name: e.short, role, task: `${e.short}: on call`, state: 'new-hire', spawnedAt: Date.now(), desk: true }
    activeAgents.set(id, record)
    broadcast({ type: 'agent_spawned', agent: record, timestamp: Date.now() })

    const line = quiet ? null : greetWithLLM ? await greet(e) : `You called? ${pick(e.catchphrases ?? ['Reporting for duty.'])}`
    if (onCall.get(role)?.id !== id) return { ok: true } // dismissed while thinking
    record.state = 'working'
    broadcast({ type: 'agent_working', agentId: id, status: 'on call', desk: true, timestamp: Date.now() })
    if (line) say(e, line)
    return { ok: true }
  }

  const callableRoles = () => ROSTER.employees.filter(e => !NOT_CALLABLE.has(e.role)).map(e => e.role)

  /** 📢 Meeting: the whole branch into the conference room. */
  function allStaffMeeting() {
    const roles = callableRoles()
    say(empByRole('boss'), pick([
      'Everybody, conference room, NOW! All-staff meeting. That means you too, Toby. Unfortunately.',
      'Conference room, five minutes! Everyone! This is not a drill. Dwight, stop drilling.',
    ]))
    startMeeting('All-staff meeting')
    roles.forEach((role, i) => setTimeout(() => call(role, { quiet: true }), i * 300))
    return { ok: true, called: roles.length }
  }

  /** Everyone onto the floor (no meeting, no announcement) — e.g. the opening bell. */
  function callAll() {
    const roles = callableRoles().filter(r => !onCall.has(r))
    roles.forEach((role, i) => setTimeout(() => call(role, { quiet: true, stay: true }), i * 200))
    return { ok: true, called: roles.length }
  }

  /** Everyone into the conference room, no announcement (the caller does the talking). */
  function assembleAll(reason) {
    const roles = callableRoles()
    startMeeting(reason, { durationMs: 10 * 60 * 1000 })
    roles.forEach((role, i) => setTimeout(() => call(role, { quiet: true }), i * 250))
    return { ok: true, called: roles.length }
  }

  /** 🗂 Planning call: one department (segment) into the conference room. */
  function planningCall(deptId) {
    const dept = ROSTER.departments.find(d => d.id === deptId)
    if (!dept) return { ok: false, error: `No department "${deptId}"` }
    const team = ROSTER.employees.filter(e => e.department === deptId).map(e => e.role)
    const callable = team.filter(r => !NOT_CALLABLE.has(r))
    // Michael chairs every planning call; Jim is already on the floor (he joins if it's his department)
    const attendees = [...new Set([...team, 'boss'])]
    say(empByRole('boss'), `Planning call: ${dept.name}. Conference room, people! ${dept.mandate}`)
    startMeeting(`Planning — ${dept.name}`, { roles: attendees })
    callable.forEach((role, i) => setTimeout(() => call(role, { quiet: true }), i * 300))
    return { ok: true, dept: dept.name, called: callable }
  }

  /** All-hands: the portfolio desk team, canned greetings (fast + free). */
  async function allHands() {
    const team = ROSTER.employees.filter(e => e.pipeline && !e.conditional && !NOT_CALLABLE.has(e.role)).map(e => e.role)
    const michael = empByRole('boss')
    say(michael, 'Everybody, conference room, NOW! All-hands meeting!')
    startMeeting('All-hands meeting')
    for (const [i, role] of team.entries()) {
      setTimeout(() => call(role, { greetWithLLM: false }), i * 1500)
    }
    return { ok: true, called: team }
  }

  /** 🏠 Dismiss: everyone you called goes home (out through the elevators). */
  function dismissAll() {
    endMeeting({ quiet: true })
    const roles = [...onCall.keys()]
    roles.forEach((r, i) => setTimeout(() => walkOut(r, { quiet: true }), i * 250))
    if (roles.length) say(empByRole('boss'), pick([
      'Okay everybody, go home! Get some rest. Big day tomorrow. Every day is a big day.',
      'That\'s a wrap, people! Go home. Drive safe. Stanley, you can stop packing, you\'re already packed.',
    ]))
    return { ok: true, dismissed: roles }
  }

  /** 🪑 Go to desk: meeting (if any) is over, everyone back to their own desk.
   *  The browser seats people — desk-sharers without the desk go to a shared space. */
  function goToDesks() {
    endMeeting({ quiet: true })
    say(empByRole('boss'), pick([
      'Okay, everybody back to your desks! Chop chop. Productivity is... important.',
      'Desks, people! Back to your desks. Erin, you can sit wherever. Not my chair.',
      'Alright, back to work everybody. That is what she said. Wait, no. Back to work.',
    ]))
    broadcast({ type: 'go_to_desks', timestamp: Date.now() })
    return { ok: true }
  }

  return { directory, call, dismiss: (role) => ({ ok: walkOut(role) }), allHands, allStaffMeeting, planningCall, dismissAll, startMeeting, endMeeting, goToDesks, assembleAll, callAll }
}
