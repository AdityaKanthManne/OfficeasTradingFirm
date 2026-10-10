/**
 * firm.ts — Dunder Mifflin Capital roster for the frontend.
 * Single source of truth lives in /firm/roster.json (shared with the server + scripts).
 */

import roster from '../firm/roster.json'

export interface FirmEmployee {
  slug: string
  name: string
  role: string
  department: string
  title: string
  short: string
  color: string
  emoji: string
  deskDuty: string
  voice: string
  catchphrases: string[]
  keywords: string[]
  pipeline: boolean
  stage?: string
  conditional?: string
}

export interface FirmDepartment { id: string; name: string; formerly: string; mandate: string }

export const FIRM = roster.firm
export const DEPARTMENTS = roster.departments as FirmDepartment[]
export const EMPLOYEES = roster.employees as FirmEmployee[]

export const EMPLOYEE_BY_ROLE: Record<string, FirmEmployee> = Object.fromEntries(EMPLOYEES.map(e => [e.role, e]))
export const EMPLOYEE_BY_SLUG: Record<string, FirmEmployee> = Object.fromEntries(EMPLOYEES.map(e => [e.slug, e]))

/** role → Office character slug, for every firm role (boss = Michael, assistant = Jim, …) */
export const FIRM_CASTING: Record<string, string> = Object.fromEntries(EMPLOYEES.map(e => [e.role, e.slug]))

/** Characters who sit on the portfolio pipeline — avoid dealing them to random dev agents. */
export const PIPELINE_SLUGS = new Set(EMPLOYEES.filter(e => e.pipeline || e.role === 'boss').map(e => e.slug))

/** AGENT_CONFIGS entries for firm roles (boss/assistant keep their own configs). */
export const FIRM_AGENT_CONFIGS: Record<string, { color: string; emoji: string; title: string }> = Object.fromEntries(
  EMPLOYEES.filter(e => e.role !== 'boss' && e.role !== 'assistant')
    .map(e => [e.role, { color: e.color, emoji: e.emoji, title: e.short }]),
)

export function departmentOf(role: string): FirmDepartment | undefined {
  const e = EMPLOYEE_BY_ROLE[role]
  return e ? DEPARTMENTS.find(d => d.id === e.department) : undefined
}
