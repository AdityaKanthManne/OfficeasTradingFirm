import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'

/**
 * FloorCamera — a Zillow-style close-up camera over the Scranton floor.
 *
 * The angle never changes (it's the same isometric view everywhere); you just
 * see one part of the office at a time and glide between parts:
 *   • edge arrows / drag / minimap click / "Go to" menu  → move the camera
 *   • − / + (or the mouse wheel)                         → zoom (overview ↔ close-up)
 *   • D-pad / arrow keys / WASD                          → walk Michael (camera follows)
 *   • click anywhere on the floor                        → Michael walks there
 */

export interface CameraApi {
  /** glide to a point on the map (map %) */
  lookAt: (x: number, y: number) => void
  follow: () => void
}

interface Pt { x: number; y: number }

interface Props {
  mapW: number
  mapH: number
  worldRef: React.RefObject<HTMLDivElement>
  worldClassName?: string
  minimap?: string
  labels: { id: string; name: string; x: number; y: number }[]
  /** live positions (map %) for the follow camera and minimap dots */
  getPeople: () => { id: string; x: number; y: number; color: string; boss: boolean }[]
  /** walk Michael: world-axis direction (du, dv), both 0 = stop */
  onMove: (du: number, dv: number) => void
  /** click-to-walk target (map %) */
  onWalkTo: (x: number, y: number) => void
  onHome: () => void
  /** pick up / carry / drop Michael (map %) */
  onPick?: (phase: 'start' | 'move' | 'drop', x: number, y: number) => void
  /** clicked a person → talk to them */
  onPersonClick?: (id: string) => void
  children: React.ReactNode
}

const ZOOMS = [0.45, 0.6, 0.75, 0.9, 1.1, 1.35]
const DEFAULT_ZOOM = 0.9

const FloorCamera = React.forwardRef<CameraApi, Props>(function FloorCamera(
  { mapW, mapH, worldRef, worldClassName, minimap, labels, getPeople, onMove, onWalkTo, onHome, onPick, onPersonClick, children }, ref,
) {
  const vpRef = useRef<HTMLDivElement>(null)
  const viewRectRef = useRef<HTMLDivElement>(null)
  const dotsRef = useRef<HTMLCanvasElement>(null)
  const [vp, setVp] = useState({ w: 800, h: 500 })
  const [scale, setScale] = useState(DEFAULT_ZOOM)
  const [following, setFollowing] = useState(true)
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const followRef = useRef(true)
  const cam = useRef<Pt>({ x: mapW * 0.3, y: mapH * 0.45 })
  const target = useRef<Pt>({ x: mapW * 0.3, y: mapH * 0.45 })
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean; id: number; person?: string | null } | null>(null)
  /** carrying Michael: last pointer position (client px) */
  const carry = useRef<{ x: number; y: number } | null>(null)

  const setFollow = (on: boolean) => { followRef.current = on; setFollowing(on) }

  // ---- viewport size ------------------------------------------------------
  useEffect(() => {
    const el = vpRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setVp({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setVp({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const fit = Math.min(vp.w / mapW, vp.h / mapH)
  const levels = [fit, ...ZOOMS.filter(z => z > fit * 1.08)]
  const zi = levels.reduce((best, z, i) => (Math.abs(z - scale) < Math.abs(levels[best] - scale) ? i : best), 0)

  const zoomTo = useCallback((z: number) => setScale(Math.max(fit, Math.min(ZOOMS[ZOOMS.length - 1], z))), [fit])

  useImperativeHandle(ref, () => ({
    lookAt: (x, y) => { setFollow(false); target.current = { x: (x / 100) * mapW, y: (y / 100) * mapH } },
    follow: () => setFollow(true),
  }), [mapW, mapH])

  // ---- camera loop ----------------------------------------------------------
  useEffect(() => {
    let raf = 0
    let lastDots = 0
    const tick = (now: number) => {
      const world = worldRef.current
      const s = scaleRef.current
      const vw = vpRef.current?.clientWidth ?? 800
      const vh = vpRef.current?.clientHeight ?? 500
      if (followRef.current && !drag.current) {
        const boss = getPeople().find(p => p.boss)
        if (boss) target.current = { x: (boss.x / 100) * mapW, y: (boss.y / 100) * mapH - 30 }
      }
      // keep the view on the building
      const clamp = (p: Pt): Pt => {
        const hw = vw / 2 / s, hh = vh / 2 / s
        const cx = mapW * s <= vw ? mapW / 2 : Math.max(hw, Math.min(mapW - hw, p.x))
        const cy = mapH * s <= vh ? mapH / 2 : Math.max(hh, Math.min(mapH - hh, p.y))
        return { x: cx, y: cy }
      }
      target.current = clamp(target.current)
      if (carry.current && vpRef.current) {
        // carrying Michael near an edge → slide the camera that way
        const r = vpRef.current.getBoundingClientRect()
        const edge = 56, sp = 9 / s
        const ex = carry.current.x - r.left < edge ? -1 : r.right - carry.current.x < edge ? 1 : 0
        const ey = carry.current.y - r.top < edge ? -1 : r.bottom - carry.current.y < edge ? 1 : 0
        if (ex || ey) {
          target.current = { x: target.current.x + ex * sp, y: target.current.y + ey * sp }
          const m = toMap(carry.current.x, carry.current.y)
          if (m) onPickRef.current?.('move', m.x, m.y)
        }
      }
      const c = cam.current
      if (drag.current) { c.x = target.current.x; c.y = target.current.y } else {
        c.x += (target.current.x - c.x) * 0.12
        c.y += (target.current.y - c.y) * 0.12
      }
      if (world) {
        world.style.transform = `translate3d(${Math.round(vw / 2 - c.x * s)}px, ${Math.round(vh / 2 - c.y * s)}px, 0)`
      }
      const vr = viewRectRef.current
      if (vr) {
        const w = Math.min(100, (vw / s / mapW) * 100), h = Math.min(100, (vh / s / mapH) * 100)
        vr.style.width = `${w}%`
        vr.style.height = `${h}%`
        vr.style.left = `${(c.x / mapW) * 100 - w / 2}%`
        vr.style.top = `${(c.y / mapH) * 100 - h / 2}%`
      }
      if (now - lastDots > 250 && dotsRef.current) {
        lastDots = now
        const cv = dotsRef.current
        const ctx = cv.getContext('2d')
        if (ctx) {
          ctx.clearRect(0, 0, cv.width, cv.height)
          for (const p of getPeople()) {
            ctx.beginPath()
            ctx.arc((p.x / 100) * cv.width, (p.y / 100) * cv.height, p.boss ? 3.6 : 2.4, 0, Math.PI * 2)
            ctx.fillStyle = p.boss ? '#ffd33d' : p.color
            ctx.fill()
            ctx.lineWidth = 1
            ctx.strokeStyle = 'rgba(0,0,0,0.7)'
            ctx.stroke()
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [getPeople, mapW, mapH, worldRef])

  const onPickRef = useRef(onPick)
  onPickRef.current = onPick
  /** client px → map % (null when off the map) */
  function toMap(clientX: number, clientY: number): Pt | null {
    const el = vpRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const s = scaleRef.current
    const mx = cam.current.x + (clientX - rect.left - rect.width / 2) / s
    const my = cam.current.y + (clientY - rect.top - rect.height / 2) / s
    return { x: Math.max(0, Math.min(100, (mx / mapW) * 100)), y: Math.max(0, Math.min(100, (my / mapH) * 100)) }
  }

  // ---- pan / drag / click-to-walk -------------------------------------------
  const pan = (dx: number, dy: number) => {
    setFollow(false)
    const s = scaleRef.current
    target.current = { x: cam.current.x + (dx * vp.w * 0.45) / s, y: cam.current.y + (dy * vp.h * 0.45) / s }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    // grabbed Michael? pick him up instead of panning
    if (onPick && (e.target as HTMLElement).closest?.('[data-pick]')) {
      e.preventDefault()
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      setFollow(false)
      carry.current = { x: e.clientX, y: e.clientY }
      const m = toMap(e.clientX, e.clientY)
      if (m) onPick('start', m.x, m.y)
      return
    }
    const person = (e.target as HTMLElement).closest?.('[data-person]')?.getAttribute('data-person') ?? null
    drag.current = { x: e.clientX, y: e.clientY, cx: cam.current.x, cy: cam.current.y, moved: false, id: e.pointerId, person }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (carry.current) {
      carry.current = { x: e.clientX, y: e.clientY }
      const m = toMap(e.clientX, e.clientY)
      if (m) onPick?.('move', m.x, m.y)
      return
    }
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x, dy = e.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) > 5) {
      d.moved = true
      setFollow(false)
      ;(e.currentTarget as HTMLElement).setPointerCapture(d.id)
    }
    if (d.moved) {
      const s = scaleRef.current
      target.current = { x: d.cx - dx / s, y: d.cy - dy / s }
    }
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (carry.current) {
      carry.current = null
      const m = toMap(e.clientX, e.clientY)
      if (m) onPick?.('drop', m.x, m.y)
      return
    }
    const d = drag.current
    drag.current = null
    if (!d || d.moved) return
    // clicked someone → go talk to them
    if (d.person && onPersonClick) { setFollow(true); onPersonClick(d.person); return }
    // a click: walk Michael there
    const rect = vpRef.current!.getBoundingClientRect()
    const s = scaleRef.current
    const mx = cam.current.x + (e.clientX - rect.left - rect.width / 2) / s
    const my = cam.current.y + (e.clientY - rect.top - rect.height / 2) / s
    if (mx < 0 || my < 0 || mx > mapW || my > mapH) return
    setFollow(true)
    onWalkTo((mx / mapW) * 100, (my / mapH) * 100)
  }
  const onWheel = (e: React.WheelEvent) => {
    if (Math.abs(e.deltaY) < 4) return
    const next = e.deltaY > 0 ? levels[Math.max(0, zi - 1)] : levels[Math.min(levels.length - 1, zi + 1)]
    if (next !== scale) zoomTo(next)
  }

  // ---- Michael: keyboard + D-pad --------------------------------------------
  const keys = useRef(new Set<string>())
  const pad = useRef<{ du: number; dv: number } | null>(null)
  const lastSent = useRef('0,0')
  const send = useCallback(() => {
    let du = 0, dv = 0
    if (pad.current) { du = pad.current.du; dv = pad.current.dv } else {
      // screen directions → world axes: screen up = (+u, −v), right = (+u, +v)
      const k = keys.current
      const sx = (k.has('right') ? 1 : 0) - (k.has('left') ? 1 : 0)
      const sy = (k.has('down') ? 1 : 0) - (k.has('up') ? 1 : 0)
      du = sx - sy
      dv = sx + sy
    }
    const n = Math.hypot(du, dv)
    if (n > 0) { du /= n; dv /= n }
    const key = `${du.toFixed(2)},${dv.toFixed(2)}`
    if (key === lastSent.current) return
    lastSent.current = key
    if (n > 0) setFollow(true)
    onMove(du, dv)
  }, [onMove])

  useEffect(() => {
    const map: Record<string, string> = {
      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right',
      W: 'up', S: 'down', A: 'left', D: 'right',
    }
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || el.tagName === 'SELECT')
    }
    const down = (e: KeyboardEvent) => {
      const k = map[e.key]
      if (!k || typing(e.target) || e.metaKey || e.ctrlKey) return
      e.preventDefault()
      keys.current.add(k)
      send()
    }
    const up = (e: KeyboardEvent) => {
      const k = map[e.key]
      if (!k) return
      keys.current.delete(k)
      send()
    }
    const blur = () => { keys.current.clear(); pad.current = null; send() }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur) }
  }, [send])

  /** arrow drawn along the floor's iso axes (screen angle in degrees, 0 = pointing right) */
  const padBtn = (angle: number, title: string, du: number, dv: number, cls: string) => (
    <button
      className={`iso-dpad-btn ${cls}`}
      title={title}
      onPointerDown={e => { e.preventDefault(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); pad.current = { du, dv }; send() }}
      onPointerUp={() => { pad.current = null; send() }}
      onPointerCancel={() => { pad.current = null; send() }}
      onContextMenu={e => e.preventDefault()}
    >
      <svg viewBox="-10 -10 20 20" width="18" height="18" style={{ transform: `rotate(${angle}deg)` }} aria-hidden>
        <path d="M-6 -2.2 L2 -2.2 L2 -6 L8 0 L2 6 L2 2.2 L-6 2.2 Z" fill="currentColor" />
      </svg>
    </button>
  )

  const onMiniClick = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setFollow(false)
    target.current = { x: ((e.clientX - r.left) / r.width) * mapW, y: ((e.clientY - r.top) / r.height) * mapH }
  }

  return (
    <>
      <div
        ref={vpRef}
        className="iso-viewport"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={e => {
          drag.current = null
          if (carry.current) { carry.current = null; const m = toMap(e.clientX, e.clientY); if (m) onPick?.('drop', m.x, m.y) }
        }}
        onWheel={onWheel}
      >
        <div
          ref={worldRef}
          className={worldClassName}
          style={{ position: 'absolute', left: 0, top: 0, width: Math.round(mapW * scale), height: Math.round(mapH * scale) }}
        >
          {children}
        </div>
      </div>

      {/* Edge arrows — slide the camera to the next part of the office */}
      <button className="iso-pan iso-pan-left" onClick={() => pan(-1, 0)} title="Look left">‹</button>
      <button className="iso-pan iso-pan-right" onClick={() => pan(1, 0)} title="Look right">›</button>
      <button className="iso-pan iso-pan-up" onClick={() => pan(0, -1)} title="Look up">‹</button>
      <button className="iso-pan iso-pan-down" onClick={() => pan(0, 1)} title="Look down">‹</button>

      {/* Minimap + room jump */}
      <div className="iso-minimap">
        <div className="iso-mini-head">
          <select
            value=""
            onChange={e => {
              const l = labels.find(x => x.id === e.target.value)
              if (l) { setFollow(false); target.current = { x: (l.x / 100) * mapW, y: (l.y / 100) * mapH } }
            }}
            aria-label="Go to room"
          >
            <option value="" disabled>Go to…</option>
            {labels.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <div className="iso-mini-map" onClick={onMiniClick} style={{ aspectRatio: `${mapW}/${mapH}` }}>
          {minimap && <img src={minimap} alt="" draggable={false} />}
          <canvas ref={dotsRef} width={260} height={Math.round((260 * mapH) / mapW)} />
          <div ref={viewRectRef} className="iso-mini-view" />
        </div>
      </div>

      {/* Michael's controls */}
      <div className="iso-controls">
        <div className="iso-ctl-row">
          <button className="iso-ctl" onClick={onHome} title="Send Michael back to his desk">🏠 Desk</button>
          <div className="floor-zoom iso-zoom" role="group" aria-label="Zoom">
            <button onClick={() => zoomTo(levels[Math.max(0, zi - 1)])} disabled={zi <= 0} title="Zoom out">−</button>
            <span>{zi === 0 ? 'All' : `${Math.round(scale * 100)}%`}</span>
            <button onClick={() => zoomTo(levels[Math.min(levels.length - 1, zi + 1)])} disabled={zi >= levels.length - 1} title="Zoom in">+</button>
          </div>
        </div>
        <div className="iso-dpad" aria-label="Walk Michael">
          {padBtn(-153.4, 'Walk Michael ↖ (or arrow keys / WASD)', 0, -1, 'n')}
          {padBtn(-26.6, 'Walk Michael ↗', 1, 0, 'e')}
          {padBtn(26.6, 'Walk Michael ↘', 0, 1, 's')}
          {padBtn(153.4, 'Walk Michael ↙', -1, 0, 'w')}
          <button className={`iso-dpad-center${following ? ' on' : ''}`} onClick={() => setFollow(true)} title="Find Michael (camera follows him)">
            <img src="/sprites/office/characters/michael-scott-front-left.png" alt="Michael" draggable={false} />
          </button>
        </div>
      </div>
    </>
  )
})

export default FloorCamera
