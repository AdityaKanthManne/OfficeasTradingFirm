import React, { useEffect, useRef, useState } from 'react'

/**
 * OfficeClock — the office's own date & time. It runs in real time and only
 * moves forward: +2h, or skip to any later date & time. Never back.
 * (The server keeps the clock, so reloading can't rewind it either.)
 */

const SERVER = 'http://127.0.0.1:3334'

const fmt = (d: Date) =>
  d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' +
  d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/** yyyy-MM-ddTHH:mm in local time, for <input type="datetime-local"> */
const toLocalInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

const OfficeClock: React.FC<{ offsetMs: number }> = ({ offsetMs }) => {
  const [now, setNow] = useState(() => new Date(Date.now() + offsetMs))
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setNow(new Date(Date.now() + offsetMs))
    const t = setInterval(() => setNow(new Date(Date.now() + offsetMs)), 1000)
    return () => clearInterval(t)
  }, [offsetMs])

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [open])

  const post = (body: object) => {
    setBusy(true); setErr(null)
    return fetch(`${SERVER}/clock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(r => r.json())
      .then(d => { if (!d.ok) setErr(d.error ?? 'Could not move the clock.'); else setOpen(false) })
      .catch(() => setErr('Office server is not running (port 3334).'))
      .finally(() => setBusy(false))
  }

  const openPicker = () => {
    const soon = new Date(now.getTime() + 60 * 60 * 1000)
    soon.setMinutes(0, 0, 0)
    setPick(toLocalInput(soon))
    setErr(null)
    setOpen(o => !o)
  }

  const skip = () => {
    const at = new Date(pick)
    if (isNaN(at.getTime())) { setErr('Pick a date and time.'); return }
    if (at.getTime() <= Date.now() + offsetMs) { setErr("Can't go back in time — pick something later."); return }
    post({ action: 'skip', at: at.toISOString() })
  }

  const presets: [string, () => Date][] = [
    ['Next 9 AM', () => { const d = new Date(now); d.setHours(9, 0, 0, 0); if (d <= now) d.setDate(d.getDate() + 1); return d }],
    ['Next market open (Mon–Fri 9:30)', () => {
      const d = new Date(now); d.setHours(9, 30, 0, 0)
      if (d <= now) d.setDate(d.getDate() + 1)
      while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
      return d
    }],
    ['Next 5 PM', () => { const d = new Date(now); d.setHours(17, 0, 0, 0); if (d <= now) d.setDate(d.getDate() + 1); return d }],
  ]

  return (
    <div className="office-clock" ref={boxRef}>
      <span className="office-clock-time" title={offsetMs > 0 ? `Office time is ${Math.round(offsetMs / 3600000)}h ahead of real time` : 'Office time = real time'}>
        🕘 {fmt(now)}
      </span>
      <button className="office-clock-btn" onClick={() => post({ action: 'advance', hours: 2 })} disabled={busy} title="Move the office clock forward 2 hours">+2h</button>
      <button className={`office-clock-btn${open ? ' active' : ''}`} onClick={openPicker} title="Skip ahead to a date & time">⏭ Skip to…</button>
      {open && (
        <div className="office-clock-pop" role="dialog" aria-label="Skip ahead">
          <div className="office-clock-pop-title">Skip ahead to…</div>
          <input
            type="datetime-local"
            value={pick}
            min={toLocalInput(new Date(now.getTime() + 60 * 1000))}
            onChange={e => setPick(e.target.value)}
          />
          <div className="office-clock-presets">
            {presets.map(([label, fn]) => (
              <button key={label} onClick={() => setPick(toLocalInput(fn()))}>{label}</button>
            ))}
          </div>
          <div className="office-clock-row">
            <span className="office-clock-hint">Time only moves forward.</span>
            <button className="office-clock-go" onClick={skip} disabled={busy}>Go</button>
          </div>
          {err && <div className="office-clock-err">{err}</div>}
        </div>
      )}
      {err && !open && <span className="office-clock-err inline">{err}</span>}
    </div>
  )
}

export default OfficeClock
