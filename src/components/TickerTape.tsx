import React, { useEffect, useState } from 'react'
import { FIRM } from '../firm'

/** Shape broadcast by the server as `desk_update` and returned by GET /portfolio/status */
export interface DeskBook {
  id?: string
  client: string
  totalValue: number
  positions: { ticker: string; weight: number; pnlPct?: number; ret1y?: number }[]
  vol?: number
  var95?: number
  failing?: number
  reportUrl?: string
}
export interface DeskState {
  status: 'running' | 'idle'
  stage?: string
  running?: { id: string; client: string; startedAt: number } | null
  latest?: DeskBook | null
  book?: DeskBook | null
}

const STAGE_LABEL: Record<string, string> = {
  intake: 'ERIN IS LOGGING THE ORDER',
  pricing: 'KEVIN IS PRICING THE BOOK',
  analysis: 'DESK IS ANALYZING',
  huddle: 'DESK HUDDLE',
  execution: 'JIM IS BUILDING THE TRADES',
  report: 'PAM IS WRITING THE REPORT',
}

const usd = (n: number) => `$${Math.round(n).toLocaleString()}`

function Item({ children, tone }: { children: React.ReactNode; tone?: 'up' | 'down' | 'warn' | 'dim' }) {
  return <span className={`ticker-item${tone ? ` ticker-${tone}` : ''}`}>{children}</span>
}

const TickerTape: React.FC<{ desk: DeskState | null }> = ({ desk }) => {
  const [initial, setInitial] = useState<DeskState | null>(null)

  // Pick up the last book on first load (before any websocket update arrives)
  useEffect(() => {
    if (desk) return
    fetch('http://127.0.0.1:3334/portfolio/status')
      .then(r => r.json())
      .then(d => setInitial(d))
      .catch(() => {})
  }, [desk])

  const state = desk ?? initial
  const running = state?.status === 'running'
  // While a run is in progress only show that run's book (never the previous client's)
  const book = running ? (state?.book ?? null) : (state?.latest ?? null)

  const items: React.ReactNode[] = []
  if (book) {
    items.push(<Item key="client" tone="dim">{book.client.toUpperCase()} · {usd(book.totalValue)}</Item>)
    for (const p of book.positions.filter(p => p.ticker !== 'CASH')) {
      const chg = p.pnlPct ?? p.ret1y
      items.push(
        <Item key={p.ticker} tone={chg == null ? undefined : chg >= 0 ? 'up' : 'down'}>
          <b>{p.ticker}</b> {p.weight.toFixed(1)}%
          {chg != null && <> {chg >= 0 ? '▲' : '▼'}{Math.abs(chg).toFixed(1)}%</>}
        </Item>,
      )
    }
    if (book.vol != null) items.push(<Item key="vol" tone="dim">VOL {book.vol}%</Item>)
    if (book.var95 != null) items.push(<Item key="var" tone="dim">VaR95 1D {usd(book.var95)}</Item>)
    if (book.failing != null) {
      items.push(book.failing > 0
        ? <Item key="mandate" tone="down">MANDATE: {book.failing} BREACH{book.failing > 1 ? 'ES' : ''} (ANGELA IS UPSET)</Item>
        : <Item key="mandate" tone="up">MANDATE: COMPLIANT</Item>)
    }
  } else if (running) {
    items.push(<Item key="incoming" tone="up">NEW BOOK INCOMING: {(state?.running?.client ?? 'CLIENT').toUpperCase()}</Item>)
    items.push(<Item key="erin" tone="dim">ERIN IS ON THE PHONE · KEVIN IS FINDING HIS CALCULATOR</Item>)
  } else {
    items.push(<Item key="firm" tone="dim">{FIRM.fullName.toUpperCase()}</Item>)
    items.push(<Item key="tag">{FIRM.tagline}</Item>)
    items.push(<Item key="hint" tone="up">TYPE /portfolio IN #trading-floor TO SEND THE DESK A BOOK</Item>)
    items.push(<Item key="bears" tone="dim">BEARS ▼ · BEETS ▲ · BATTLESTAR GALACTICA ━</Item>)
  }

  return (
    <div className="ticker-tape" aria-label="Trading desk ticker">
      <div className={`ticker-status ${running ? 'running' : 'idle'}`}>
        <img src="/sprites/office/props/dunder-mifflin-capital-logo.png" alt="" className="ticker-logo" />
        <span>{running ? (STAGE_LABEL[state?.stage ?? ''] ?? 'DESK BUSY') : 'DESK OPEN'}</span>
      </div>
      <div className="ticker-track">
        {/* Rendered twice so the marquee loops seamlessly */}
        <div className="ticker-run">{items}{items.map((it, i) => <React.Fragment key={`dup-${i}`}>{it}</React.Fragment>)}</div>
      </div>
      {state?.latest?.reportUrl && !running && (
        <a className="ticker-report" href={state.latest.reportUrl} target="_blank" rel="noopener noreferrer">📄 REPORT</a>
      )}
    </div>
  )
}

export default TickerTape
