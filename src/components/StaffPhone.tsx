import React, { useCallback, useEffect, useRef, useState } from 'react'
import { getSpritePath, useTheme, setTheme, getTheme } from '../theme'
import { ROLE_TO_CHAR } from '../config'
import * as sfx from '../sounds'

/**
 * StaffPhone — the office call bar.
 *
 *   📞 Call Staff   directory: call any one person onto the floor
 *   📢 Meeting      the whole branch into the conference room
 *   🗂 Planning     one segment (department) into the conference room
 *   🪑 Go to desk   ends any meeting; everyone to their own desk, desk-sharers to a shared spot
 *   🏠 Dismiss      everyone you called goes home (out the elevators)
 *
 * Directory comes from GET /staff (firm/roster.json on the server).
 */

const SERVER = 'http://127.0.0.1:3334'

interface StaffMember { role: string; slug: string; name: string; title: string; emoji: string; color: string; onFloor: boolean }
interface Department { id: string; name: string; formerly: string; mandate: string; staff: StaffMember[] }

const DEPT_EMOJI: Record<string, string> = {
  trading: '📈', risk: '🐻', research: '📊', fundops: '🧮', compliance: '📎', reporting: '🎨',
  intel: '💅', alts: '🪙', commodities: '🛢️', ops: '📦', corporate: '🏛️', clients: '🧊',
}

const StaffPhone: React.FC<{ meetingOn?: boolean }> = ({ meetingOn = false }) => {
  const theme = useTheme()
  void theme // re-render avatars on theme toggle
  const [open, setOpen] = useState(false)          // directory panel
  const [planOpen, setPlanOpen] = useState(false)  // planning-call menu
  const [depts, setDepts] = useState<Department[]>([])
  const [calling, setCalling] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(() => {
    fetch(`${SERVER}/staff`)
      .then(r => r.json())
      .then(d => { setDepts(d.departments ?? []); setError(null) })
      .catch(() => setError('Office server is not running (port 3334).'))
  }, [])

  // Keep the "on the floor" badge fresh (people wander off after 10 min)
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, open || planOpen ? 3000 : 8000)
    return () => clearInterval(t)
  }, [open, planOpen, refresh])

  // Close menus on outside click / Escape
  useEffect(() => {
    if (!open && !planOpen) return
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) { setOpen(false); setPlanOpen(false) }
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setPlanOpen(false) } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open, planOpen])

  const post = (path: string, body: object) =>
    fetch(`${SERVER}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(r => r.json())
      .catch(() => { setError('Could not reach the office server.') })

  // Staff are the Office cast on the Scranton floor — switch theme first if needed (reload swaps the map)
  const ensureFloor = () => {
    if (getTheme() !== 'office') { setTheme('office'); setTimeout(() => window.location.reload(), 900) }
  }

  const callOne = (role: string) => {
    ensureFloor()
    sfx.playPhoneRing()
    setCalling(role)
    post('/staff/call', { role }).finally(() => { setCalling(null); refresh() })
  }
  const dismissOne = (role: string) => { post('/staff/dismiss', { role }).finally(refresh) }

  const action = (key: string, body: object, path = '/staff/meeting') => {
    ensureFloor()
    setBusy(key)
    if (key !== 'dismiss' && key !== 'desks') sfx.playPhoneRing()
    post(path, body).finally(() => { setBusy(null); refresh() })
  }
  const allStaffMeeting = () => { setOpen(false); setPlanOpen(false); action('meeting', { action: 'all-staff' }) }
  const planningCall = (deptId: string) => { setPlanOpen(false); action(`plan-${deptId}`, { action: 'planning', dept: deptId }) }
  const goToDesks = () => { setOpen(false); setPlanOpen(false); action('desks', {}, '/staff/desks') }
  const dismissAll = () => { setOpen(false); action('dismiss', { role: 'all' }, '/staff/dismiss') }

  const onFloor = depts.flatMap(d => d.staff).filter(s => s.onFloor)
  const q = filter.trim().toLowerCase()
  const shown = depts
    .map(d => ({ ...d, staff: d.staff.filter(s => !q || `${s.name} ${s.title} ${d.name}`.toLowerCase().includes(q)) }))
    .filter(d => d.staff.length)

  const avatar = (role: string) => getSpritePath(`role-${role}`, role, ROLE_TO_CHAR[role] ?? 'employee-3', 'front-right')

  return (
    <div className="staff-phone staff-bar" ref={barRef}>
      <button
        className={`staff-phone-btn${open ? ' active' : ''}`}
        onClick={() => { setOpen(o => !o); setPlanOpen(false) }}
        title="Call one person onto the floor"
      >
        <span className="staff-phone-icon">📞</span>
        <span>Call Staff</span>
        {onFloor.length > 0 && <span className="staff-phone-badge" title="On the floor">{onFloor.length}</span>}
      </button>

      <button className="staff-bar-btn" onClick={allStaffMeeting} disabled={busy === 'meeting'}
        title="Pull the whole branch into the conference room">
        📢 <span>{busy === 'meeting' ? 'Calling…' : 'Meeting'}</span>
      </button>

      <div className="staff-bar-group">
        <button className={`staff-bar-btn${planOpen ? ' active' : ''}`} onClick={() => { setPlanOpen(o => !o); setOpen(false) }}
          title="Pull one segment of the firm into the conference room" aria-haspopup="menu" aria-expanded={planOpen}>
          🗂 <span>Planning</span> <span className="staff-bar-caret">▾</span>
        </button>
        {planOpen && (
          <div className="staff-plan-menu" role="menu">
            <div className="staff-plan-title">Planning call — which segment?</div>
            {depts.map(d => (
              <button key={d.id} role="menuitem" className="staff-plan-item" onClick={() => planningCall(d.id)} disabled={busy === `plan-${d.id}`}>
                <span className="staff-plan-emoji">{DEPT_EMOJI[d.id] ?? '🏢'}</span>
                <span className="staff-plan-name">{d.name}<small>{d.staff.map(s => s.name.split(' ')[0]).join(', ')}</small></span>
                <span className="staff-plan-count">{d.staff.length}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <button className="staff-bar-btn" onClick={goToDesks} disabled={busy === 'desks'}
        title={meetingOn ? 'End the meeting — everyone back to their desks (desk-sharers find a shared spot)' : 'Everyone back to their desks (desk-sharers find a shared spot)'}>
        🪑 <span>Go to desk</span>
      </button>

      <button className="staff-bar-btn staff-bar-dismiss" onClick={dismissAll} disabled={onFloor.length === 0 || busy === 'dismiss'}
        title="Everyone you called goes home">
        🏠 <span>Dismiss</span>
      </button>

      {open && (
        <div className="staff-phone-panel" role="dialog" aria-label="Staff directory">
          <div className="staff-phone-head">
            <div>
              <div className="staff-phone-title">Dunder Mifflin Capital · Directory</div>
              <div className="staff-phone-sub">Call someone onto the floor. Your next chat message goes to them.</div>
            </div>
            <button className="staff-phone-close" onClick={() => setOpen(false)} aria-label="Close">×</button>
          </div>

          <div className="staff-phone-actions">
            <input
              className="staff-phone-search"
              placeholder="Search name, title or department…"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              autoFocus
            />
          </div>

          {error && <div className="staff-phone-error">{error}</div>}

          <div className="staff-phone-list">
            {shown.map(d => (
              <div key={d.id} className="staff-phone-dept">
                <div className="staff-phone-dept-name">{d.name} <span>was {d.formerly}</span></div>
                {d.staff.map(s => (
                  <div key={s.role} className={`staff-phone-row${s.onFloor ? ' on-floor' : ''}`}>
                    <img className="staff-phone-avatar" src={avatar(s.role)} alt="" style={{ borderColor: s.color }}
                      onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden' }} />
                    <div className="staff-phone-who">
                      <div className="staff-phone-name">{s.emoji} {s.name}</div>
                      <div className="staff-phone-role">{s.title}</div>
                    </div>
                    {s.onFloor ? (
                      <>
                        <span className="staff-phone-status">On the floor</span>
                        <button className="staff-phone-send" onClick={() => dismissOne(s.role)} title="Send home">Send home</button>
                      </>
                    ) : (
                      <button className="staff-phone-call" disabled={calling === s.role} onClick={() => callOne(s.role)}>
                        {calling === s.role ? 'Ringing…' : 'Call'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ))}
            {!shown.length && !error && <div className="staff-phone-empty">Nobody here by that name. Did you mean Dwight?</div>}
          </div>
        </div>
      )}
      {error && !open && <div className="staff-bar-error">{error}</div>}
    </div>
  )
}

export default StaffPhone
