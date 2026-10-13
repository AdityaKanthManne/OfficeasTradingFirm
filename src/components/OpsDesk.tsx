import React, { useEffect, useMemo, useRef, useState } from 'react'
import { EMPLOYEES, EMPLOYEE_BY_SLUG } from '../firm'

/**
 * OpsDesk — the firm's work, in one window over the floor:
 *   Inbox  · emails from staff (work updates, questions, approvals) — reply, approve, compose
 *   Board  · project board, tickets P0–P3 moving Backlog → Done as staff work them
 *   Risk   · Dwight's latest market-indicator check and book risk
 *   Books  · each portfolio team's book, marked to market
 *   Alphas · Oscar & Karen's back-tested signals and today's ideas
 */

const API = 'http://127.0.0.1:3334'
const post = (path: string, body: unknown = {}) =>
  fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()).catch(() => null)

export type OpsTab = 'inbox' | 'board' | 'risk' | 'books' | 'alphas'

interface Action { id: string; label: string }
export interface OpsEmail {
  id: string; threadId: string; from: string; to: string[]; cc: string[]; subject: string; body: string; at: number; read: boolean
  kind: string; tags: string[]; needsReply: boolean; actions: Action[] | null; handled: string | null; ticketId: string | null
  links: { label: string; url: string }[]; fromName: string; toNames: string[]; ccNames: string[]; priority: string | null
}
interface Comment { by: string; text: string; at: number; system?: boolean }
interface Ticket {
  id: string; title: string; desc: string; status: string; priority: 'P0' | 'P1' | 'P2' | 'P3'; type: string; assignee: string; reporter: string
  created: number; updated: number; comments: Comment[]; needsMichael: boolean; book: string | null; emailId: string | null; points: number
  assigneeName: string; reporterName: string
}
interface RiskRow { t: string; name: string; last: number; dayChg: number; m1: number | null; vs200: number | null; vol20: number; status: string; note: string; source: string }
interface RiskBook { id: string; name: string; nav: number; varPct: number; var95: number; vol: number; beta: number | null; top: { ticker: string; weight: number } | null; drawdown: number; breaches: string[] }
interface Position { ticker: string; name: string; px: number; dayChg: number; value: number; weight: number; target: number; drift: number; dayPnl: number; upnl: number; source: string }
interface Book {
  id: string; name: string; short: string; pm: string; pmName: string; team: string[]; inception?: number; nav: number; dayPnl?: number; dayRet?: number; sinceInception?: number
  positions: Position[]; risk?: { varPct: number; var95: number; vol: number; beta: number | null; drawdown: number; breaches: string[] }; limits?: { single: number; var: number; drawdown: number }
  history?: { date: string; nav: number; pnl: number }[]; sources?: string[]
}
interface AlphaStat { id: string; name: string; owner: string; ic: number; icT: number; hit: number; n: number; verdict: 'use' | 'flip' | 'weak' }
interface Idea { ticker: string; name: string; score: number; why: string; m1: number | null }
export interface OpsState {
  now: number; phase: string; sprint: { name: string }
  emails: OpsEmail[]; unread: number; tickets: Ticket[]
  risk: { at: number; regime: string; score: number; sources: string[]; rows: RiskRow[]; books: RiskBook[] } | null
  alphas: { at: number; id: string; url: string; stats: AlphaStat[]; longs: Idea[]; avoid: Idea[]; sources: string[]; universe: number } | null
  books: Book[]; trades: { id: string; book: string; side: string; ticker: string; shares: number; px: number; notional: number; date: string; settled: string | null }[]
  columns: string[]
}

// ---------------------------------------------------------------- helpers
const pct = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%`)
const usd = (x: number | null | undefined) => {
  if (x == null || !Number.isFinite(x)) return '—'
  const s = x < 0 ? '-' : '', a = Math.abs(x)
  return a >= 1e9 ? `${s}$${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${s}$${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${s}$${(a / 1e3).toFixed(1)}K` : `${s}$${a.toFixed(0)}`
}
const px = (x: number) => (x >= 1000 ? x.toLocaleString(undefined, { maximumFractionDigits: 0 }) : x.toFixed(2))
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
const shortWhen = (ms: number, now: number) => {
  const d = new Date(ms), n = new Date(now)
  return d.toDateString() === n.toDateString() ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
const nameOf = (slug: string) => (slug === 'michael' ? 'Michael Scott' : EMPLOYEE_BY_SLUG[slug]?.name ?? slug)
const colorOf = (slug: string) => (slug === 'michael' ? '#4a90d9' : EMPLOYEE_BY_SLUG[slug]?.color ?? '#8b949e')
const tone = (x: number | null | undefined) => (x == null ? '' : x > 0 ? 'up' : x < 0 ? 'down' : '')
const simLabel = (sources?: string[]) => (sources?.includes('sim') ? (sources.some(s => s.startsWith('live')) ? 'partly simulated' : 'SIMULATED prices') : sources?.includes('live+sim') ? 'live + projected' : 'live')

const PRIO_LABEL: Record<string, string> = { P0: 'P0 · Critical', P1: 'P1 · High', P2: 'P2 · Medium', P3: 'P3 · Low' }

/** small markdown subset: paragraphs, **bold**, _italic_, tables, lists, quotes */
function inline(s: string, key = 0): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|(?:^|(?<=\s))_[^_]+_(?=\s|$|[.,;:!?])|`[^`]+`)/g
  let last = 0, m: RegExpExecArray | null, i = 0
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const t = m[0]
    if (t.startsWith('**')) out.push(<strong key={`${key}-${i++}`}>{t.slice(2, -2)}</strong>)
    else if (t.startsWith('`')) out.push(<code key={`${key}-${i++}`}>{t.slice(1, -1)}</code>)
    else out.push(<em key={`${key}-${i++}`}>{t.slice(1, -1)}</em>)
    last = m.index + t.length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}
function Md({ text }: { text: string }) {
  const lines = text.split('\n')
  const blocks: React.ReactNode[] = []
  let i = 0, k = 0
  while (i < lines.length) {
    const l = lines[i]
    if (!l.trim()) { i++; continue }
    if (l.trim().startsWith('|')) {
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
        if (!cells.every(c => /^-+$/.test(c))) rows.push(cells)
        i++
      }
      const [head, ...body] = rows
      blocks.push(<div className="ops-table-wrap" key={k++}><table className="ops-table"><thead><tr>{head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead>
        <tbody>{body.map((r, a) => <tr key={a}>{r.map((c, j) => <td key={j} className={/^[+-]\$?[\d.]+[%KMB]?$|^-?\$/.test(c) ? (c.startsWith('-') ? 'down' : c.startsWith('+') ? 'up' : '') : ''}>{inline(c, j)}</td>)}</tr>)}</tbody></table></div>)
      continue
    }
    if (/^\s*[-•] /.test(l) || /^\s*\d+\. /.test(l)) {
      const ordered = /^\s*\d+\. /.test(l)
      const items: string[] = []
      while (i < lines.length && (ordered ? /^\s*\d+\. /.test(lines[i]) : /^\s*[-•] /.test(lines[i]))) { items.push(lines[i].replace(/^\s*(?:[-•]|\d+\.) /, '')); i++ }
      const L = ordered ? 'ol' : 'ul'
      blocks.push(<L key={k++}>{items.map((t, j) => <li key={j}>{inline(t, j)}</li>)}</L>)
      continue
    }
    if (l.startsWith('>')) {
      const q: string[] = []
      while (i < lines.length && lines[i].startsWith('>')) { q.push(lines[i].replace(/^>\s?/, '')); i++ }
      blocks.push(<blockquote key={k++}>{q.map((t, j) => <div key={j}>{inline(t, j)}</div>)}</blockquote>)
      continue
    }
    const p: string[] = []
    while (i < lines.length && lines[i].trim() && !lines[i].trim().startsWith('|') && !/^\s*[-•] /.test(lines[i]) && !/^\s*\d+\. /.test(lines[i]) && !lines[i].startsWith('>')) { p.push(lines[i]); i++ }
    blocks.push(<p key={k++}>{p.map((t, j) => <React.Fragment key={j}>{j > 0 && <br />}{inline(t, j)}</React.Fragment>)}</p>)
  }
  return <div className="ops-md">{blocks}</div>
}

function Avatar({ slug, size = 26, avatarFor }: { slug: string; size?: number; avatarFor: (slug: string) => string }) {
  const [broken, setBroken] = useState(false)
  const n = nameOf(slug)
  return (
    <span className="ops-av" style={{ width: size, height: size, borderColor: colorOf(slug) }} title={n}>
      {broken ? <span className="ops-av-txt" style={{ background: colorOf(slug) }}>{n.split(' ').map(x => x[0]).join('').slice(0, 2)}</span>
        : <img src={avatarFor(slug)} alt="" draggable={false} onError={() => setBroken(true)} />}
    </span>
  )
}

// ---------------------------------------------------------------- inbox
function Inbox({ s, avatarFor, openId, setOpenId, refresh }: { s: OpsState; avatarFor: (slug: string) => string; openId: string | null; setOpenId: (id: string | null) => void; refresh: () => void }) {
  const [folder, setFolder] = useState<'inbox' | 'action' | 'sent' | 'cc'>('inbox')
  const [tag, setTag] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [compose, setCompose] = useState(false)
  const threads = useMemo(() => {
    const by = new Map<string, OpsEmail[]>()
    for (const e of s.emails) { const a = by.get(e.threadId) ?? []; a.push(e); by.set(e.threadId, a) }
    return [...by.values()].map(msgs => {
      msgs.sort((a, b) => a.at - b.at)
      const last = msgs[msgs.length - 1], root = msgs[0]
      const fromStaff = msgs.filter(m => m.from !== 'michael')
      return {
        id: root.threadId, root, last, msgs, unread: msgs.some(m => !m.read),
        needs: msgs.some(m => (m.actions && !m.handled) || (m.needsReply && !m.handled && !msgs.some(x => x.from === 'michael' && x.at > m.at))),
        mine: root.from === 'michael', ccOnly: fromStaff.length > 0 && fromStaff.every(m => !m.to.includes('michael')),
        tags: [...new Set(msgs.flatMap(m => m.tags))], high: msgs.some(m => m.priority === 'high' && !m.handled),
        who: last.from === 'michael' ? (fromStaff[fromStaff.length - 1]?.from ?? root.to[0]) : last.from,
      }
    }).sort((a, b) => b.last.at - a.last.at)
  }, [s.emails])
  const tags = useMemo(() => [...new Set(threads.flatMap(t => t.tags))].sort(), [threads])
  const shown = threads.filter(t =>
    (folder === 'inbox' ? !t.mine || t.msgs.length > 1 : folder === 'action' ? t.needs : folder === 'sent' ? t.msgs.some(m => m.from === 'michael') : t.ccOnly) &&
    (!tag || t.tags.includes(tag)) &&
    (!q || `${t.root.subject} ${t.msgs.map(m => `${m.fromName} ${m.body}`).join(' ')}`.toLowerCase().includes(q.toLowerCase())))
  const open = threads.find(t => t.id === openId) ?? null
  useEffect(() => {
    if (!open) return
    const unread = open.msgs.filter(m => !m.read)
    for (const m of unread) post(`/ops/email/${m.id}/read`)
    if (unread.length) setTimeout(refresh, 150)
  }, [open?.id, open?.msgs.length])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="ops-inbox">
      <div className="ops-folders">
        <button className="ops-compose" onClick={() => setCompose(true)}>✏️ Compose</button>
        {([['inbox', '📥 Inbox', threads.filter(t => (!t.mine || t.msgs.length > 1) && t.unread).length], ['action', '⚡ Needs you', threads.filter(t => t.needs).length], ['cc', '👥 Team (cc)', 0], ['sent', '📤 Sent', 0]] as const).map(([id, label, n]) => (
          <button key={id} className={`ops-folder${folder === id ? ' on' : ''}`} onClick={() => setFolder(id)}>{label}{n ? <b>{n}</b> : null}</button>
        ))}
        <div className="ops-folder-h">Labels</div>
        {tags.map(t => <button key={t} className={`ops-folder small${tag === t ? ' on' : ''}`} onClick={() => setTag(tag === t ? null : t)}># {t}</button>)}
        {s.unread > 0 && <button className="ops-folder small" onClick={() => post('/ops/email/read-all').then(refresh)}>✓ Mark all read</button>}
      </div>
      <div className="ops-list">
        <input className="ops-search" placeholder="Search mail" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.stopPropagation()} />
        {shown.length === 0 && <div className="ops-empty">Nothing here.</div>}
        {shown.map(t => (
          <button key={t.id} className={`ops-row${t.unread ? ' unread' : ''}${openId === t.id ? ' on' : ''}`} onClick={() => setOpenId(t.id)}>
            <Avatar slug={t.who} size={28} avatarFor={avatarFor} />
            <span className="ops-row-main">
              <span className="ops-row-top"><span className="ops-row-from">{nameOf(t.who)}{t.msgs.length > 1 ? <i> ({t.msgs.length})</i> : null}</span><span className="ops-row-time">{shortWhen(t.last.at, s.now)}</span></span>
              <span className="ops-row-subj">{t.high && <span className="ops-flag">!</span>}{t.root.subject}</span>
              <span className="ops-row-snip">{t.last.body.replace(/[*_|>#]+|(^|\s)-{1,3}(?=\s)/g, ' ').replace(/\s+/g, ' ').slice(0, 90)}</span>
              <span className="ops-row-tags">{t.needs && <span className="ops-chip need">Needs you</span>}{t.ccOnly && <span className="ops-chip">cc</span>}{t.tags.slice(0, 2).map(x => <span key={x} className="ops-chip">{x}</span>)}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="ops-read">
        {open ? <Thread t={open} s={s} avatarFor={avatarFor} refresh={refresh} /> : <div className="ops-empty big">Select an email to read it.<br /><span>Staff email you work updates and questions all day. Reply, approve, or ignore at your own risk.</span></div>}
      </div>
      {compose && <Compose onClose={() => setCompose(false)} onSent={() => { setCompose(false); setFolder('sent'); setTimeout(refresh, 200) }} />}
    </div>
  )
}

function Thread({ t, s, avatarFor, refresh }: { t: { root: OpsEmail; msgs: OpsEmail[] }; s: OpsState; avatarFor: (slug: string) => string; refresh: () => void }) {
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const lastRef = useRef<HTMLDivElement>(null)
  useEffect(() => { lastRef.current?.scrollIntoView({ block: 'start' }) }, [t.msgs.length, t.root.id])
  const ticket = t.root.ticketId ? s.tickets.find(x => x.id === t.root.ticketId) : null
  const last = t.msgs[t.msgs.length - 1]
  const target = last.from === 'michael' ? last.to[0] : last.from
  const replyTo = [...t.msgs].reverse().find(m => m.from !== 'michael') ?? last
  const send = async () => {
    if (!reply.trim()) return
    setSending(true)
    await post(`/ops/email/${replyTo.id}/reply`, { text: reply.trim() })
    setReply(''); setSending(false); refresh()
  }
  return (
    <div className="ops-thread">
      <div className="ops-thread-h">
        <div className="ops-thread-subj">{t.root.subject}</div>
        <div className="ops-thread-meta">{t.root.tags.map(x => <span key={x} className="ops-chip">{x}</span>)}{ticket && <span className={`ops-chip prio ${ticket.priority}`}>{ticket.id} · {ticket.status}</span>}</div>
      </div>
      <div className="ops-msgs">
        {t.msgs.map((m, i) => (
          <div key={m.id} ref={i === t.msgs.length - 1 ? lastRef : undefined} className={`ops-msg${m.from === 'michael' ? ' mine' : ''}`}>
            <div className="ops-msg-h">
              <Avatar slug={m.from} size={30} avatarFor={avatarFor} />
              <div className="ops-msg-who">
                <div><b>{m.fromName}</b> <span className="ops-msg-title">{m.from !== 'michael' ? EMPLOYEE_BY_SLUG[m.from]?.title : 'Managing Partner'}</span></div>
                <div className="ops-msg-to">to {m.toNames.join(', ')}{m.ccNames.length ? ` · cc ${m.ccNames.join(', ')}` : ''}</div>
              </div>
              <div className="ops-msg-time">{when(m.at)}</div>
            </div>
            <Md text={m.body} />
            {m.links.length > 0 && <div className="ops-links">{m.links.map(l => <a key={l.url} href={l.url} target="_blank" rel="noreferrer">📎 {l.label}</a>)}</div>}
            {m.actions && (
              <div className="ops-actions">
                {m.handled ? <span className="ops-handled">✓ {m.actions.find(a => a.id === m.handled)?.label ?? m.handled}</span>
                  : m.actions.map((a, i) => <button key={a.id} className={i === 0 ? 'primary' : ''} onClick={() => post(`/ops/email/${m.id}/action`, { action: a.id }).then(() => setTimeout(refresh, 200))}>{a.label}</button>)}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="ops-reply">
        <textarea placeholder={`Reply to ${nameOf(target).split(' ')[0]}…${t.root.kind === 'orders' ? ' e.g. "buy $2M NVDA in the Flagship"' : ''}`} value={reply} onChange={e => setReply(e.target.value)}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() }} />
        <button onClick={send} disabled={!reply.trim() || sending}>{sending ? 'Sending…' : 'Send'}</button>
      </div>
    </div>
  )
}

function Compose({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const staff = EMPLOYEES.filter(e => e.role !== 'boss')
  const [to, setTo] = useState('dwight-schrute')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const e = EMPLOYEE_BY_SLUG[to]
  return (
    <div className="ops-modal" onClick={onClose}>
      <div className="ops-modal-box" onClick={ev => ev.stopPropagation()} onKeyDown={ev => ev.stopPropagation()}>
        <div className="ops-modal-h">New email <button onClick={onClose}>×</button></div>
        <label>To <select value={to} onChange={ev => setTo(ev.target.value)}>{staff.map(x => <option key={x.slug} value={x.slug}>{x.name} — {x.title}</option>)}</select></label>
        {e && <div className="ops-hint">{e.deskDuty ?? e.title}</div>}
        <label>Subject <input value={subject} onChange={ev => setSubject(ev.target.value)} placeholder="What's this about?" /></label>
        <textarea value={body} onChange={ev => setBody(ev.target.value)} placeholder={`Ask ${e?.name.split(' ')[0] ?? ''} for an update, a number, a favour…`} rows={7} />
        <div className="ops-modal-f"><button onClick={onClose}>Cancel</button><button className="primary" disabled={!body.trim()} onClick={() => post('/ops/email', { to, subject, body }).then(onSent)}>Send</button></div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- board
function Board({ s, avatarFor, refresh }: { s: OpsState; avatarFor: (slug: string) => string; refresh: () => void }) {
  const [who, setWho] = useState('')
  const [mineOnly, setMineOnly] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [newT, setNewT] = useState(false)
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const order: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 }
  const list = s.tickets.filter(t => (!who || t.assignee === who) && (!mineOnly || t.needsMichael))
  const people = [...new Set(s.tickets.map(t => t.assignee))].sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
  const move = (id: string, status: string) => post(`/ops/ticket/${id}`, { status }).then(() => setTimeout(refresh, 150))
  const open = s.tickets.find(t => t.id === openId) ?? null
  const counts = s.columns.map(c => s.tickets.filter(t => t.status === c).length)
  const pts = s.tickets.filter(t => t.status === 'Done').reduce((a, t) => a + (t.points ?? 0), 0), ptsAll = s.tickets.reduce((a, t) => a + (t.points ?? 0), 0)
  return (
    <div className="ops-board-wrap">
      <div className="ops-board-bar">
        <b>{s.sprint.name}</b>
        <span className="ops-sprint"><span style={{ width: `${ptsAll ? (pts / ptsAll) * 100 : 0}%` }} /></span>
        <span className="ops-muted">{pts}/{ptsAll} pts done</span>
        <select value={who} onChange={e => setWho(e.target.value)}><option value="">Everyone</option>{people.map(p => <option key={p} value={p}>{nameOf(p)}</option>)}</select>
        <label className="ops-check"><input type="checkbox" checked={mineOnly} onChange={e => setMineOnly(e.target.checked)} /> Needs me ({s.tickets.filter(t => t.needsMichael && t.status !== 'Done').length})</label>
        <button className="primary" onClick={() => setNewT(true)}>+ New ticket</button>
      </div>
      <div className="ops-board">
        {s.columns.map((c, ci) => (
          <div key={c} className={`ops-col${over === c ? ' over' : ''}`} onDragOver={e => { e.preventDefault(); setOver(c) }} onDragLeave={() => setOver(o => (o === c ? null : o))}
            onDrop={e => { e.preventDefault(); setOver(null); const id = drag ?? e.dataTransfer.getData('text/plain'); if (id) move(id, c); setDrag(null) }}>
            <div className="ops-col-h">{c} <span>{counts[ci]}</span></div>
            <div className="ops-col-body">
              {list.filter(t => t.status === c).sort((a, b) => order[a.priority] - order[b.priority] || b.updated - a.updated).map(t => (
                <div key={t.id} className={`ops-card${t.needsMichael && t.status !== 'Done' ? ' needs' : ''}`} draggable onDragStart={e => { setDrag(t.id); e.dataTransfer.setData('text/plain', t.id) }} onDragEnd={() => setDrag(null)} onClick={() => setOpenId(t.id)}>
                  <div className="ops-card-top"><span className={`ops-prio ${t.priority}`}>{t.priority}</span><span className="ops-card-id">{t.id}</span><span className="ops-card-type">{t.type}</span></div>
                  <div className="ops-card-title">{t.title}</div>
                  <div className="ops-card-foot">
                    <Avatar slug={t.assignee} size={20} avatarFor={avatarFor} />
                    <span className="ops-muted">{t.assigneeName.split(' ')[0]}</span>
                    {t.needsMichael && t.status !== 'Done' && <span className="ops-chip need">You</span>}
                    {t.comments.filter(x => !x.system).length > 0 && <span className="ops-muted">💬 {t.comments.filter(x => !x.system).length}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {open && <TicketDrawer t={open} s={s} avatarFor={avatarFor} onClose={() => setOpenId(null)} refresh={refresh} />}
      {newT && <NewTicket onClose={() => setNewT(false)} onDone={() => { setNewT(false); setTimeout(refresh, 150) }} />}
    </div>
  )
}

function TicketDrawer({ t, s, avatarFor, onClose, refresh }: { t: Ticket; s: OpsState; avatarFor: (slug: string) => string; onClose: () => void; refresh: () => void }) {
  const [c, setC] = useState('')
  const upd = (b: Record<string, string>) => post(`/ops/ticket/${t.id}`, b).then(() => setTimeout(refresh, 150))
  return (
    <div className="ops-drawer" onKeyDown={e => e.stopPropagation()}>
      <div className="ops-drawer-h"><span className={`ops-prio ${t.priority}`}>{t.priority}</span> <b>{t.id}</b> <span className="ops-card-type">{t.type}</span><button onClick={onClose}>×</button></div>
      <div className="ops-drawer-title">{t.title}</div>
      {t.needsMichael && t.status !== 'Done' && <div className="ops-need-banner">Waiting on you. Drag it to Done (or approve the email) to sign off.</div>}
      <div className="ops-fields">
        <label>Status<select value={t.status} onChange={e => upd({ status: e.target.value })}>{s.columns.map(x => <option key={x}>{x}</option>)}</select></label>
        <label>Priority<select value={t.priority} onChange={e => upd({ priority: e.target.value })}>{['P0', 'P1', 'P2', 'P3'].map(x => <option key={x} value={x}>{PRIO_LABEL[x]}</option>)}</select></label>
        <label>Assignee<select value={t.assignee} onChange={e => upd({ assignee: e.target.value })}>{EMPLOYEES.filter(e => e.role !== 'boss').map(e => <option key={e.slug} value={e.slug}>{e.name}</option>)}</select></label>
      </div>
      <div className="ops-muted small">Reported by {t.reporterName} · opened {when(t.created)} · {t.points} pts</div>
      {t.desc && <div className="ops-desc">{t.desc}</div>}
      <div className="ops-comments">
        {t.comments.map((x, i) => x.system
          ? <div key={i} className="ops-sys">{nameOf(x.by).split(' ')[0]} {x.text} · {when(x.at)}</div>
          : <div key={i} className="ops-comment"><Avatar slug={x.by} size={22} avatarFor={avatarFor} /><div><div><b>{nameOf(x.by)}</b> <span className="ops-muted">{when(x.at)}</span></div><div>{x.text}</div></div></div>)}
      </div>
      <div className="ops-reply small">
        <textarea placeholder="Add a comment…" value={c} onChange={e => setC(e.target.value)} />
        <button disabled={!c.trim()} onClick={() => { upd({ comment: c.trim() }); setC('') }}>Comment</button>
      </div>
    </div>
  )
}

function NewTicket({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ title: '', desc: '', priority: 'P2', type: 'Trading', assignee: 'jim-halpert', status: 'To Do' })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value })
  return (
    <div className="ops-modal" onClick={onClose}>
      <div className="ops-modal-box" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
        <div className="ops-modal-h">New ticket <button onClick={onClose}>×</button></div>
        <label>Title <input value={f.title} onChange={set('title')} placeholder="e.g. Stress test the Flagship for a 20% drawdown" autoFocus /></label>
        <div className="ops-fields">
          <label>Priority<select value={f.priority} onChange={set('priority')}>{['P0', 'P1', 'P2', 'P3'].map(x => <option key={x} value={x}>{PRIO_LABEL[x]}</option>)}</select></label>
          <label>Type<select value={f.type} onChange={set('type')}>{['Trading', 'Risk', 'Research', 'Portfolio', 'Ops', 'Compliance', 'Finance', 'Tech', 'Client', 'Digital', 'Intel', 'Culture'].map(x => <option key={x}>{x}</option>)}</select></label>
          <label>Column<select value={f.status} onChange={set('status')}>{['Backlog', 'To Do', 'In Progress'].map(x => <option key={x}>{x}</option>)}</select></label>
        </div>
        <label>Assignee <select value={f.assignee} onChange={set('assignee')}>{EMPLOYEES.filter(e => e.role !== 'boss').map(e => <option key={e.slug} value={e.slug}>{e.name} — {e.title}</option>)}</select></label>
        <textarea rows={4} value={f.desc} onChange={set('desc')} placeholder="Details" />
        <div className="ops-modal-f"><button onClick={onClose}>Cancel</button><button className="primary" disabled={!f.title.trim()} onClick={() => post('/ops/ticket', f).then(onDone)}>Create</button></div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- risk / books / alphas
function RunBtn({ job, label, refresh }: { job: string; label: string; refresh: () => void }) {
  const [busy, setBusy] = useState(false)
  return <button className="ops-run" disabled={busy} onClick={async () => { setBusy(true); await post(`/ops/run/${job}`); setBusy(false); refresh() }}>{busy ? 'Working…' : label}</button>
}

function Risk({ s, refresh }: { s: OpsState; refresh: () => void }) {
  const r = s.risk
  if (!r) return <div className="ops-empty big">No risk check yet today. <RunBtn job="risk" label="Ask Dwight to run one" refresh={refresh} /></div>
  return (
    <div className="ops-pane">
      <div className="ops-pane-h">
        <div className={`ops-regime ${r.regime.toLowerCase()}`}>{r.regime}<span>score {r.score > 0 ? '+' : ''}{r.score}</span></div>
        <div className="ops-pane-who"><b>Dwight Schrute</b> · Chief Risk Officer<br /><span className="ops-muted">Checked {when(r.at)} · {simLabel(r.sources)}</span></div>
        <RunBtn job="risk" label="📈 Run a risk check now" refresh={refresh} />
      </div>
      <h4>Market indicators</h4>
      <table className="ops-table">
        <thead><tr><th></th><th>Indicator</th><th>Last</th><th>Day</th><th>1 mo</th><th>vs 200d</th><th>20d vol</th><th>Read</th></tr></thead>
        <tbody>{r.rows.map(x => <tr key={x.t}><td>{x.status === 'alert' ? '🔴' : x.status === 'watch' ? '🟡' : '🟢'}</td><td><b>{x.name}</b> <span className="ops-muted">{x.t.replace('^', '')}</span></td><td>{px(x.last)}</td><td className={tone(x.dayChg)}>{pct(x.dayChg)}</td><td className={tone(x.m1)}>{pct(x.m1)}</td><td className={tone(x.vs200)}>{pct(x.vs200)}</td><td>{(x.vol20 * 100).toFixed(0)}%</td><td className="wrap">{x.note}</td></tr>)}</tbody>
      </table>
      <h4>Book risk</h4>
      <table className="ops-table">
        <thead><tr><th>Book</th><th>NAV</th><th>1-day 95% VaR</th><th>% NAV</th><th>Vol</th><th>Beta</th><th>Largest name</th><th>Off high</th><th>Breaches</th></tr></thead>
        <tbody>{r.books.map(b => <tr key={b.id}><td><b>{b.name}</b></td><td>{usd(b.nav)}</td><td>{usd(b.var95)}</td><td>{(b.varPct * 100).toFixed(2)}%</td><td>{(b.vol * 100).toFixed(1)}%</td><td>{b.beta?.toFixed(2) ?? '—'}</td><td>{b.top ? `${b.top.ticker} ${(b.top.weight * 100).toFixed(1)}%` : '—'}</td><td className={tone(b.drawdown)}>{pct(b.drawdown)}</td><td className="wrap">{b.breaches.length ? <span className="down">{b.breaches.join('; ')}</span> : '—'}</td></tr>)}</tbody>
      </table>
    </div>
  )
}

function Spark({ data }: { data: number[] }) {
  if (data.length < 2) return null
  const lo = Math.min(...data), hi = Math.max(...data), w = 90, h = 24
  const d = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - lo) / (hi - lo || 1)) * h}`).join(' ')
  return <svg width={w} height={h} className="ops-spark"><polyline points={d} fill="none" stroke={data[data.length - 1] >= data[0] ? '#3fb950' : '#f85149'} strokeWidth="1.5" /></svg>
}

function Books({ s, avatarFor, refresh }: { s: OpsState; avatarFor: (slug: string) => string; refresh: () => void }) {
  const [open, setOpen] = useState<string | null>(s.books[0]?.id ?? null)
  const firm = s.books.reduce((a, b) => a + (b.nav ?? 0), 0), pnl = s.books.reduce((a, b) => a + (b.dayPnl ?? 0), 0)
  return (
    <div className="ops-pane">
      <div className="ops-pane-h">
        <div className="ops-big"><span className="ops-muted">Firm AUM</span><b>{usd(firm)}</b><span className={tone(pnl)}>{usd(pnl)} today ({pct(pnl / (firm - pnl), 2)})</span></div>
        <div className="ops-pane-who ops-muted">{simLabel([...new Set(s.books.flatMap(b => b.sources ?? []))])} · marked {when(s.now)}</div>
        <RunBtn job="books" label="💼 Ask the PMs for updates" refresh={refresh} />
      </div>
      <div className="ops-books">
        {s.books.map(b => (
          <div key={b.id} className={`ops-book${open === b.id ? ' on' : ''}`}>
            <button className="ops-book-h" onClick={() => setOpen(open === b.id ? null : b.id)}>
              <Avatar slug={b.pm} size={30} avatarFor={avatarFor} />
              <span className="ops-book-name"><b>{b.name}</b><span className="ops-muted">PM {b.pmName}{b.team.length ? ` · ${b.team.map(x => nameOf(x).split(' ')[0]).join(', ')}` : ''}</span></span>
              <Spark data={(b.history ?? []).map(h => h.nav).concat(b.nav)} />
              <span className="ops-book-num"><b>{usd(b.nav)}</b><span className={tone(b.dayPnl)}>{usd(b.dayPnl)} ({pct(b.dayRet, 2)})</span></span>
              <span className={`ops-book-num ${tone(b.sinceInception)}`}>{pct(b.sinceInception, 1)}<span className="ops-muted">since start</span></span>
            </button>
            {open === b.id && (
              <div className="ops-book-body">
                {b.risk && <div className="ops-muted small">VaR {usd(b.risk.var95)} ({(b.risk.varPct * 100).toFixed(2)}% · limit {((b.limits?.var ?? 0) * 100).toFixed(1)}%) · vol {(b.risk.vol * 100).toFixed(1)}% · beta {b.risk.beta?.toFixed(2) ?? '—'} · single-name limit {((b.limits?.single ?? 0) * 100).toFixed(0)}%{b.risk.breaches.length ? <span className="down"> · {b.risk.breaches.join('; ')}</span> : ''}</div>}
                <table className="ops-table">
                  <thead><tr><th>Position</th><th>Price</th><th>Day</th><th>Value</th><th>Day P&amp;L</th><th>Unrealised</th><th>Weight</th><th>Target</th><th>Drift</th></tr></thead>
                  <tbody>{b.positions.map(p => <tr key={p.ticker}><td><b>{p.ticker}</b> <span className="ops-muted">{p.name}</span></td><td>{p.ticker === 'CASH' ? '—' : px(p.px)}</td><td className={tone(p.dayChg)}>{p.ticker === 'CASH' ? '—' : pct(p.dayChg)}</td><td>{usd(p.value)}</td><td className={tone(p.dayPnl)}>{p.ticker === 'CASH' ? '—' : usd(p.dayPnl)}</td><td className={tone(p.upnl)}>{p.ticker === 'CASH' ? '—' : usd(p.upnl)}</td><td>{(p.weight * 100).toFixed(1)}%</td><td>{(p.target * 100).toFixed(0)}%</td><td className={Math.abs(p.drift) > 0.03 ? 'down' : ''}>{pct(p.drift)}</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </div>
        ))}
      </div>
      {s.trades.length > 0 && <>
        <h4>Recent trades</h4>
        <table className="ops-table"><thead><tr><th>Trade</th><th>Date</th><th>Book</th><th>Side</th><th>Ticker</th><th>Shares</th><th>Price</th><th>Notional</th><th>Settled</th></tr></thead>
          <tbody>{s.trades.map(t => <tr key={t.id}><td>{t.id}</td><td>{t.date}</td><td>{s.books.find(b => b.id === t.book)?.short ?? t.book}</td><td className={t.side === 'BUY' ? 'up' : 'down'}>{t.side}</td><td><b>{t.ticker}</b></td><td>{Math.round(t.shares).toLocaleString()}</td><td>{px(t.px)}</td><td>{usd(t.notional)}</td><td>{t.settled ?? 'pending T+1'}</td></tr>)}</tbody></table>
      </>}
    </div>
  )
}

function Alphas({ s, refresh }: { s: OpsState; refresh: () => void }) {
  const a = s.alphas
  if (!a) return <div className="ops-empty big">No alpha report yet. <RunBtn job="alpha" label="Ask Oscar for one" refresh={refresh} /></div>
  const V = { use: ['✅ Use', 'up'], flip: ['🔁 Use reversed', 'up'], weak: ['⚠️ Weak', 'ops-muted'] } as const
  return (
    <div className="ops-pane">
      <div className="ops-pane-h">
        <div className="ops-big"><span className="ops-muted">Usable alphas</span><b>{a.stats.filter(x => x.verdict !== 'weak').length} / {a.stats.length}</b><span className="ops-muted">{a.universe} stocks · {simLabel(a.sources)}</span></div>
        <div className="ops-pane-who"><b>Oscar Martínez & Karen Filippelli</b> · Quant & Research<br /><span className="ops-muted">Report from {when(a.at)}</span> · <a href={a.url} target="_blank" rel="noreferrer">Open the full report ↗</a></div>
        <RunBtn job="alpha" label="🧮 Re-run the report" refresh={refresh} />
      </div>
      <h4>Signal library — back-tested (rank IC vs. next-month returns)</h4>
      <table className="ops-table">
        <thead><tr><th>Signal</th><th>Owner</th><th>Avg IC</th><th>t-stat</th><th>Hit rate</th><th>Tests</th><th>Verdict</th></tr></thead>
        <tbody>{a.stats.map(x => <tr key={x.id}><td><b>{x.name}</b></td><td>{nameOf(x.owner).split(' ')[0]}</td><td className={tone(x.ic)}>{x.ic.toFixed(3)}</td><td>{x.icT.toFixed(2)}</td><td>{(x.hit * 100).toFixed(0)}%</td><td>{x.n}</td><td className={V[x.verdict][1]}>{V[x.verdict][0]}</td></tr>)}</tbody>
      </table>
      <div className="ops-ideas">
        <div><h4>Long ideas</h4>{a.longs.map((x, i) => <div key={x.ticker} className="ops-idea"><span className="ops-idea-n">{i + 1}</span><b>{x.ticker}</b><span className="up">{x.score.toFixed(2)}</span><span className="ops-muted wrap">{x.why}</span></div>)}</div>
        <div><h4>Underweight / avoid</h4>{a.avoid.map((x, i) => <div key={x.ticker} className="ops-idea"><span className="ops-idea-n">{i + 1}</span><b>{x.ticker}</b><span className="down">{x.score.toFixed(2)}</span><span className="ops-muted wrap">{x.why}</span></div>)}</div>
      </div>
      <p className="ops-muted small">IC = how well ranking stocks by the signal predicted the next month's ranking of returns. Above ~0.03 with a t-stat over 1 is usable; reliably negative means use it the other way round. Research, not advice.</p>
    </div>
  )
}

// ---------------------------------------------------------------- shell
interface Props { state: OpsState | null; tab: OpsTab; setTab: (t: OpsTab) => void; onClose: () => void; refresh: () => void; avatarFor: (slug: string) => string; openEmail: string | null; setOpenEmail: (id: string | null) => void }

const OpsDesk: React.FC<Props> = ({ state, tab, setTab, onClose, refresh, avatarFor, openEmail, setOpenEmail }) => {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  const s = state
  const needs = s ? s.tickets.filter(t => t.needsMichael && t.status !== 'Done').length : 0
  const tabs: [OpsTab, string, React.ReactNode][] = [
    ['inbox', '📧 Inbox', s?.unread ? <b>{s.unread}</b> : null],
    ['board', '📋 Board', needs ? <b className="warn">{needs}</b> : null],
    ['risk', '📈 Risk', s?.risk ? <i className={`dot ${s.risk.regime.toLowerCase()}`} /> : null],
    ['books', '💼 Books', null],
    ['alphas', '🧮 Alphas', null],
  ]
  return (
    <div className="ops-desk" onPointerDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
      <div className="ops-tabs">
        {tabs.map(([id, label, badge]) => <button key={id} className={`ops-tab${tab === id ? ' on' : ''}`} onClick={() => setTab(id)}>{label}{badge}</button>)}
        <span className="ops-tabs-sp" />
        {s && <span className="ops-muted small">{s.phase === 'open' ? '🟢 Market open' : s.phase === 'pre' ? '🟡 Pre-market' : s.phase === 'after' ? '🟠 After hours' : '🔴 Market closed'}</span>}
        <button className="ops-x" onClick={onClose} title="Back to the floor (Esc)">✕ Floor</button>
      </div>
      <div className="ops-body">
        {!s ? <div className="ops-empty big">Connecting to the office server…</div>
          : tab === 'inbox' ? <Inbox s={s} avatarFor={avatarFor} openId={openEmail} setOpenId={setOpenEmail} refresh={refresh} />
            : tab === 'board' ? <Board s={s} avatarFor={avatarFor} refresh={refresh} />
              : tab === 'risk' ? <Risk s={s} refresh={refresh} />
                : tab === 'books' ? <Books s={s} avatarFor={avatarFor} refresh={refresh} />
                  : <Alphas s={s} refresh={refresh} />}
      </div>
    </div>
  )
}

export default OpsDesk
