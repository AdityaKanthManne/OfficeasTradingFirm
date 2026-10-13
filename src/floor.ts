/**
 * floor.ts — the full Dunder Mifflin Scranton floor (isometric pixel map).
 *
 * Built by scripts/build-scranton-floor.py from the floor-plan render in
 * docs/reference/ → firm/scranton-floor.json. Layers: the render is the base,
 * room labels sit above it, and avatars are always the top layer.
 * Every cast member has a home desk (seats); people who share a desk
 * (Pam/Erin at reception, Toby/Holly in the annex, Andy/Karen) take turns:
 * whoever arrives first sits, the other floats around the kitchen, reception
 * couch, annex, etc. until the desk frees up. Meetings use the conference room.
 */

import data from '../firm/scranton-floor.json'
import type { Room, AgentSpot } from './rooms'

/** One sprite cut from the atlas: position/size in % of the map, atlas rect in px, depth z */
export interface FloorFurniture {
  sprite?: string; left: number; top: number; width: number; height?: number; z: number
  ax?: number; ay?: number; aw?: number; ah?: number
}
export interface FloorLabel { id: string; name: string; sub: string; x: number; y: number }

type RawSpot = AgentSpot & { room?: string; u?: number; v?: number; sit?: boolean }

export const FLOOR = data as unknown as {
  size: { width: number; height: number }
  /** avatar height as a fraction of the map width */
  spriteScale: number
  /** base layer is pixel art → render with nearest-neighbour scaling */
  pixelArt?: boolean
  /** 'iso' = the tile-built map (atlas sprites + walk grid) */
  style?: string
  atlas?: { day: string; night: string; width: number; height: number }
  minimap?: string
  /** screen = (ox + (u+v)·tw/2, oy + (v−u)·th/2) in map px; personBias = feet depth nudge (% of height) */
  iso?: { ox: number; oy: number; tw: number; th: number; personBias: number }
  grid?: { cell: number; cols: number; rows: number; data: string }
  /** room areas in world tiles (first match wins) */
  rooms?: { id: string; rects: [number, number, number, number][] }[]
  background: { day: string; night: string }
  entryPoint: { x: number; y: number }
  spots: RawSpot[]
  seats: Record<string, string>
  deskOwners: Record<string, string[]>
  floaters: string[]
  floatSpots: string[]
  meetingSeats: string[]
  meetingStanding: string[]
  eventTargets: Record<string, { x: number; y: number }>
  labels: FloorLabel[]
  furniture: FloorFurniture[]
  waypoints: { id: string; x: number; y: number; connections: string[] }[]
}

export const FLOOR_SPOTS: Record<string, RawSpot> = Object.fromEntries(FLOOR.spots.map(s => [s.id, s]))

/** Human-friendly room name for a spot (used in floater status lines). */
const ROOM_PHRASE: Record<string, string> = {
  kitchen: 'in the kitchen', reception: 'by reception', michael: "in Michael's office",
  annex: 'in the annex', stairs: 'by the warehouse stairs', bullpen: 'on the floor',
  conference: 'in the conference room', accounting: 'in accounting', waiting: 'in the waiting area',
  break: 'in the break room', supply: 'in the supply closet',
}
export function roomPhrase(spotId: string): string {
  return ROOM_PHRASE[FLOOR_SPOTS[spotId]?.room ?? ''] ?? 'around the office'
}

export const SCRANTON_ROOM: Room = {
  id: 'scranton-floor',
  name: 'Dunder Mifflin — Scranton',
  description: 'The whole branch: reception, bullpen, Michael\'s office, conference room, kitchen, annex, accounting, warehouse.',
  background: FLOOR.background,
  width: FLOOR.size.width,
  height: FLOOR.size.height,
  furniture: [],
  connections: [],
  agentSpots: FLOOR.spots as AgentSpot[],
  entryPoint: FLOOR.entryPoint,
  waypoints: FLOOR.waypoints,
}

// ---------------------------------------------------------------------------
// Isometric world ↔ map % and grid pathfinding (iso map only)
// ---------------------------------------------------------------------------
export const IS_ISO = FLOOR.style === 'iso' && !!FLOOR.iso && !!FLOOR.grid
const W = FLOOR.size.width, H = FLOOR.size.height
const ISO = FLOOR.iso ?? { ox: 0, oy: 0, tw: 1, th: 1, personBias: 0 }
const GRID = FLOOR.grid ?? { cell: 1, cols: 0, rows: 0, data: '' }
const CELLS = Uint8Array.from(GRID.data, ch => (ch === '1' ? 1 : 0))

export function pctToWorld(x: number, y: number): { u: number; v: number } {
  const a = ((x / 100) * W - ISO.ox) * 2 / ISO.tw   // u + v
  const b = ((y / 100) * H - ISO.oy) * 2 / ISO.th   // v − u
  return { u: (a - b) / 2, v: (a + b) / 2 }
}

export function worldToPct(u: number, v: number): { x: number; y: number } {
  return {
    x: ((ISO.ox + (u + v) * ISO.tw / 2) / W) * 100,
    y: ((ISO.oy + (v - u) * ISO.th / 2) / H) * 100,
  }
}

function cellOk(c: number, r: number): boolean {
  return c >= 0 && r >= 0 && c < GRID.cols && r < GRID.rows && CELLS[r * GRID.cols + c] === 1
}

/** Can a person stand at world (u, v)? */
export function walkable(u: number, v: number): boolean {
  return cellOk(Math.floor(u / GRID.cell), Math.floor(v / GRID.cell))
}

function nearestOpen(c: number, r: number): [number, number] | null {
  if (cellOk(c, r)) return [c, r]
  for (let rad = 1; rad < 12; rad++) {
    let best: [number, number] | null = null, bd = Infinity
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
      if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad || !cellOk(c + dc, r + dr)) continue
      const d = dr * dr + dc * dc
      if (d < bd) { bd = d; best = [c + dc, r + dr] }
    }
    if (best) return best
  }
  return null
}

/** Straight line stays on walkable floor (sampled every ~¼ cell). */
function lineClear(u0: number, v0: number, u1: number, v1: number): boolean {
  const len = Math.hypot(u1 - u0, v1 - v0)
  const n = Math.max(1, Math.ceil(len / (GRID.cell * 0.25)))
  for (let i = 0; i <= n; i++) {
    const t = i / n
    if (!walkable(u0 + (u1 - u0) * t, v0 + (v1 - v0) * t)) return false
  }
  return true
}

/**
 * A* across the 0.5-tile walk grid, then string-pulled into a few straight legs.
 * Returns the intermediate waypoints in map % (the caller walks to the target last).
 */
export function findGridPath(from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number }[] {
  if (!IS_ISO) return []
  const a = pctToWorld(from.x, from.y), b = pctToWorld(to.x, to.y)
  const s = nearestOpen(Math.floor(a.u / GRID.cell), Math.floor(a.v / GRID.cell))
  const g = nearestOpen(Math.floor(b.u / GRID.cell), Math.floor(b.v / GRID.cell))
  if (!s || !g) return []
  const C = GRID.cols, N = C * GRID.rows
  const start = s[1] * C + s[0], goal = g[1] * C + g[0]
  const gScore = new Float32Array(N).fill(Infinity)
  const came = new Int32Array(N).fill(-1)
  const closed = new Uint8Array(N)
  // binary heap of [f, idx]
  const heap: number[] = []
  const fs: number[] = []
  const push = (idx: number, f: number) => {
    heap.push(idx); fs.push(f)
    let i = heap.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (fs[p] <= fs[i]) break
      ;[heap[p], heap[i]] = [heap[i], heap[p]]; [fs[p], fs[i]] = [fs[i], fs[p]]; i = p
    }
  }
  const pop = (): number => {
    const top = heap[0]
    const lastI = heap.pop()!, lastF = fs.pop()!
    if (heap.length) {
      heap[0] = lastI; fs[0] = lastF
      let i = 0
      for (;;) {
        const l = i * 2 + 1, r = l + 1
        let m = i
        if (l < heap.length && fs[l] < fs[m]) m = l
        if (r < heap.length && fs[r] < fs[m]) m = r
        if (m === i) break
        ;[heap[m], heap[i]] = [heap[i], heap[m]]; [fs[m], fs[i]] = [fs[i], fs[m]]; i = m
      }
    }
    return top
  }
  const h = (idx: number) => {
    const dx = Math.abs((idx % C) - g[0]), dy = Math.abs(Math.floor(idx / C) - g[1])
    return Math.max(dx, dy) + 0.414 * Math.min(dx, dy)
  }
  gScore[start] = 0
  push(start, h(start))
  let found = false
  while (heap.length) {
    const cur = pop()
    if (cur === goal) { found = true; break }
    if (closed[cur]) continue
    closed[cur] = 1
    const cc = cur % C, cr = Math.floor(cur / C)
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue
      const nc = cc + dc, nr = cr + dr
      if (!cellOk(nc, nr)) continue
      if (dr && dc && (!cellOk(cc + dc, cr) || !cellOk(cc, cr + dr))) continue // no corner cutting
      const ni = nr * C + nc
      const ng = gScore[cur] + (dr && dc ? 1.414 : 1)
      if (ng < gScore[ni]) { gScore[ni] = ng; came[ni] = cur; push(ni, ng + h(ni)) }
    }
  }
  if (!found) return []
  const cellsPath: { u: number; v: number }[] = []
  for (let i = goal; i !== -1; i = came[i]) {
    cellsPath.push({ u: ((i % C) + 0.5) * GRID.cell, v: (Math.floor(i / C) + 0.5) * GRID.cell })
  }
  cellsPath.reverse()
  // string-pull: from the start, jump to the farthest point we can see
  const pts: { u: number; v: number }[] = []
  let cur = { u: a.u, v: a.v }
  if (!walkable(cur.u, cur.v)) cur = cellsPath[0]
  let i = 0
  const end = { u: b.u, v: b.v }
  const all = [...cellsPath, end]
  while (i < all.length - 1) {
    let j = all.length - 1
    while (j > i + 1 && !lineClear(cur.u, cur.v, all[j].u, all[j].v)) j--
    if (j === all.length - 1) break
    pts.push(all[j]); cur = all[j]; i = j
  }
  return pts.map(p => worldToPct(p.u, p.v))
}

/** Which room (by area) a map-% position is in, or null outside the building. */
export function roomAt(x: number, y: number): string | null {
  if (!IS_ISO || !FLOOR.rooms) return null
  const { u, v } = pctToWorld(x, y)
  for (const r of FLOOR.rooms) {
    for (const [u0, v0, u1, v1] of r.rects) if (u >= u0 && u <= u1 && v >= v0 && v <= v1) return r.id
  }
  return null
}

/** Sprite that faces from one map-% point toward another.
 *  Cast sprites are named from the character's view: front-left faces screen down-right,
 *  front-right faces down-left, rear-left faces up-left, rear-right faces up-right. */
export function facingToward(dx: number, dy: number): 'front-left' | 'front-right' | 'rear-left' | 'rear-right' {
  if (dy >= 0) return dx >= 0 ? 'front-left' : 'front-right'
  return dx >= 0 ? 'rear-right' : 'rear-left'
}

/** Spots with a chair / couch / stool — people sit down when they're settled there. */
const SIT_SPOTS = FLOOR.spots.filter(s => s.sit && s.u !== undefined && s.v !== undefined)

/** The seat at a map-% position (within ~⅓ tile), if any. */
export function seatAt(x: number, y: number, within = 0.35): RawSpot | null {
  if (!IS_ISO) return null
  const { u, v } = pctToWorld(x, y)
  let best: RawSpot | null = null, bd = within
  for (const s of SIT_SPOTS) {
    const d = Math.hypot(s.u! - u, s.v! - v)
    if (d <= bd) { bd = d; best = s }
  }
  return best
}

/** Nearest spot a person can stand on (map %), searching up to `radius` tiles; null if none. */
export function nearestWalkable(x: number, y: number, radius = 3): { x: number; y: number } | null {
  const w = pctToWorld(x, y)
  if (walkable(w.u, w.v)) return { x, y }
  let best: { u: number; v: number } | null = null, bd = Infinity
  for (let du = -radius; du <= radius; du += 0.25) for (let dv = -radius; dv <= radius; dv += 0.25) {
    const d = du * du + dv * dv
    if (d < bd && walkable(w.u + du, w.v + dv)) { bd = d; best = { u: w.u + du, v: w.v + dv } }
  }
  return best ? worldToPct(best.u, best.v) : null
}
