/**
 * market.js — NYSE hours on the office clock, and the opening / closing bell.
 *
 * Regular session 9:30–16:00 America/New_York, Monday–Friday, minus NYSE
 * holidays. Uses the office clock (real time + however far you've skipped
 * ahead), so "+2h" or "Skip to… next market open" rings the bell too.
 *
 * Opening bell → everyone is called onto the floor and goes to their desk.
 * Closing bell → an announcement (staff stay until you dismiss them).
 */

const HOLIDAYS = new Set([
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03',
  '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05',
  '2027-09-06', '2027-11-25', '2027-12-24',
])

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
})

/** New York wall clock for a moment */
export function nyParts(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]))
  const hour = Number(p.hour) % 24
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, hour, minute: Number(p.minute), mins: hour * 60 + Number(p.minute) }
}

export function isTradingDay(ms) {
  const p = nyParts(ms)
  return !['Sat', 'Sun'].includes(p.weekday) && !HOLIDAYS.has(p.date)
}

/** 'pre' (trading day, before 9:30) | 'open' | 'after' (trading day, after 16:00) | 'closed' (weekend/holiday) */
export function marketPhase(ms) {
  if (!isTradingDay(ms)) return 'closed'
  const m = nyParts(ms).mins
  if (m < 9 * 60 + 30) return 'pre'
  if (m < 16 * 60) return 'open'
  return 'after'
}

export const isMarketOpen = ms => marketPhase(ms) === 'open'

export function createMarketBell({ clock, staff, broadcast, addMessage }) {
  let last = clock.now()
  let lastPhase = marketPhase(last)

  function say(text, role = 'boss', name = 'Michael Scott') {
    const msg = addMessage({ sender: name, role, text })
    broadcast({ type: 'chat_message', ...msg })
  }

  function openingBell(late = false) {
    broadcast({ type: 'market_bell', phase: 'open', timestamp: Date.now() })
    say(late
      ? "🔔 Market's open, people! Desks. Now. Dwight, that includes the beet farm."
      : "🔔 OPENING BELL! Everybody at your desks — markets are open. Let's make some money. Legally. Toby's watching.")
    staff.callAll()                                  // everyone onto the floor…
    setTimeout(() => broadcast({ type: 'go_to_desks', timestamp: Date.now() }), 4000)   // …and to their desk
  }

  function closingBell() {
    broadcast({ type: 'market_bell', phase: 'close', timestamp: Date.now() })
    say('🔔 Closing bell! Markets are closed. Great day, everybody. Or a day. It was definitely a day.')
  }

  function tick() {
    const now = clock.now()
    const phase = marketPhase(now)
    if (phase !== lastPhase) {
      if (phase === 'open') openingBell()
      else if (lastPhase === 'open') closingBell()
    }
    last = now
    lastPhase = phase
  }

  const timer = setInterval(tick, 10_000)
  timer.unref?.()
  // Opened the office in the middle of a session? Everyone to their desks.
  setTimeout(() => { if (isMarketOpen(clock.now())) openingBell(true) }, 6000).unref?.()

  return {
    phase: () => marketPhase(clock.now()),
    tick,
    status() {
      const now = clock.now()
      const p = nyParts(now)
      return { phase: marketPhase(now), open: isMarketOpen(now), ny: `${p.weekday} ${p.date} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} ET` }
    },
  }
}
