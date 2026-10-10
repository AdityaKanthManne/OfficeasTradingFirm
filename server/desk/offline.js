/**
 * offline.js — template-driven, in-character desk output.
 *
 * Used when the Claude CLI isn't installed, when desk.config.json sets
 * "llm": "offline", or as a per-agent fallback if a model call fails.
 * Everything is derived from the computed book, so it is still accurate —
 * just less eloquent than the real thing.
 */

const pick = arr => arr[Math.floor(Math.random() * arr.length)]
const usd = n => `$${Math.round(n).toLocaleString()}`
const pct = n => `${Math.round(n * 10) / 10}%`

function biggest(book, n = 3) { return book.positions.filter(p => p.ticker !== 'CASH').slice(0, n) }
function failing(book) { return book.checks.filter(c => !c.pass) }

export const offline = {
  'pnl-controller'(book) {
    const top = biggest(book, 1)[0]
    const pnlLine = book.pnl ? ` Up ${usd(book.pnl.total)} on cost (${pct(book.pnl.pct)}). Best ${book.pnl.best}, worst ${book.pnl.worst}.` : ''
    return {
      chat: `Total ${usd(book.totalValue)}. ${book.concentration.holdings} things. Biggest ${top?.ticker} ${pct(top?.weight ?? 0)}.${pnlLine} Calculator checked. Keleven.`,
      headline: `Book is ${usd(book.totalValue)} across ${book.concentration.holdings} holdings; top-3 concentration ${pct(book.concentration.top3)}, effective N ${book.concentration.effectiveN}.`,
      analysis_md: `*Why waste time say lot word when few word do trick.*\n\n- **Total value:** ${usd(book.totalValue)}\n- **Holdings:** ${book.concentration.holdings} (effective number of positions: ${book.concentration.effectiveN})\n- **Largest position:** ${top?.ticker} at ${pct(top?.weight ?? 0)}; top 3 = ${pct(book.concentration.top3)}\n${book.pnl ? `- **Unrealised P&L:** ${usd(book.pnl.total)} on a ${usd(book.pnl.costBasis)} cost basis (${pct(book.pnl.pct)})\n` : '- No cost basis supplied, so no P&L. Add `cost 150` to a position next time.\n'}${book.warnings.length ? `- **Data notes:** ${book.warnings.join('; ')}\n` : ''}`,
      flags: [], actions: [],
    }
  },

  'risk-manager'(book) {
    const r = book.risk
    const top = biggest(book)
    const fails = failing(book)
    return {
      chat: `FACT: if equities drop 20%, this book loses ${usd(Math.abs(r.equityShock.value))} (${pct(r.equityShock.pct)}). ${top[0]?.ticker} at ${pct(top[0]?.weight ?? 0)} is a bear waiting in the beets. ${fails.length ? 'Unacceptable.' : 'Acceptable. For now.'}`,
      headline: `Annualised vol ~${r.vol}% with 1-day 95% VaR of ${usd(r.var95_1d)}; a 20% equity drawdown would cost ~${pct(Math.abs(r.equityShock.pct))}.`,
      analysis_md: `*FACT: Bears eat beets. Bear markets eat portfolios. I have prepared.*\n\n| Metric | Value |\n|---|---|\n| Annualised volatility | ${r.vol}% (${r.source === 'historical' ? '1y daily history' : 'model estimate'}) |\n| 1-day 95% VaR | ${usd(r.var95_1d)} (${r.var95_1dPct}%) |\n| Beta to equities | ${r.beta} |\n${r.maxDrawdown1y != null ? `| Max drawdown (1y, current weights) | ${r.maxDrawdown1y}% |\n` : ''}| ${r.equityShock.label} | ${usd(r.equityShock.value)} (${r.equityShock.pct}%) |\n| ${r.rateShock.label} | ${usd(r.rateShock.value)} (${r.rateShock.pct}%) |\n| Most correlated pair | ${r.topCorrelation ? `${r.topCorrelation.a}/${r.topCorrelation.b} ρ≈${r.topCorrelation.rho}` : 'n/a'} |\n\n**Bear case, largest positions**\n${top.map(p => `- **${p.ticker}** (${pct(p.weight)}, vol ~${Math.round(p.vol * 100)}%): a 2σ year is roughly a ${Math.round(p.vol * 200)}% drawdown on this name — about ${usd(p.value * p.vol * 2)}.`).join('\n')}\n\n**Fixes**\n${book.baseline.notes.length ? book.baseline.notes.map(n => `- ${n}`).join('\n') : '- No mandate breaches. Maintain stops and review quarterly.'}`,
      flags: top.filter(p => p.weight > book.limits.maxPosition && !p.info.fund).map(p => ({ ticker: p.ticker, severity: 'high', note: `${pct(p.weight)} exceeds the ${book.limits.maxPosition}% single-name limit` })),
      actions: book.baseline.targets.filter(t => { const cur = book.positions.find(p => p.ticker === t.ticker)?.weight ?? 0; return Math.abs(cur - t.target) >= 0.5 }).map(t => ({ ticker: t.ticker, action: (book.positions.find(p => p.ticker === t.ticker)?.weight ?? 0) > t.target ? 'trim' : 'add', target_weight: t.target, rationale: 'bring the book inside risk limits' })),
    }
  },

  'quant-researcher'(book) {
    const tp = book.risk.topCorrelation
    const classes = book.byClass.map(c => `${c.name} ${pct(c.weight)}`).join(', ')
    const missing = []
    if (!book.byClass.find(c => c.name === 'bond')) missing.push('high-quality bonds')
    if (!book.bySector.find(s => ['International', 'Emerging Markets'].includes(s.name))) missing.push('international equity')
    if (!book.byClass.find(c => ['commodity', 'realestate'].includes(c.name))) missing.push('real assets')
    return {
      chat: `Actually, ${tp ? `${tp.a} and ${tp.b} move together (ρ≈${tp.rho}), so that's one bet, not two` : 'the diversification is thinner than it looks'}. Effective N is ${book.concentration.effectiveN}. I'll explain it like I'm talking to Kevin.`,
      headline: `Effective diversification is ${book.concentration.effectiveN} independent bets; the book is missing ${missing.join(', ') || 'nothing major'}.`,
      analysis_md: `*Actually, that's not what diversification means. Let me walk you through it.*\n\n**Mix:** ${classes}\n\n**Positions**\n${book.positions.filter(p => p.ticker !== 'CASH').map(p => `- **${p.ticker}** — ${p.name}, ${p.sector}${p.info.fund ? ' (diversified fund)' : ''}: ${pct(p.weight)}${p.ret1y != null ? `, 1y ${p.ret1y}%` : ''}${p.info.known ? '' : ' — *unknown ticker, treated as a single stock*'}`).join('\n')}\n\n**Diversification:** effective N = ${book.concentration.effectiveN}; most correlated pair ${tp ? `${tp.a}/${tp.b} (ρ≈${tp.rho})` : 'n/a'}.\n\n**Missing exposures:** ${missing.join(', ') || 'none significant'}.\n\n*(Offline mode: run with the Claude CLI for full position theses.)*`,
      flags: tp && tp.rho >= 0.75 ? [{ ticker: `${tp.a}/${tp.b}`, severity: 'medium', note: 'highly correlated pair' }] : [],
      actions: [],
    }
  },

  'income-strategist'(book) {
    const bonds = book.byClass.find(c => c.name === 'bond')?.weight ?? 0
    return {
      chat: `${pct(bonds)} in bonds. Rates up 100bp costs us ${pct(Math.abs(book.risk.rateShock.pct))}. ${bonds < 10 && book.mandate.risk !== 'aggressive' ? 'Buy the bond. ' : ''}It's 4:58. Did I stutter?`,
      headline: `Fixed income is ${pct(bonds)} of the book; a +100bp rate shock costs ~${pct(Math.abs(book.risk.rateShock.pct))} (${'$'}${Math.abs(Math.round(book.risk.rateShock.value)).toLocaleString()}).`,
      analysis_md: `*I clip my coupons and I go home.*\n\n- **Bond allocation:** ${pct(bonds)}\n- **Rates +100bp:** ${book.risk.rateShock.pct}% (${usd(book.risk.rateShock.value)})\n- **Defensive sleeve for a ${book.mandate.risk} mandate:** ${book.mandate.risk === 'conservative' ? '30–50% high-quality bonds' : book.mandate.risk === 'moderate' ? '15–35% high-quality bonds' : '0–15% bonds; cash for dry powder'}\n- Income figures are approximate without live yield data.`,
      flags: [], actions: [],
    }
  },

  'sentiment-analyst'(book) {
    const hot = book.positions.filter(p => p.info.spec || p.vol >= 0.45).map(p => p.ticker)
    return {
      chat: `OMG okay so ${hot.length ? `${hot.join(', ')} ${hot.length > 1 ? 'are' : 'is'} SO crowded right now, like everyone's talking about ${hot.length > 1 ? 'them' : 'it'}` : `this book is kind of boring which, honestly? Iconic`}. Who says exclamation points are unprofessional?!`,
      headline: hot.length ? `Most narrative-driven/crowded exposures: ${hot.join(', ')}.` : 'No obviously crowded or meme-driven positions.',
      analysis_md: `*I talk a lot, so I've learned to tune myself out.*\n\n${book.positions.filter(p => p.ticker !== 'CASH').map(p => `- **${p.ticker}:** ${p.info.spec ? 'very narrative-driven, sentiment swings hard' : p.vol >= 0.45 ? 'high-attention name, crowded positioning risk' : p.info.fund ? 'fund — sentiment follows the broad market' : 'mainstream holding; watch earnings and guidance'}`).join('\n')}\n\n*Live sentiment wasn't pulled (offline mode).*`,
      flags: hot.map(t => ({ ticker: t, severity: 'medium', note: 'crowded / narrative-driven' })),
      actions: [],
    }
  },

  'digital-assets'(book) {
    const spec = book.checks.find(c => c.id === 'max-spec')
    return {
      chat: book.limits.maxSpec === 0
        ? `Conservative mandate. No crypto allowed. That's very 2008 of you. Fine. WUPHF token stays in my drawer.`
        : `Spec sleeve is ${pct(spec.actual)} vs a ${book.limits.maxSpec}% cap. ${spec.pass ? `Room for ${pct(book.limits.maxSpec - spec.actual)} of disruption.` : 'Angela says trim. Angela is not a visionary.'}`,
      headline: `Crypto/speculative exposure is ${pct(spec.actual)} against a ${book.limits.maxSpec}% limit (${spec.pass ? 'within' : 'over'} limit).`,
      analysis_md: `*We're not a trading firm, we're a platform.*\n\n- **Speculative sleeve:** ${spec.detail} — total ${pct(spec.actual)} vs limit ${book.limits.maxSpec}%\n- ${book.limits.maxSpec === 0 ? 'Mandate prohibits speculative assets.' : `Satellite idea (offline mode): a small, capped position in a spot bitcoin ETF within the ${book.limits.maxSpec}% limit. Speculative; can fall 50%+.`}`,
      flags: spec.pass ? [] : [{ ticker: 'SPEC', severity: 'high', note: 'speculative sleeve over limit' }],
      actions: [],
    }
  },

  'fund-controller'(book) {
    const f = failing(book)
    return {
      chat: f.length
        ? `${f.length} mandate violation${f.length > 1 ? 's' : ''}. ${f[0].rule}: actual ${f[0].actual}. This is disgusting. Sprinkles would never.`
        : `All ${book.checks.length} mandate checks pass. I still don't approve of you. But the book is compliant.`,
      headline: f.length ? `${f.length} of ${book.checks.length} mandate checks fail: ${f.map(c => c.rule).join('; ')}.` : `All ${book.checks.length} mandate checks pass.`,
      analysis_md: `*I don't approve of this book. Let's see if the rules do.*\n\n| Rule | Actual | Result |\n|---|---|---|\n${book.checks.map(c => `| ${c.rule} | ${c.actual}${typeof c.actual === 'number' && c.id !== 'min-holdings' ? '%' : ''} | ${c.pass ? '✅ PASS' : '❌ FAIL'} |`).join('\n')}\n\n${f.length ? `**Required fixes:**\n${book.baseline.notes.map(n => `- ${n}`).join('\n')}` : 'No action required.'}\n\n_Diversified funds/ETFs are exempt from the single-name limit (policy 4.2(b))._`,
      flags: f.map(c => ({ ticker: c.detail, severity: 'high', note: c.rule })),
      actions: [],
    }
  },

  'commodities-trader'(book) {
    const w = book.byClass.find(c => c.name === 'commodity')?.weight ?? 0
    return {
      chat: `${pct(w)} in commodities. It's five o'clock somewhere and gold doesn't care about your earnings call.`,
      headline: `Commodities are ${pct(w)} of the book, acting mainly as an inflation/crisis diversifier.`,
      analysis_md: `*I'm long whatever they serve at happy hour.*\n\n- Commodity weight: ${pct(w)}\n- Role: diversifier with low equity beta (gold) or inflation-linked (broad/oil).\n- Typical sizing: 5–10% for most mandates.`,
      flags: [], actions: [],
    }
  },

  'real-assets'(book) {
    const w = book.byClass.find(c => c.name === 'realestate')?.weight ?? 0
    return {
      chat: `${pct(w)} in real estate. Occupancy is everything, Michael. And rates.`,
      headline: `Real estate is ${pct(w)}; REITs are rate-sensitive (see the +100bp stress).`,
      analysis_md: `*Location, location, cap rate.*\n\n- REIT weight: ${pct(w)}\n- REITs typically lose ~5–8% on a +100bp move in rates.\n- Useful for income and inflation pass-through over long horizons.`,
      flags: [], actions: [],
    }
  },

  execution(book) {
    const trades = book.baselineTrades
    return {
      chat: trades.length
        ? `${trades.length} trades. Biggest: ${trades[0].side} ${trades[0].ticker} ~${usd(trades[0].dollars)}. Limit orders, staged over a couple days. *looks at camera*`
        : `No trades needed. Which is the best kind of trade. I'll go put Dwight's stapler in jello.`,
      analysis_md: `*I'll just... put in a limit order.*\n\n- Plan follows the desk's baseline rebalance, which brings the book inside the mandate.\n${book.baseline.notes.map(n => `- ${n}`).join('\n')}\n- Use limit orders for single names; funds can trade at market near the close.\n- Large winners: consider the tax impact before trimming (not tax advice).`,
      targets: null, order_notes: [],
    }
  },

  huddle(book) {
    const top = biggest(book, 1)[0]
    const f = failing(book)
    return [
      { speaker: 'michael-scott', line: `Okay, team. ${book.clientName}. What do we think? And don't say "sell". I hate goodbyes.` },
      { speaker: 'dwight-schrute', line: `${top?.ticker} is ${pct(top?.weight ?? 0)} of the book. If it drops 30%, we lose ${usd((top?.value ?? 0) * 0.3)}. I have already built a bunker.` },
      { speaker: 'jim-halpert', line: `Dwight, it's a portfolio, not a beet farm.` },
      { speaker: 'oscar-martinez', line: `Effective N is ${book.concentration.effectiveN}. It looks diversified. It is not.` },
      { speaker: 'angela-martin', line: f.length ? `${f.length} violations. I've written them down. In pen.` : `It's compliant. Barely. I'm watching all of you.` },
      { speaker: 'kelly-kapoor', line: `Can we talk about how cute ${top?.ticker}'s logo is though?` },
      { speaker: 'stanley-hudson', line: `Rates up 100 costs ${pct(Math.abs(book.risk.rateShock.pct))}. It's 4:59. I'm leaving.` },
      { speaker: 'toby-flenderson', line: `I just need to remind everyone this isn't personalised investment advice—` },
      { speaker: 'michael-scott', line: `Nobody cares, Toby. Jim, make the trades. That's what she said.` },
    ]
  },

  report(book, findings, trades, beforeAfter) {
    const f = failing(book)
    return {
      chat: `The client report for ${book.clientName} is ready. I made it look nice. And readable.`,
      executive_summary_md: `### Executive summary\n\n- Your portfolio is worth **${usd(book.totalValue)}** across **${book.concentration.holdings}** holdings; the largest is ${book.concentration.top1Ticker} at ${pct(book.concentration.top1)}.\n- Expected volatility is about **${book.risk.vol}% a year**; in a sharp 20% stock-market fall the book would lose roughly **${pct(Math.abs(book.risk.equityShock.pct))}**.\n- ${f.length ? `It currently breaks **${f.length}** of the ${book.mandate.risk} mandate rules (${f.map(c => c.rule.toLowerCase()).join('; ')}).` : `It is inside every rule of the ${book.mandate.risk} mandate.`}\n- ${trades.length ? `We propose **${trades.length} trades** to fix this — mainly ${trades.slice(0, 3).map(t => `${t.side.toLowerCase()} ${t.ticker}`).join(', ')}.` : 'No trades are needed right now.'}${beforeAfter && trades.length ? `\n- After the trades, estimated volatility goes from ${beforeAfter.before.vol}% to **${beforeAfter.after.vol}%**, and the book passes **${beforeAfter.after.checksPassed} of ${beforeAfter.after.checksTotal}** mandate checks (was ${beforeAfter.before.checksPassed}).` : ''}\n- Key watch items: ${findings.flatMap(x => x.flags || []).slice(0, 3).map(fl => `${fl.ticker} (${fl.note})`).join('; ') || 'nothing urgent'}.`,
      michael_signoff: pick([
        `Great work, everybody. ${book.clientName} is in good hands. Our hands. Which are excellent hands. That's what she said.`,
        `I declare... REBALANCING! Conference room, cake, 5 minutes.`,
        `Would I rather be feared or loved by the market? Easy. Both. Good job, team.`,
      ]),
    }
  },
}
