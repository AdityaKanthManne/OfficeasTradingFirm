/**
 * clock.js — the office clock. It runs in real time, and you can only push it
 * forward (+2 hours, or skip to a later date & time) — never back.
 * The offset is kept in ~/.agent-office/clock.json so a restart or a page
 * reload can't roll it back either.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const DIR = join(homedir(), '.agent-office')
const FILE = join(DIR, 'clock.json')

function load() {
  try {
    if (existsSync(FILE)) {
      const d = JSON.parse(readFileSync(FILE, 'utf8'))
      // never earlier than the furthest point we've already reached
      const offset = Math.max(Number(d.offsetMs) || 0, (Number(d.highWater) || 0) - Date.now())
      return { offsetMs: Math.max(0, offset) }
    }
  } catch {}
  return { offsetMs: 0 }
}

export function createClock({ broadcast }) {
  const state = load()
  const now = () => Date.now() + state.offsetMs

  function save() {
    try {
      mkdirSync(DIR, { recursive: true })
      writeFileSync(FILE, JSON.stringify({ offsetMs: state.offsetMs, highWater: now() }, null, 2))
    } catch {}
  }

  function snapshot() {
    return { offsetMs: state.offsetMs, now: now() }
  }

  function announce(prevNow) {
    save()
    broadcast({ type: 'clock_update', ...snapshot(), jumpedMs: now() - prevNow, timestamp: Date.now() })
    return { ok: true, ...snapshot() }
  }

  /** move forward by ms (> 0) */
  function advance(ms) {
    ms = Number(ms)
    if (!Number.isFinite(ms) || ms <= 0) return { ok: false, error: 'The clock only goes forward.' }
    const prev = now()
    state.offsetMs += Math.min(ms, 365 * 24 * 3600 * 1000)
    return announce(prev)
  }

  /** jump to a later moment (ms since epoch or ISO string) */
  function skipTo(at) {
    const t = typeof at === 'number' ? at : Date.parse(String(at))
    if (!Number.isFinite(t)) return { ok: false, error: 'Not a date.' }
    const prev = now()
    if (t <= prev) return { ok: false, error: "Can't go back in time. (Michael tried. It didn't work.)", ...snapshot() }
    state.offsetMs += t - prev
    return announce(prev)
  }

  // keep the high-water mark fresh so a crash can't lose time either
  setInterval(save, 60_000).unref?.()
  save()
  return { now, snapshot, advance, skipTo }
}
