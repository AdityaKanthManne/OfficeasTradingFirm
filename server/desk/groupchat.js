/**
 * groupchat.js — when Michael asks something in #trading-floor, the people
 * whose field it is answer, in character, from their field.
 *
 *  "how is apple doing today"   → Oscar (quant: price & trend), Kelly (sentiment), Dwight (risk)…
 *  "Dwight, how risky is TSLA?" → Dwight (named people always answer)
 *  "what's the Fed going to do" → Jan (macro)
 *
 * Tickers are spotted in plain English ("apple", "$NVDA", "bitcoin"), priced
 * with Alpha Vantage (cached; Yahoo as backup), and handed to whoever answers.
 * Replies come from the Claude Code CLI when the desk LLM is on, otherwise from
 * built-in lines in each character's voice. The chat's "AI On/Off" switch
 * turns staff answers on and off.
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { ROSTER, emp, loadDeskConfig, FIRM } from './roster.js'
import { personaBlock } from './prompts.js'
import { claudeAvailable, runClaude } from './llm.js'
import { classify, tickersInText } from './classify.js'
import { avQuote } from './alphavantage.js'
import { snapshot } from './briefing.js'
import { offlineReply, bookContext } from './talk.js'

const POLL_STATE = join(homedir(), '.agent-office', 'chat-poll-state')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pick = a => a[Math.floor(Math.random() * a.length)]
const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%`)
const pctAbs = (x, d = 0) => (x == null || !Number.isFinite(x) ? '—' : `${(Math.abs(x) * 100).toFixed(d)}%`)

/** who answers what — word patterns per person (weights add up) */
const FIELDS = [
  ['oscar-martinez', /\b(trend|momentum|chart|technical|quant|data|model|valuation|fundamental|performance|outlook)\b/, 2],
  ['karen-filippelli', /\b(earnings|valuation|analyst|rating|target|guidance|revenue|eps|research|overvalued|undervalued)\b/, 2],
  ['dwight-schrute', /\b(risk|risky|volatil\w*|vol|drawdown|crash|hedge|downside|safe|danger|stop|var|beta|bear)\b/, 3],
  ['jim-halpert', /\b(buy|sell|trade|order|execute|entry|exit|size|position|limit|should we|add|trim)\b/, 2],
  ['stanley-hudson', /\b(dividends?|yield|income|bonds?|coupon|fixed income|duration)\b/, 3],
  ['kelly-kapoor', /\b(sentiment|twitter|reddit|social|hype|buzz|news|saying|meme|retail|vibes?|popular)\b/, 3],
  ['ryan-howard', /\b(crypto|bitcoin|btc|eth|ethereum|token|blockchain|algo|algorithm|defi|coin|wuphf)\b/, 3],
  ['meredith-palmer', /\b(oil|gold|silver|commodit\w*|copper|wheat|corn|energy|crude|natural gas)\b/, 3],
  ['carol-stills', /\b(real estate|reits?|property|housing|mortgage|real assets)\b/, 3],
  ['jan-levinson', /\b(macro|fed|rates?|inflation|cpi|economy|recession|gdp|jobs|treasur\w*|yields)\b/, 3],
  ['kevin-malone', /\b(p&l|pnl|profit|loss|made|lost|how much|money)\b/, 2],
  ['angela-martin', /\b(mandate|limits?|reconcil\w*|controller|budget|books|accounting|concentration)\b/, 3],
  ['toby-flenderson', /\b(compliance|legal|allowed|insider|regulat\w*|sec|rules?|advice)\b/, 3],
  ['holly-flax', /\b(training|conduct|culture|morale|team)\b/, 2],
  ['pam-beesly', /\b(report|deck|presentation|summary|one-pager|client update)\b/, 3],
  ['andy-bernard', /\b(clients?|pitch|coverage|lps?|investors?|capital intro\w*)\b/, 2],
  ['phyllis-vance', /\b(retire\w*|wealth|family|conservative|grandkids|private)\b/, 2],
  ['darryl-philbin', /\b(settle\w*|operations|ops|t\+1|clearing|warehouse)\b/, 3],
  ['roy-anderson', /\b(paperwork|settlement clerk)\b/, 2],
  ['gabe-lewis', /\b(systems?|oms|platform|api|tech|software|routing|sabre)\b/, 2],
  ['erin-hannon', /\b(order intake|ticket|log the order)\b/, 2],
  ['nellie-bertram', /\b(esg|climate|sustainab\w*|themes?|thematic|green)\b/, 3],
  ['creed-bratton', /\b(special situations?|distressed|mergers?|acquisitions?|deals?|rumou?rs?)\b/, 2],
  ['robert-california', /\b(strategy|conviction|big picture|long term|cio|philosophy)\b/, 2],
  ['david-wallace', /\b(board|firm|corporate|shareholders)\b/, 2],
  ['bob-vance', /\b(refrigeration|anchor|lp)\b/, 2],
]

const CLASS_BONUS = {
  equity: [['oscar-martinez', 2], ['kelly-kapoor', 1], ['dwight-schrute', 1]],
  crypto: [['ryan-howard', 3], ['dwight-schrute', 1]],
  commodity: [['meredith-palmer', 3], ['jan-levinson', 1]],
  bond: [['stanley-hudson', 3], ['jan-levinson', 1]],
  realestate: [['carol-stills', 3], ['stanley-hudson', 1]],
}

const FIRST_NAMES = new Map(ROSTER.employees.filter(e => e.role !== 'boss').map(e => [e.name.split(' ')[0].toLowerCase(), e.slug]))

function chooseResponders(text, tickers) {
  const low = text.toLowerCase()
  // named people always answer ("Dwight, …", "@kelly …", "Jim and Oscar — …")
  const named = []
  for (const [first, slug] of FIRST_NAMES) {
    if (new RegExp(`(^|[^a-z@])@?${first}\\b`).test(low) && !named.includes(slug)) named.push(slug)
  }
  if (named.length) return named.slice(0, 3)
  const score = new Map()
  const bump = (slug, w) => score.set(slug, (score.get(slug) ?? 0) + w)
  for (const [slug, re, w] of FIELDS) if (re.test(low)) bump(slug, w)
  for (const e of ROSTER.employees) for (const k of e.keywords ?? []) if (k.length > 3 && low.includes(k)) bump(e.slug, 1)
  for (const t of tickers) for (const [slug, w] of CLASS_BONUS[classify(t).cls] ?? []) bump(slug, w)
  // "how's apple doing today" — price questions go to the numbers people
  if (tickers.length && /\b(price|doing|today|how is|how's|now|up|down|moving)\b/.test(low)) { bump('oscar-martinez', 2); bump('kelly-kapoor', 1) }
  score.delete('michael-scott')
  const min = tickers.length ? 1 : 2
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).filter(([, s]) => s >= min).map(([slug]) => slug)
  if (!ranked.length) return ['jim-halpert']                       // nobody's field → Jim, the coordinator
  return ranked.slice(0, tickers.length ? 3 : 2)
}

// ---------------------------------------------------------------------------
// Market data for the answer
// ---------------------------------------------------------------------------
export async function gather(tickers, marketOpen = true) {
  const cfg = loadDeskConfig()
  const out = []
  for (const t of tickers) {
    const [q, s] = await Promise.all([
      avQuote(t, { marketOpen }).catch(() => null),
      cfg.marketData === 'off' ? null : snapshot(t, cfg).catch(() => null),
    ])
    out.push({ t: classify(t).ticker, name: classify(t).name, q, s })
  }
  return out
}

export function dataText(d) {
  if (!d.length) return ''
  return d.map(({ t, name, q, s }) => {
    const parts = [`${t} (${name})`]
    if (q?.price) parts.push(`live price ${q.price.toFixed(2)}${q.changePct != null ? `, ${pct(q.changePct)} today (${q.change > 0 ? '+' : ''}${q.change?.toFixed(2)})` : ''}${q.high ? `, range ${q.low?.toFixed(2)}–${q.high?.toFixed(2)}` : ''}${q.day ? `, as of ${q.day}` : ''}`)
    else if (s?.px) parts.push(`last close ${s.px.toFixed(2)}`)
    else parts.push('no live price available')
    if (s?.source === 'historical') parts.push(`${s.span ?? 'period'} return ${pct(s.r1y)}, 3-month ${pct(s.r3m)}, vol ${pctAbs(s.vol)}, max drawdown ${pct(s.mdd)}, beta ${s.beta?.toFixed(2)}, ${s.above200 ? 'above' : 'below'} its ${s.span === '1-year' ? '200-day' : 'long-term'} average, ${pctAbs(s.offHigh)} below its high`)
    else if (s) parts.push(`model estimates: vol ≈ ${pctAbs(s.vol)}, beta ≈ ${s.beta?.toFixed(2)}`)
    return parts.join('; ')
  }).join('\n')
}

// ---------------------------------------------------------------------------
// Built-in answers (no LLM), from each person's field
// ---------------------------------------------------------------------------
export function offlineAnswer(e, text, data) {
  const d = data[0]
  if (!d) return offlineReply(e, text, { preferJob: true })
  const { t: T, q, s } = d
  const chg = q?.changePct
  const priceStr = q?.price ? `${T} is at $${q.price.toFixed(2)}${chg != null ? ` (${pct(chg)} today)` : ''}`
    : s?.px ? `${T} last closed at $${s.px.toFixed(2)}` : `I can't get a live price on ${T} right now`
  const up = (chg ?? s?.r3m ?? 0) > 0
  const hot = (s?.vol ?? 0) > 0.3
  const lines = {
    'oscar-martinez': () => `Actually, ${priceStr}.${s?.source === 'historical' ? ` It's ${s.above200 ? 'above' : 'below'} its ${s.span === '1-year' ? '200-day' : 'long-term'} average and ${pct(s.r3m)} over three months — ${s.above200 && s.r3m > 0 ? 'the trend is intact' : !s.above200 && s.r3m < 0 ? 'the trend is broken' : 'mixed signals'}.` : ' I need more history before I call a trend.'}`,
    'dwight-schrute': () => `FACT: ${chg != null ? `${T} moved ${pct(chg)} today.` : priceStr + '.'}${s?.vol ? ` Annualised vol ${pctAbs(s.vol)}${s.mdd != null ? `, max drawdown ${pct(s.mdd)}` : ''}.` : ''} ${hot ? 'I have alerted the bears.' : 'Acceptable. For now.'}`,
    'jim-halpert': () => `${priceStr}. If we want in, I'd work a limit order${q?.price ? ` around ${(q.price * 0.995).toFixed(2)}` : ''} and scale in. *looks at camera*`,
    'kelly-kapoor': () => (chg ?? 0) > 0.015 ? `Oh my God, everyone online is losing it about ${T}. It's up ${pct(chg)}! That's like, a lot of hype.`
      : (chg ?? 0) < -0.015 ? `People are being SO mean about ${T} online. It's down ${pct(chg)}. Honestly? That's when you buy. I read that.`
        : `The vibes on ${T} are... fine? ${priceStr}. Nobody's even fighting about it.`,
    'karen-filippelli': () => `${priceStr}.${s?.offHigh != null ? ` That's ${pctAbs(s.offHigh)} off the high.` : ''} I'd want the next earnings print before I change my rating.`,
    'kevin-malone': () => q?.change != null ? `${T} is ${q.change >= 0 ? 'up' : 'down'} $${Math.abs(q.change).toFixed(2)} a share today. ${q.change >= 0 ? 'That is like, a sandwich.' : 'That is... less sandwich.'}` : `${priceStr}. Keleven says that's a number.`,
    'stanley-hudson': () => `${priceStr}. Does it pay me? ${classify(T).cls === 'bond' ? 'Yes. Finally.' : 'Barely. Wake me when it\'s a dividend.'}`,
    'ryan-howard': () => classify(T).cls === 'crypto' ? `${priceStr}. Crypto never sleeps. Unlike Stanley.` : `${priceStr}. Very legacy. We should tokenize it.`,
    'meredith-palmer': () => `${priceStr}. Commodities don't lie. People do.`,
    'jan-levinson': () => `${priceStr}.${s?.beta ? ` With beta ${s.beta.toFixed(2)}, that's a macro trade — watch rates.` : ' Watch the Fed.'}`,
    'toby-flenderson': () => `Just a reminder, this isn't investment advice. But ${priceStr.charAt(0).toLowerCase() + priceStr.slice(1)}.`,
    'pam-beesly': () => `${priceStr}. Want me to put it in the client update?`,
    'andy-bernard': () => `${priceStr}! Clients are gonna ${up ? 'love' : 'hate'} this. Either way, I'll call them. With a song.`,
    'carol-stills': () => `${priceStr}. Not real estate, but I'll allow it.`,
    'angela-martin': () => `${priceStr}. If we own it, it's under the single-name limit. I checked. Twice.`,
    'phyllis-vance': () => `${priceStr}. For my retirees, ${hot ? "that's a bit much excitement, dear." : 'that seems sensible.'}`,
    'creed-bratton': () => `${priceStr}. I've owned it since before it existed.`,
    'nellie-bertram': () => `${priceStr}. Thematically, I've decided that's wonderful.`,
    'robert-california': () => `${priceStr}. The question isn't price. It's desire.`,
    'darryl-philbin': () => `${priceStr}. Whatever we do, it settles T+1, Mike.`,
    'gabe-lewis': () => `${priceStr}. The OMS can route it. Please don't touch the settings.`,
  }
  return (lines[e.slug] ?? (() => `${priceStr}. ${pick(e.catchphrases ?? [''])}`.trim()))()
}

// ---------------------------------------------------------------------------

export function createGroupChat({ broadcast, addMessage, marketOpen = () => true }) {
  let busyUntil = 0

  function aiPaused() {
    try { return existsSync(POLL_STATE) && !!JSON.parse(readFileSync(POLL_STATE, 'utf8')).paused } catch { return false }
  }

  async function llmAnswer(e, text, data, others) {
    const cfg = loadDeskConfig()
    if (cfg.llm !== 'claude' || !claudeAvailable()) return null
    const prompt = `${personaBlock(e)}

${bookContext()}
${data.length ? `\nMARKET DATA (use only these numbers; don't invent prices or news):\n${dataText(data)}\n` : ''}
Michael Scott (Managing Partner) just asked the whole firm in the #trading-floor group chat: "${text}"
${others.length ? `Also answering: ${others.join(', ')} — so stick to YOUR field and don't repeat them.` : ''}
Answer from your own job's angle (${e.title}: ${e.deskDuty}), fully in character, like a Slack reply: 1–3 sentences, under 60 words. Be genuinely useful; cite a number when it fits. This is a parody firm — not investment advice. Reply with only your message.`
    try {
      const out = await runClaude(prompt, { model: cfg.model, timeoutSec: 60 })
      return out.replace(/^["']|["']$/g, '').trim() || null
    } catch { return null }
  }

  /** Michael said `text` in the group chat. Returns who's answering. */
  async function answer(text) {
    if (aiPaused() || !text || text.startsWith('/')) return []
    const tickers = tickersInText(text)
    const slugs = chooseResponders(text, tickers)
    const people = slugs.map(emp).filter(Boolean)
    if (!people.length) return []
    ;(async () => {
      broadcast({ type: 'chat_typing', sender: people[0].name })
      const data = tickers.length ? await gather(tickers, marketOpen()) : []
      // ask everyone at once; post in order with a readable gap
      const pending = people.map(e => llmAnswer(e, text, data, people.filter(p => p !== e).map(p => p.name.split(' ')[0]))
        .then(a => a ?? offlineAnswer(e, text, data)))
      for (let i = 0; i < people.length; i++) {
        const e = people[i]
        broadcast({ type: 'chat_typing', sender: e.name })
        const line = await pending[i]
        const wait = Math.max(0, busyUntil - Date.now())
        if (wait) await sleep(wait)
        const msg = addMessage({ sender: e.name, role: e.role, text: String(line).slice(0, 600) })
        broadcast({ type: 'chat_message', ...msg, talk: true })
        busyUntil = Date.now() + 1800
      }
    })().catch(err => console.error('[groupchat]', err))
    return slugs
  }

  return { answer }
}

export { FIRM }
