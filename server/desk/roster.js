/** roster.js — loads firm/roster.json and desk.config.json (shared by server + scripts). */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const PROJECT_DIR = join(__dirname, '..', '..')
const FIRM_DIR = join(PROJECT_DIR, 'firm')

export const ROSTER = JSON.parse(readFileSync(join(FIRM_DIR, 'roster.json'), 'utf8'))
export const FIRM = ROSTER.firm

const bySlug = new Map(ROSTER.employees.map(e => [e.slug, e]))
const byRole = new Map(ROSTER.employees.map(e => [e.role, e]))
const deptById = new Map(ROSTER.departments.map(d => [d.id, d]))

export const emp = slug => bySlug.get(slug)
export const empByRole = role => byRole.get(role)
export const dept = id => deptById.get(id)

const DEFAULT_CONFIG = {
  llm: 'claude',            // 'claude' (Claude Code CLI) | 'offline' (templates only)
  model: '',                // e.g. 'sonnet' — passed to `claude --model` when set
  liveResearch: false,      // let analysts use WebSearch/WebFetch (slower, costs more tokens)
  marketData: 'yahoo',      // 'yahoo' (1y daily history, best-effort) | 'off'
  concurrency: 3,           // analysts working at once
  timeoutSec: 150,          // per-agent LLM timeout
  paceMs: 2200,             // gap between chat lines so humans can read along
}

export function loadDeskConfig() {
  const p = join(FIRM_DIR, 'desk.config.json')
  let user = {}
  if (existsSync(p)) {
    try { user = JSON.parse(readFileSync(p, 'utf8')) } catch (e) { console.warn('[desk] bad desk.config.json:', e.message) }
  }
  const cfg = { ...DEFAULT_CONFIG, ...user }
  if (process.env.DESK_LLM) cfg.llm = process.env.DESK_LLM
  if (process.env.DESK_MARKET_DATA) cfg.marketData = process.env.DESK_MARKET_DATA
  if (process.env.DESK_PACE_MS) cfg.paceMs = Number(process.env.DESK_PACE_MS)
  return cfg
}
