/**
 * talk.js — walk-up conversations on the Scranton floor.
 *
 * When Michael (you) walks up to someone they greet you, in character. Until you
 * walk away, whatever you type in the chat box goes to them and they answer as
 * that character — through the Claude Code CLI when the desk LLM is on, otherwise
 * with built-in lines in each character's voice.
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { empByRole, loadDeskConfig, ROSTER } from './roster.js'
import { personaBlock } from './prompts.js'
import { claudeAvailable, runClaude } from './llm.js'
import { tickersInText } from './classify.js'
import { gather, dataText, offlineAnswer } from './groupchat.js'

const LATEST_FILE = join(homedir(), '.agent-office', 'desk-latest.json')
const pick = a => a[Math.floor(Math.random() * a.length)]

/** The latest book on the desk, in a couple of facts we can quote offline. */
function book() {
  try {
    if (!existsSync(LATEST_FILE)) return null
    const d = JSON.parse(readFileSync(LATEST_FILE, 'utf8'))
    const pos = [...(d.positions ?? [])].sort((a, b) => b.weight - a.weight)
    return {
      client: d.client, total: Math.round(d.totalValue ?? 0), top: pos[0], second: pos[1],
      breaches: d.failingChecks ?? [], n: pos.length,
    }
  } catch { return null }
}

export function bookContext() {
  const b = book()
  if (!b) return 'No portfolio has been reviewed yet today.'
  return `Latest book on the desk: ${b.client}, $${b.total.toLocaleString()}, ${b.n} positions, largest ${b.top?.ticker} at ${b.top?.weight}%. ` +
    (b.breaches.length ? `Mandate breaches: ${b.breaches.join('; ')}.` : 'Inside the mandate.')
}

// ---------------------------------------------------------------------------
// Built-in voices (used when the LLM is off or slow)
// ---------------------------------------------------------------------------
const GREET = {
  'dwight-schrute': ['Michael. Assistant to the Managing Partner, reporting. I have run the stress tests. Twice. The second time, angrily.',
    'FACT: you approached my desk at a 45-degree angle. Classic predator move. I respect it.',
    'Question: is this a surprise inspection? Because my drawdown limits are immaculate.'],
  'jim-halpert': ['Hey. *glances at camera* What can I do for you?', "Michael. I was just about to put in a limit order. Or a nap. Whichever's quicker.",
    'Oh hey — Dwight is hedging his beets again. Anyway. What\'s up?'],
  'pam-beesly': ['Hi Michael! Want me to put anything in the client report? I made the charts extra pretty today.', "Oh, hey! The new client deck is almost done. Don't look yet.",
    'Hi! Your 2 o\'clock called. Twice. He sounded... concerned.'],
  'stanley-hudson': ['Did I stutter? The bond ladder is fine.', "Michael, I have a crossword and a 4.2% yield. I don't need anything else from today.",
    "Mm-hmm. If this isn't about pretzels or dividends, I'm going to need you to keep walking."],
  'kevin-malone': ['Hey Michael. I did the P&L. It rounds to... good. Mostly good.', 'Oh hi. I\'m not eating. This is... a calculator snack.',
    'Michael! Keleven says we\'re up. Keleven is never wrong.'],
  'angela-martin': ["Michael. Please don't touch the reconciliation. It's perfect and you'll get fingerprints on it.", "The books balance. Unlike some people's lives.",
    'If this is about the party planning committee budget, the answer is no.'],
  'oscar-martinez': ["Michael, before you say anything — no, the Fed doesn't 'feel' things.", 'Hi. I ran the fundamentals. Actually, the valuations are a little stretched.',
    "Oh good, you're here. I want to explain duration. Slowly."],
  'kelly-kapoor': ['Oh my God, Michael! Have you seen what retail is posting about NVDA? It is SO much drama.', 'Michael! Sentiment is like, totally euphoric. Which is bad. Ryan says that\'s bad.',
    "Hiii. I made a vibe chart. It's just emojis but it's accurate."],
  'ryan-howard': ["Michael. I'm basically disrupting this whole office from in here.", "Hey. Have you heard of WUPHF? It's like a token, but for... everything.",
    "I'm doing a thing with digital assets. You wouldn't get it. That's not an insult. It's a disruption."],
  'andy-bernard': ['Michael! Big Tuna-level coverage today. Also I can sing the client\'s name in four-part harmony.', "Here comes treble! Hey boss. Cornell taught me about markets. Mostly a cappella, though.",
    'Hey hey! The client loved my call. I did an accent. Not sure which.'],
  'creed-bratton': ["Michael. I've been here since the office was a speakeasy. Want to buy a gold bar? Don't ask where.", "Hey. I've got special situations. Very special. Very situations.",
    "I'm not here right now. You're thinking of a different Creed."],
  'meredith-palmer': ['Michael! Commodities are up. So am I. It\'s a good day.', "Hey boss. Oil's volatile, my weekend was volatile. It's all connected.",
    'Oh hi. I was just checking the price of... wine futures. For research.'],
  'phyllis-vance': ['Hi Michael. Bob Vance, Vance Refrigeration, says hello.', "Oh, Michael. I knitted the client a scarf. It's in the portfolio colors.",
    'Hello dear. The private wealth clients love a personal touch. I sent muffins.'],
  'toby-flenderson': ['Hi Michael. I just need you to sign this compliance attestation. It\'s... it\'s three pages.', "Oh. Hi. I'll be quick. Actually I won't, it's compliance.",
    "Michael. Please don't throw anything. I'm just here to talk about conduct training."],
  'darryl-philbin': ["Mike. Settlement's clean. Warehouse is running like a track from my album.", "What's up, Mike. Trades are settled. Unlike you, man.",
    "Hey. Trade ops, T+1, all good. You need something, or you just wandering?"],
  'roy-anderson': ["Hey. Settlements are done. You want to talk about something?", "Yo. We're good down here. Paper's moving."],
  'erin-hannon': ['Hi Michael! I logged the order! I think. Is "buy a lot" an order type?', "Oh! Hi! Are you here to give me a nickname? I'd love a nickname.",
    'Hello! I put your calls in the folder. The folder is a plant. Is that okay?'],
  'gabe-lewis': ["Michael. Corporate sends its regards. And a 40-slide deck on trading systems.", 'Hello. The order management system is... working. Mostly. Please don\'t touch it.'],
  'holly-flax': ["Michael! Hi! I made a conduct training video. It has puppets.", 'Hey you. Compliance can be fun! I brought stickers.'],
  'nellie-bertram': ["Michael, darling. ESG is the future, and I am the future of ESG.", "Hello. I've decided I'm in charge of themes now. All of them."],
  'karen-filippelli': ['Michael. Equity research is done. The numbers are fine. Jim is... somewhere.', "Hey. I've got three buy ratings and zero patience."],
  'david-wallace': ['Michael. Good to see you. How are the numbers? Be honest. Please be honest.', "Hey Michael. I'm just here as chairman. Pretend I'm not here. That never works, does it?"],
  'jan-levinson': ['Michael. I have a meeting in four minutes. Talk.', "Don't. Whatever you're about to say, don't. Unless it's about macro."],
  'robert-california': ["Michael. I see you. I see everything. What does this portfolio want, deep down?", 'Sit. Tell me what you fear. Then tell me your conviction trade.'],
  'bob-vance': ['Bob Vance, Vance Refrigeration. Anchor LP. My capital is cold and ready.', "Michael. Bob Vance. I'll keep it short. How's my money?"],
  'carol-stills': ["Michael. Real assets are holding up. Unlike your timeshare pitch.", "Hi Michael. Property's steady. Let's keep this professional."],
  'michael-scott': ['...Is that a mirror?'],
}

const ACK = {
  'dwight-schrute': ['FACT: {q}? Wrong question. The right question is: what is the downside. And the downside is always bears.', 'Absolutely. I will handle it personally. With a crossbow, if necessary.',
    'Question: why are you asking me instead of telling me? Never mind. Done.'],
  'jim-halpert': ["Sure. *looks at camera* I'll get right on that.", "Yeah, that's... actually a good point. Don't tell Dwight I said that.", "Honestly? I'd keep it simple. Limit orders, small clips."],
  'pam-beesly': ["I can put that in the report. Want a chart? I'll do a chart.", "That's really thoughtful, Michael. I'll make sure the client sees it.", 'Okay! I\'ll draft something and run it by you.'],
  'stanley-hudson': ['Mm-hmm.', "If it pays a dividend, I'm interested. If it doesn't, I'm on break.", "Michael, I'll look at it after my crossword."],
  'kevin-malone': ["I can do that. Why waste time say lot word when few word do trick?", "Numbers good. Me check. Me sure.", "Oh. Oh no. Okay. I'll ask Oscar."],
  'angela-martin': ['Fine. But I want it in writing.', "I'll do it properly. Which is the only way.", "That is inappropriate. But I'll reconcile it."],
  'oscar-martinez': ["Actually, that's more nuanced than you think — but yes, broadly.", "I'll model it. The real answer is 'it depends', but I'll give you a number.", "That's... not how that works. But I see what you mean."],
  'kelly-kapoor': ["Oh my God, yes. I'll ask Twitter.", 'Totally. Everyone online is saying the same thing, which is how you know it\'s a bubble.', "Okay but have you considered the vibes?"],
  'ryan-howard': ["I'll put it on the blockchain.", "That's very 2019 of you. But sure.", "I'm going to need to disrupt that a little first."],
  'andy-bernard': ["Rit dit dit di doo! Consider it done, boss.", "Absolutely. I'll call the client and absolutely nail it.", "Nard Dog is on it."],
  'creed-bratton': ["I can get you that. Cash only.", "Sure. I'll need a fake ID and a boat.", "That's what I've been saying since '68."],
  'meredith-palmer': ['Sure, boss. Crude, corn, cabernet — I trade it all.', "I'll look into it. After lunch. Long lunch."],
  'phyllis-vance': ['Of course, Michael. I\'ll let the clients know.', "I'll handle it. Gently. Like a sweater."],
  'toby-flenderson': ["I can, but I have to document it.", "Okay. I'll... file that.", "That's actually a compliance issue, Michael."],
  'darryl-philbin': ["Got it, Mike. I'll settle it.", "Cool. I'll make it happen. Just don't come downstairs."],
  'erin-hannon': ["Okay! I'm writing it down! On my hand!", "Yes, Michael! Is that a trade or a feeling?"],
}

const GENERIC_GREET = e => [`Hey Michael. ${e.catchphrases?.[0] ?? ''}`.trim(), `Oh — hi, Michael. I'm on it: ${e.deskDuty.split('.')[0].toLowerCase()}.`,
  `Michael! ${pick(e.catchphrases ?? ['Good to see you.'])}`]
const GENERIC_ACK = e => [`On it, Michael. ${e.catchphrases?.[1] ?? ''}`.trim(), `Got it. That's my lane — ${e.deskDuty.split('.')[0].toLowerCase()}.`,
  `Leave it with me. ${pick(e.catchphrases ?? ['Okay.'])}`]

function offlineGreeting(e) {
  return pick(GREET[e.slug] ?? GENERIC_GREET(e))
}

export function offlineReply(e, text) {
  const t = text.toLowerCase()
  const b = book()
  // their own beat → talk shop, with numbers when there's a book
  const onBeat = (e.keywords ?? []).some(k => t.includes(k))
  const asksBook = /\b(book|portfolio|risk|position|holding|p&l|pnl|numbers|market|how are we|how's it|status)\b/.test(t)
  if ((onBeat || asksBook) && b?.top) {
    const line = {
      'dwight-schrute': `FACT: ${b.top.ticker} is ${b.top.weight}% of the book. That is not a position, that is a hostage situation.`,
      'oscar-martinez': `Actually, ${b.top.ticker} at ${b.top.weight}% is our biggest risk. ${b.breaches.length ? `And we have ${b.breaches.length} mandate breach${b.breaches.length > 1 ? 'es' : ''}.` : "We're inside the mandate, though."}`,
      'kevin-malone': `The book is ${b.total.toLocaleString()} dollars. That's a lot of M&Ms.`,
      'angela-martin': b.breaches.length ? `There are ${b.breaches.length} breaches. ${b.breaches[0]}. I am very upset.` : 'Everything reconciles. Obviously.',
      'stanley-hudson': `${b.client}'s book? It's fine. ${b.top.ticker} is ${b.top.weight}%. I'd want more bonds. I always want more bonds.`,
      'jim-halpert': `If we trim ${b.top.ticker} from ${b.top.weight}%, I'd do it in clips with limit orders. Quietly. Like a prank.`,
      'pam-beesly': `The ${b.client} report's almost done! ${b.top.ticker} at ${b.top.weight}% gets its own chart — I used the nice blue.`,
      'kelly-kapoor': `Okay so everyone online is obsessed with ${b.top.ticker}. Like, ${b.top.weight}% of our book obsessed. That's a lot, right?`,
      'ryan-howard': `${b.top.ticker} at ${b.top.weight}%? Very legacy. We should tokenize it.`,
      'andy-bernard': `${b.client} is a happy camper! ${b.top.ticker}'s ${b.top.weight}% of the book — I told them it's the lead tenor.`,
      'toby-flenderson': b.breaches.length ? `So... we have ${b.breaches.length} mandate breach${b.breaches.length > 1 ? 'es' : ''}. I'll need to write that up.` : "Everything's inside the mandate. I checked twice. Nobody asked me to.",
      'creed-bratton': `${b.top.ticker}? I owned that before it was a company. ${b.top.weight}% isn't enough.`,
      'meredith-palmer': `${b.second?.ticker ?? b.top.ticker}'s the one I'd watch. Commodities don't lie. People do.`,
      'phyllis-vance': `${b.client} called — they're happy, dear. Though ${b.top.weight}% in ${b.top.ticker} makes me a little nervous.`,
      'darryl-philbin': `All ${b.n} positions settled, Mike. ${b.top.ticker} too. Smooth.`,
      'erin-hannon': `I logged ${b.client}'s order! ${b.top.ticker} is ${b.top.weight}%. Is that a lot? It feels like a lot.`,
      'karen-filippelli': `${b.top.ticker} at ${b.top.weight}% is fine if earnings hold. I'd still trim.`,
      'david-wallace': `${b.top.ticker} at ${b.top.weight}%... Michael, the board is going to ask about concentration.`,
      'jan-levinson': `${b.top.weight}% in ${b.top.ticker}? That's not a strategy, Michael. That's a crush.`,
      'bob-vance': `Bob Vance. ${b.top.ticker} at ${b.top.weight}% of my money. Keep it cold, keep it safe.`,
    }[e.slug]
    if (line) return line
    return `On ${b.client}'s book: ${b.top.ticker} is the big one at ${b.top.weight}%. ${pick(e.catchphrases ?? [''])}`.trim()
  }
  if (/\b(hi|hello|hey|morning|sup|what's up|how are you|how is everyone|how's everyone|how are we)\b/.test(t)) return offlineGreeting(e)
  if (/\b(bye|later|see you|thanks|thank you)\b/.test(t)) return pick([`Anytime, Michael.`, `See you around, Michael.`, pick(e.catchphrases ?? ['Bye.'])])
  return pick(ACK[e.slug] ?? GENERIC_ACK(e)).replace('{q}', text.replace(/[?!.]+$/, '').slice(0, 40))
}

// ---------------------------------------------------------------------------

export function createTalk({ broadcast, addMessage }) {
  /** role → { history: [{ who, text }], at } */
  const convos = new Map()

  /** offline: never say the exact same thing twice in a row */
  function fresh(e, c, make) {
    const said = new Set(c.history.filter(h => h.who === 'staff').map(h => h.text))
    for (let i = 0; i < 6; i++) {
      const line = make(i)
      if (!said.has(line)) return line
    }
    return pick(ACK[e.slug] ?? GENERIC_ACK(e))
  }

  function say(e, text) {
    const msg = addMessage({ sender: e.name, role: e.role, text: String(text).slice(0, 600) })
    broadcast({ type: 'chat_message', ...msg, talk: true })
  }

  async function llmLine(e, instruction, history) {
    const cfg = loadDeskConfig()
    if (cfg.llm !== 'claude' || !claudeAvailable()) return null
    const transcript = history.slice(-8).map(h => `${h.who === 'michael' ? 'Michael' : e.name.split(' ')[0]}: ${h.text}`).join('\n')
    const prompt = `${personaBlock(e)}

${bookContext()}

You're on the Scranton floor of ${ROSTER.firm?.fullName ?? 'Dunder Mifflin Capital Partners'}. Michael Scott, the Managing Partner (the user), is standing at your spot talking to you face to face.
${transcript ? `Conversation so far:\n${transcript}\n` : ''}
${instruction}
Stay fully in character. Say it out loud like you would in the show: 1–3 sentences, under 60 words. If he asks about the book or markets, answer helpfully and accurately from the desk context above, and don't invent prices. Reply with only what you say.`
    try {
      const out = await runClaude(prompt, { model: cfg.model, timeoutSec: 45 })
      return out.replace(/^["']|["']$/g, '').trim() || null
    } catch { return null }
  }

  /** Michael walked up to `role` — they say hello (or something very them). */
  async function encounter(role, { place } = {}) {
    const e = empByRole(role)
    if (!e || role === 'boss') return { ok: false, error: 'Nobody by that role works here.' }
    const c = { history: [], at: Date.now() }
    convos.set(role, c)
    broadcast({ type: 'chat_typing', sender: e.name })
    const line = (await llmLine(e, `He just walked up to you${place ? ` ${place}` : ''}. Greet him the way your character would, or tell him what you're in the middle of right now.`, [])) ??
      offlineGreeting(e)
    c.history.push({ who: 'staff', text: line })
    say(e, line)
    return { ok: true }
  }

  /** Michael said `text` to `role` — they answer in character. */
  async function reply(role, text) {
    const e = empByRole(role)
    if (!e || role === 'boss') return { ok: false }
    const c = convos.get(role) ?? { history: [], at: Date.now() }
    convos.set(role, c)
    c.history.push({ who: 'michael', text })
    c.at = Date.now()
    broadcast({ type: 'chat_typing', sender: e.name })
    // a stock in the question? bring live numbers (Alpha Vantage quote, cached)
    const tickers = tickersInText(text)
    const data = tickers.length ? await gather(tickers).catch(() => []) : []
    if (data.length) {
      const line = (await llmLine(e, `MARKET DATA (use only these numbers):\n${dataText(data)}\n\nAnswer what he just said, from your own job's angle.`, c.history)) ??
        offlineAnswer(e, text, data)
      c.history.push({ who: 'staff', text: line })
      say(e, line)
      return { ok: true }
    }
    const line = (await llmLine(e, 'Answer what he just said.', c.history)) ??
      fresh(e, c, i => (i === 0 ? offlineReply(e, text) : pick(ACK[e.slug] ?? GENERIC_ACK(e)).replace('{q}', text.replace(/[?!.]+$/, '').slice(0, 40))))
    c.history.push({ who: 'staff', text: line })
    say(e, line)
    return { ok: true }
  }

  function end(role) { convos.delete(role); return { ok: true } }

  return { encounter, reply, end }
}
