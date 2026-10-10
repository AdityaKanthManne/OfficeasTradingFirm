/**
 * theme.ts — Dunder Mifflin Capital theme pack (characters, rooms, chatter, names, props).
 *
 * The Scranton branch is now a boutique trading firm. Every firm role in
 * firm/roster.json has a fixed cast member (Dwight runs Risk, Oscar runs
 * Research, Kevin does P&L…). Generic Claude Code agents (debugger, reviewer…)
 * are dealt the remaining characters at random.
 */

import { useSyncExternalStore } from 'react'
import { FIRM_CASTING, PIPELINE_SLUGS } from './firm'

export type ThemeName = 'default' | 'office'

// Why: 27 Office characters — shuffle-dealt to roles. Sprites live at
// /sprites/office/characters/{slug}-{front|rear}-{left|right}.png
const OFFICE_CHARACTERS = [
  'andy-bernard', 'angela-martin', 'bob-vance', 'carol-stills',
  'creed-bratton', 'darryl-philbin', 'david-wallace', 'dwight-schrute',
  'erin-hannon', 'gabe-lewis', 'holly-flax', 'jan-levinson',
  'jim-halpert', 'karen-filippelli', 'kelly-kapoor', 'kevin-malone',
  'meredith-palmer', 'michael-scott', 'nellie-bertram', 'oscar-martinez',
  'pam-beesly', 'phyllis-vance', 'robert-california', 'roy-anderson',
  'ryan-howard', 'stanley-hudson', 'toby-flenderson',
] as const

const OFFICE_CATS = [
  'cat-bandit', 'cat-bandits-kittens', 'cat-comstock', 'cat-comstock-alt',
  'cat-ember', 'cat-garbage', 'cat-mr-ash', 'cat-mr-ash-alt',
  'cat-phillip', 'cat-princess-lady', 'cat-princess-lady-alt', 'cat-sprinkles',
]

// Fixed casting by role — same character used for Slack avatar AND room sprite.
// boss → Michael (Managing Partner), assistant → Jim (Execution), plus every desk role.
const FIXED_ROLE_CASTING: Record<string, string> = {
  ...FIRM_CASTING,
  boss: 'michael-scott',
  assistant: 'jim-halpert',
}

interface ThemeState {
  name: ThemeName
  // Role → Office character slug. Keyed by role so SlackChat (role) and
  // Character.tsx (agent.role) resolve to the same cast.
  castByRole: Record<string, string>
  angelaRole: string | null
  angelaCat: string | null
}

let state: ThemeState = loadInitial()
const listeners = new Set<() => void>()

function loadInitial(): ThemeState {
  // Why: this fork IS the trading firm — the Dunder Mifflin Capital floor is the default.
  // Users who toggled it off (/the-office) keep 'default'.
  try {
    const saved = localStorage.getItem('agent-office-theme')
    if (saved === 'default') {
      return { name: 'default', castByRole: {}, angelaRole: null, angelaCat: null }
    }
  } catch {}
  return { name: 'office', castByRole: {}, angelaRole: null, angelaCat: null }
}

function persist() {
  try { localStorage.setItem('agent-office-theme', state.name) } catch {}
}

function emit() { listeners.forEach(l => l()) }

function shuffle<T>(arr: readonly T[]): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a as T[]
}
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)] }

export function getTheme(): ThemeName { return state.name }

export function setTheme(name: ThemeName) {
  if (state.name === name) return
  state = { name, castByRole: {}, angelaRole: null, angelaCat: null }
  persist()
  emit()
}

export function toggleTheme() {
  setTheme(state.name === 'office' ? 'default' : 'office')
}

export function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useTheme(): ThemeName {
  return useSyncExternalStore(
    (cb) => subscribeTheme(cb),
    () => state.name,
    () => 'default',
  )
}

function dealt(): Set<string> { return new Set(Object.values(state.castByRole)) }

/** Assign (or return existing) Office character for a role. Same for SlackChat & Character. */
export function getCharacterBaseForRole(role: string, defaultBase: string): string {
  if (state.name !== 'office') return defaultBase
  if (state.castByRole[role]) return state.castByRole[role]

  // Fixed casting wins. If a random dev agent was holding this character, re-deal them.
  const fixed = FIXED_ROLE_CASTING[role]
  if (fixed) {
    const holder = Object.keys(state.castByRole).find(r => state.castByRole[r] === fixed && !FIXED_ROLE_CASTING[r])
    state.castByRole[role] = fixed
    if (holder) {
      delete state.castByRole[holder]
      getCharacterBaseForRole(holder, defaultBase)
      // Why: this can run during render (sprite lookup) — notify subscribers after the render pass
      queueMicrotask(emit)
    }
    if (fixed === 'angela-martin') { state.angelaRole = role; state.angelaCat = pick(OFFICE_CATS) }
    return fixed
  }

  // Random roles: prefer characters who aren't on the trading desk pipeline and aren't on screen.
  const used = dealt()
  const free = OFFICE_CHARACTERS.filter(c => !used.has(c) && c !== 'michael-scott' && c !== 'jim-halpert')
  const offDesk = free.filter(c => !PIPELINE_SLUGS.has(c))
  const nonFixedUsed = [...used].filter(c => c !== 'michael-scott' && c !== 'jim-halpert')
  const chosen = offDesk.length > 0
    ? pick(offDesk as string[])
    : free.length > 0
      ? pick(free as string[])
      : (nonFixedUsed.length > 0 ? pick(nonFixedUsed) : OFFICE_CHARACTERS[2]) // Why: [2] is not Michael/Jim
  state.castByRole[role] = chosen

  if (chosen === 'angela-martin') {
    state.angelaRole = role
    state.angelaCat = pick(OFFICE_CATS)
  }
  return chosen
}

export function getSpriteDir(): string {
  return state.name === 'office' ? '/sprites/office/characters' : '/sprites/characters'
}

/** Kept signature-compatible for existing callers — agentId ignored; role is the key. */
export function getSpritePath(_agentId: string, role: string, defaultBase: string, direction: string): string {
  const base = getCharacterBaseForRole(role, defaultBase)
  return `${getSpriteDir()}/${base}-${direction}.png`
}

export function getRoomImage(phase: 'day' | 'night'): string {
  if (state.name === 'office') {
    return phase === 'night' ? '/rooms/office-night-dm.png' : '/rooms/office-day-dm.png'
  }
  return phase === 'night' ? '/rooms/office-night.png' : '/rooms/office-day.png'
}

/** Returns the ROLE currently cast as Angela (if any), plus cat sprite path. */
export function getAngelaCat(): { role: string; catSprite: string } | null {
  if (state.name !== 'office' || !state.angelaRole || !state.angelaCat) return null
  return { role: state.angelaRole, catSprite: `/sprites/office/cats/${state.angelaCat}.png` }
}

/** Human-readable display name for a slug (e.g. "michael-scott" → "Michael Scott") */
function slugToName(slug: string): string {
  return slug.split('-').map(p => p[0].toUpperCase() + p.slice(1)).join(' ')
}

/** Swap sender display name to the cast Office character when theme is active. */
export function themedDisplayName(role: string, fallback: string): string {
  if (state.name !== 'office') return fallback
  const cast = state.castByRole[role]
  if (!cast) {
    // Force-assign so the name matches the avatar on first render
    const base = getCharacterBaseForRole(role, '')
    return slugToName(base)
  }
  return slugToName(cast)
}

// ===== THEMED CHATTER POOLS =====

const OFFICE_SPAWN = [
  'Dunder Mifflin Capital, reporting to the floor',
  'Bears. Beets. Bear markets.',
  'market open. let\'s make some paper. the money kind.',
  'Identity theft is not a joke, Jim! Neither is insider trading.',
  'clocked in — pre-market prep',
  'I am Beyoncé, always. Long Beyoncé.',
  'opening the terminal',
]
const OFFICE_WORK = [
  'pricing the book',
  'running the risk numbers',
  'FACT: volatility is up',
  'Schrute bucks marked to market',
  'negotiating with the Investment Committee',
  'filing trade confirms',
  'Finer Things Club equity research',
  'reconciling positions with Kevin (pray for me)',
]
const OFFICE_DONE = [
  "that's what she said",
  'boom. rebalanced.',
  'trade settled T+1',
  "World's Best Managing Partner approves",
  'closed the position',
  'filled at the limit — Jim-approved',
]
const OFFICE_COFFEE = [
  'grande latte from Jim before the open',
  "Kevin's famous chili, post-close",
  'pretzel day!',
  'brb, break room — markets are boring',
]
const OFFICE_WATER = [
  'hydration — Angela says water only',
  "Stanley says it's almost 5 (the close is at 4)",
  'filling up, then checking the tape',
  'break room run',
]

const DEFAULT_SPAWN = [
  'reporting for duty!', 'clocked in', 'ready to ship',
  'coffee first, then code', "let's do this", 'opening vim...', 'pulling latest main',
]
const DEFAULT_WORK = [
  'on it', 'typing furiously', 'in the zone', 'making progress',
  'checking the docs', 'git blame time', 'stack overflow to the rescue',
]
const DEFAULT_DONE = [
  'task complete!', 'shipped it', 'PR opened', 'done and dusted',
  'LGTM', 'merged to main', 'deployed',
]
const DEFAULT_COFFEE = ['brb, coffee', 'need caffeine', 'grabbing a cup', 'coffee run']
const DEFAULT_WATER = [
  'stay hydrated', 'h2o break', 'water run', 'refilling bottle',
  'hydration check', 'quick water break',
]

export function themedSpawn(): string  { return pick(state.name === 'office' ? OFFICE_SPAWN  : DEFAULT_SPAWN) }
export function themedWork(): string   { return pick(state.name === 'office' ? OFFICE_WORK   : DEFAULT_WORK) }
export function themedDone(): string   { return pick(state.name === 'office' ? OFFICE_DONE   : DEFAULT_DONE) }
export function themedCoffee(): string { return pick(state.name === 'office' ? OFFICE_COFFEE : DEFAULT_COFFEE) }
export function themedWater(): string  { return pick(state.name === 'office' ? OFFICE_WATER  : DEFAULT_WATER) }

// ===== SIM / VIDEO MODE OFFICE SCRIPT =====
// Parallel tool-output messages keyed by role — used when ?sim or ?video loads with Office theme.
export const OFFICE_SIM_TOOL_MESSAGES: Record<string, string[]> = {
  'security-auditor': [
    '⚡ auditing trade-system access — Dwight has root again',
    '⚠️ someone stored the broker API key in a sticky note on the beet cellar door',
    '🚨 order router allows unlimited size — classic Ryan',
    'locking it down before Toby finds out',
  ],
  'code-reviewer': [
    '⚡ running: grep -r "that\'s what she said" src/',
    '🔍 reviewing — this risk model has more drama than the Dundies',
    '💡 position limits belong in config, not in Michael\'s head',
    'lgtm, ship it to the Stamford desk',
  ],
  'frontend-developer': [
    '⚡ editing src/desk/TickerTape.tsx',
    '🎨 new client report looks better than Phyllis\'s wedding',
    'P&L chart is green. mostly. let\'s not zoom out.',
    'responsive on mobile — even Stanley approves',
  ],
  'assistant': [
    'the trade printer jammed again. Sabre strikes.',
    'someone check on Michael, he\'s shorting the dollar "for fun"',
    "I'll handle the execution — identity theft is not a joke",
  ],
  'boss': [
    'pizza on the trading floor! it\'s pretzel day!',
    'anyone want a Red Bull? or a Schrute Buck?',
    'buy high, sell higher. PARKOUR!',
    'how are we looking on the P&L?',
  ],
}

/** Sim replacement for Antony's typed questions, when theme is Office */
export const OFFICE_SIM_BOSS_PROMPTS = [
  '/ultra-think audit our trading-system access like Dwight auditing the beet farm',
  'how bad is the order-router issue — worse than Kevin dropping the chili?',
]

// ===== Rotation helpers for the Office ?sim rotation =====

export function getAllOfficeCharacters(): readonly string[] { return OFFICE_CHARACTERS }

/** Force a specific role → character mapping (used by sim rotation). */
export function assignCharacterToRole(role: string, slug: string) {
  state.castByRole[role] = slug
  if (slug === 'angela-martin') {
    state.angelaRole = role
    state.angelaCat = pick(OFFICE_CATS)
  }
  emit()
}

/** Release a role's cast slot so another role can use that character later. */
export function releaseRole(role: string) {
  const slug = state.castByRole[role]
  if (!slug) return
  delete state.castByRole[role]
  if (state.angelaRole === role) {
    state.angelaRole = null
    state.angelaCat = null
  }
  emit()
}

/** Return the set of character slugs currently on-screen (dealt to some role). */
export function getActiveCastSlugs(): Set<string> {
  return new Set(Object.values(state.castByRole))
}

/**
 * Pick the next unused Office character — cycles fairly through all 22 over time.
 * @param ignoreSet  extra slugs to avoid (e.g. just-used)
 */
export function nextUnusedOfficeCharacter(ignoreSet: Set<string> = new Set()): string {
  const used = getActiveCastSlugs()
  const avail = OFFICE_CHARACTERS.filter(c => !used.has(c) && !ignoreSet.has(c))
  if (avail.length > 0) return pick(avail as string[])
  // All 22 on-screen: pick any not in the ignore set
  const fallback = OFFICE_CHARACTERS.filter(c => !ignoreSet.has(c))
  return fallback.length > 0 ? pick(fallback as string[]) : OFFICE_CHARACTERS[0]
}

/** Display name for a slug — used when renaming sim staff on spawn. */
export function displayNameFromSlug(slug: string): string {
  return slug.split('-').map(p => p[0].toUpperCase() + p.slice(1)).join(' ')
}

// Character-specific prop overlays — replace the energy-drink bubble above cast members.
// Why: visual easter eggs tying props to iconic bits. Each slug maps to a pool
// of signature props — when there's more than one, a deterministic hash picks
// per-role so the same agent keeps the same prop within a session.
const PROP = (f: string) => `/sprites/office/props/${f}.png`
const OFFICE_PROPS_BY_SLUG: Record<string, string[]> = {
  // Managing Partner — the classics, plus his bull market
  'michael-scott':   [PROP('worlds-best-boss-mug'), PROP('dundie-award'), PROP('golden-ticket-box'), PROP('prison-mike'), PROP('no-god-please-no'), PROP('bull-market')],
  // Risk: Bears. Beets. Bear markets.
  'dwight-schrute':  [PROP('bear-market'), PROP('schrute-buck'), PROP('cpr-dummy-mask')],
  // Execution: trade tickets (and a stapler in jello)
  'jim-halpert':     [PROP('trade-ticket'), PROP('jello-stapler')],
  // Income: pretzels and coupons
  'stanley-hudson':  [PROP('bond-certificate'), PROP('pretzel-day')],
  'jan-levinson':    [PROP('serenity-by-jan-candle')],
  // Research / reporting / compliance — Finer Things Club members keep their prop
  'oscar-martinez':  [PROP('candlestick-chart'), PROP('finer-things-club')],
  'pam-beesly':      [PROP('client-report'), PROP('finer-things-club')],
  'toby-flenderson': [PROP('compliance-stamp'), PROP('finer-things-club')],
  'holly-flax':      [PROP('compliance-stamp')],
  'kevin-malone':    [PROP('calculator-keleven')],
  'ryan-howard':     [PROP('wuphf-coin')],
  'meredith-palmer': [PROP('gold-bar')],
  'karen-filippelli':[PROP('candlestick-chart')],
  'gabe-lewis':      [PROP('ticker-terminal')],
  'darryl-philbin':  [PROP('ticker-terminal')],
  'creed-bratton':   [PROP('dunder-mifflin-paper-box')], // "I still sell paper on the side."
  'david-wallace':   [PROP('dunder-mifflin-capital-logo')],
  'robert-california': [PROP('bull-market')],
  // Angela: randomized second cat assigned per-role below — not a prop file.
}

// Why: generic fallback for remaining cast so every Office character has a prop.
const OFFICE_GENERIC_PROPS = [
  PROP('dunder-mifflin-capital-logo'),
  PROP('ticker-terminal'),
  PROP('schrute-buck'),
  PROP('golden-ticket-box'),
]

const OFFICE_CATS_PATHS = OFFICE_CATS.map(c => `/sprites/office/cats/${c}.png`)

// Stable per-role generic prop / head-cat assignment — deterministic hash so it doesn't flicker.
function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** Prop sprite override for a given role's cast, or null to fall back to energy drink. */
export function getOfficePropForRole(role: string): string | null {
  if (state.name !== 'office') return null
  const slug = state.castByRole[role]
  if (!slug) return null

  // Angela: show a different cat above her head (head-cat, separate from her follower cat)
  if (slug === 'angela-martin') {
    const idx = hashString(role + 'head') % OFFICE_CATS_PATHS.length
    return OFFICE_CATS_PATHS[idx]
  }

  const specificPool = OFFICE_PROPS_BY_SLUG[slug]
  if (specificPool && specificPool.length > 0) {
    // Why: hash by role + slug so each cast member keeps a stable prop pick
    return specificPool[hashString(role + slug) % specificPool.length]
  }

  // Generic fallback: firm logo / terminal / Schrute buck / golden ticket, deterministic per slug
  return OFFICE_GENERIC_PROPS[hashString(slug) % OFFICE_GENERIC_PROPS.length]
}
