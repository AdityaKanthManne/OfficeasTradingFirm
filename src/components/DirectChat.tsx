import React, { useEffect, useRef, useState } from 'react'

/**
 * DirectChat — the small floating box for one-on-one conversations on the
 * floor. Separate from the #trading-floor group chat: only you and the person
 * you walked up to (or clicked) are in it. Shows who they are and what they do.
 */

export interface DirectMsg { from: 'staff' | 'michael'; text: string; at: number }

interface Props {
  name: string
  title?: string
  department?: string
  color: string
  avatar: string
  messages: DirectMsg[]
  typing: boolean
  onSend: (text: string) => void
  onClose: () => void
}

const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

const DirectChat: React.FC<Props> = ({ name, title, department, color, avatar, messages, typing, onSend, onClose }) => {
  const [text, setText] = useState('')
  const [min, setMin] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const first = name.split(' ')[0]

  useEffect(() => { inputRef.current?.focus() }, [name])
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, typing, min])

  const send = () => {
    const t = text.trim()
    if (!t) return
    onSend(t)
    setText('')
  }

  return (
    <div className={`dm-box${min ? ' min' : ''}`} style={{ borderTopColor: color }} role="dialog" aria-label={`Conversation with ${name}`}
      onPointerDown={e => e.stopPropagation()}>
      <div className="dm-head" onDoubleClick={() => setMin(m => !m)}>
        <div className="dm-avatar" style={{ borderColor: color }}>
          <img src={avatar} alt="" draggable={false} onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden' }} />
        </div>
        <div className="dm-who">
          <div className="dm-name">{name}</div>
          {title && <div className="dm-title">{title}</div>}
          {department && <div className="dm-dept">{department}</div>}
        </div>
        <button className="dm-btn" onClick={() => setMin(m => !m)} title={min ? 'Expand' : 'Minimize'} aria-label={min ? 'Expand' : 'Minimize'}>{min ? '▴' : '▾'}</button>
        <button className="dm-btn" onClick={onClose} title="End the conversation" aria-label="End the conversation">×</button>
      </div>
      {!min && (
        <>
          <div className="dm-list" ref={listRef}>
            {messages.length === 0 && !typing && <div className="dm-empty">Say hi to {first}…</div>}
            {messages.map((m, i) => (
              <div key={i} className={`dm-msg ${m.from}`}>
                <div className="dm-bubble" style={m.from === 'staff' ? { borderLeftColor: color } : undefined}>{m.text}</div>
                <div className="dm-time">{m.from === 'michael' ? 'You' : first} · {time(m.at)}</div>
              </div>
            ))}
            {typing && <div className="dm-msg staff"><div className="dm-bubble typing" style={{ borderLeftColor: color }}><span /><span /><span /></div></div>}
          </div>
          <div className="dm-input">
            <input
              ref={inputRef}
              value={text}
              placeholder={`Ask ${first} something…`}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); send() }
                if (e.key === 'Escape') onClose()
                e.stopPropagation()
              }}
            />
            <button onClick={send} disabled={!text.trim()}>Send</button>
          </div>
        </>
      )}
    </div>
  )
}

export default DirectChat
