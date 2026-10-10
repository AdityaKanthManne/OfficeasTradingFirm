/**
 * report.js — assembles the client report (markdown) and renders it as a
 * self-contained HTML page served by the office server.
 */

import { FIRM } from './roster.js'

const usd = n => (n == null ? '—' : `$${Math.round(n).toLocaleString()}`)
const fmt = (n, d = 1) => (n == null || !Number.isFinite(n) ? '—' : (Math.round(n * 10 ** d) / 10 ** d).toString())

export function buildReportMarkdown({ book, sections, huddle, execution, trades, beforeAfter, summary, signoff, disclaimer }) {
  const L = []
  L.push(`# ${FIRM.fullName} — Portfolio Review`)
  L.push(`**Client:** ${book.clientName} · **Mandate:** ${book.mandate.risk}${book.mandate.horizonYears ? `, ${book.mandate.horizonYears}-year horizon` : ''} · **Value:** ${usd(book.totalValue)} · **Date:** ${new Date(book.createdAt).toLocaleString()}`)
  L.push('')
  L.push(`> ${FIRM.tagline}  `)
  L.push(`> <small>${FIRM.taglineFootnote}</small>`)
  L.push('')
  if (summary) L.push(summary, '')

  L.push('## The book', '')
  L.push('| Ticker | Name | Class | Sector | Weight | Value | Price | P&L |')
  L.push('|---|---|---|---|---:|---:|---:|---:|')
  for (const p of book.positions) {
    L.push(`| **${p.ticker}** | ${p.name} | ${p.cls} | ${p.sector} | ${fmt(p.weight)}% | ${usd(p.value)} | ${p.price != null && p.ticker !== 'CASH' ? `$${fmt(p.price, 2)}` : '—'} | ${p.pnlPct != null ? `${p.pnlPct > 0 ? '+' : ''}${p.pnlPct}%` : '—'} |`)
  }
  L.push('')
  L.push(`**Asset classes:** ${book.byClass.map(c => `${c.name} ${fmt(c.weight)}%`).join(' · ')}  `)
  L.push(`**Risk data:** ${book.risk.source === 'historical' ? '1 year of daily prices' : 'model estimates (no market data)'}`)
  if (book.warnings.length) L.push('', `_Data notes: ${book.warnings.join('; ')}_`)
  L.push('')

  for (const s of sections) {
    L.push(`## ${s.heading}`, `<p class="byline">${s.emoji} ${s.name} — ${s.title}</p>`, '')
    L.push(s.analysis_md || '_No analysis returned._', '')
  }

  if (huddle?.length) {
    L.push('## Desk huddle', '')
    for (const h of huddle) L.push(`- **${h.name}:** ${h.line}`)
    L.push('')
  }

  L.push('## Execution plan', `<p class="byline">🎯 ${execution.name} — ${execution.title}</p>`, '')
  if (execution.analysis_md) L.push(execution.analysis_md, '')
  if (execution.vetoNote) L.push(`> ⚠️ ${execution.vetoNote}`, '')
  if (trades.length) {
    L.push('| Side | Ticker | From | To | ≈ Amount | ≈ Units | Order | Urgency | Note |')
    L.push('|---|---|---:|---:|---:|---:|---|---|---|')
    for (const t of trades) {
      L.push(`| ${t.side === 'BUY' ? '🟢 BUY' : '🔴 SELL'} | **${t.ticker}** | ${fmt(t.fromWeight)}% | ${fmt(t.toWeight)}% | ${usd(t.dollars)} | ${t.shares != null ? fmt(t.shares, 2) : '—'} | ${t.order_type ?? 'limit'} | ${t.urgency ?? 'medium'} | ${t.note ?? ''} |`)
    }
  } else {
    L.push('_No trades required._')
  }
  L.push('')
  L.push('**Target allocation:** ' + execution.targets.filter(t => t.target > 0.001).map(t => `${t.ticker} ${fmt(t.target)}%`).join(' · '), '')

  if (beforeAfter) {
    const b = beforeAfter.before, a = beforeAfter.after
    L.push('### Before vs after', '')
    L.push('| Measure | Before | After |')
    L.push('|---|---:|---:|')
    L.push(`| Estimated volatility (model) | ${b.vol}% | ${a.vol}% |`)
    L.push(`| Equities −20% | ${b.equityShockPct}% | ${a.equityShockPct}% |`)
    L.push(`| Rates +100bp | ${b.rateShockPct}% | ${a.rateShockPct}% |`)
    L.push(`| Beta to equities | ${b.beta} | ${a.beta} |`)
    L.push(`| Largest single name | ${b.largestSingle} | ${a.largestSingle} |`)
    L.push(`| Largest sector | ${b.largestSector} | ${a.largestSector} |`)
    L.push(`| Effective number of positions | ${b.effectiveN} | ${a.effectiveN} |`)
    L.push(`| Mandate checks passed | ${b.checksPassed}/${b.checksTotal} | ${a.checksPassed}/${a.checksTotal} |`)
    L.push('', '_Both columns use the same simple risk model so they compare like-for-like; diversified funds are counted by their headline sector._', '')
  }

  if (signoff) L.push('## Sign-off', `> ${signoff}`, '> — Michael Scott, Managing Partner', '')
  L.push('## Disclosures', `<p class="byline">📎 Toby Flenderson — Chief Compliance Officer</p>`, '', disclaimer, '')
  return L.join('\n')
}

// ---------------------------------------------------------------------------
// Tiny markdown → HTML (headings, tables, lists, quotes, bold/italic, code).
// Raw HTML lines (our own <p class="byline">) pass through; model text is escaped.
// ---------------------------------------------------------------------------

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function inline(s) {
  let out = esc(s)
  out = out.replace(/&lt;small&gt;(.*?)&lt;\/small&gt;/g, '<small>$1</small>')
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  out = out.replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,;:])/g, '$1<em>$2</em>')
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  return out
}

export function markdownToHtml(md) {
  const lines = md.split('\n')
  const html = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^<p class="byline">.*<\/p>$/.test(line.trim())) {
      const inner = line.trim().replace(/^<p class="byline">/, '').replace(/<\/p>$/, '')
      html.push(`<p class="byline">${esc(inner)}</p>`); i++; continue
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) { html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
      const aligns = cells(lines[i + 1]).map(c => (c.endsWith(':') ? 'right' : 'left'))
      const head = cells(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++ }
      html.push('<div class="table-wrap"><table><thead><tr>' + head.map((c, k) => `<th style="text-align:${aligns[k]}">${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map((c, k) => `<td style="text-align:${aligns[k] ?? 'left'}">${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>')
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++ }
      html.push('<ul>' + items.map(it => `<li>${inline(it)}</li>`).join('') + '</ul>'); continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++ }
      html.push('<ol>' + items.map(it => `<li>${inline(it)}</li>`).join('') + '</ol>'); continue
    }
    if (/^>\s?/.test(line)) {
      const q = []
      while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++ }
      html.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`); continue
    }
    if (!line.trim()) { i++; continue }
    const para = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>|\s*[-*]\s|\s*\d+\.\s|\s*\|)/.test(lines[i]) && !/^<p class/.test(lines[i].trim())) { para.push(lines[i]); i++ }
    if (para.length) html.push(`<p>${para.map(inline).join('<br>')}</p>`)
    else i++
  }
  return html.join('\n')
}

export function reportHtml(md, title) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { --bg:#f7f5ef; --ink:#1d2329; --muted:#6b7280; --rule:#ddd8cc; --accent:#1f4e79; --card:#fff; --good:#1a7f37; --bad:#b42318; }
@media (prefers-color-scheme: dark) { :root { --bg:#14171b; --ink:#e7e5df; --muted:#9aa1a9; --rule:#2c3238; --accent:#7fb2e5; --card:#1b1f24; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.6 Georgia, 'Times New Roman', serif; }
main { max-width: 920px; margin: 0 auto; padding: 40px 20px 80px; }
h1 { font: 700 30px/1.2 'Helvetica Neue', Arial, sans-serif; letter-spacing:-0.5px; margin:0 0 8px; color:var(--accent); }
h2 { font: 700 20px/1.3 'Helvetica Neue', Arial, sans-serif; margin: 40px 0 4px; padding-top: 16px; border-top: 2px solid var(--rule); }
h3 { font: 700 16px/1.3 'Helvetica Neue', Arial, sans-serif; margin: 20px 0 6px; }
.byline { margin: 0 0 12px; color: var(--muted); font: 13px 'Helvetica Neue', Arial, sans-serif; }
.table-wrap { overflow-x:auto; margin: 12px 0; }
table { border-collapse: collapse; width: 100%; font: 13px/1.4 'Helvetica Neue', Arial, sans-serif; background: var(--card); }
th, td { padding: 6px 10px; border-bottom: 1px solid var(--rule); white-space: nowrap; }
td:last-child { white-space: normal; min-width: 200px; }
th { background: var(--rule); font-weight: 600; }
blockquote { margin: 12px 0; padding: 8px 16px; border-left: 3px solid var(--accent); color: var(--muted); }
code { font-size: 13px; background: var(--rule); padding: 1px 4px; border-radius: 3px; }
.letterhead { display:flex; justify-content:space-between; align-items:center; font: 600 12px 'Helvetica Neue', Arial, sans-serif; letter-spacing: 2px; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--rule); padding-bottom: 10px; margin-bottom: 24px; }
</style></head>
<body><main>
<div class="letterhead"><span>${esc(FIRM.fullName)}</span><span>${esc(FIRM.city)}</span></div>
${markdownToHtml(md)}
</main></body></html>`
}
