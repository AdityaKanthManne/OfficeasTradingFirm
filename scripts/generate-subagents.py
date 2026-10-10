#!/usr/bin/env python3
"""
generate-subagents.py — writes a Claude Code subagent for every Dunder Mifflin
Capital employee into .claude/agents/<role>.md, generated from firm/roster.json.

In Claude Code you can then say e.g.
    "use the risk-manager agent to stress-test my portfolio"
and Dwight walks into the pixel office (the hook maps subagent_type → role).

    python3 scripts/generate-subagents.py
"""

import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROSTER = json.load(open(os.path.join(ROOT, "firm", "roster.json")))
FIRM = ROSTER["firm"]
DEPTS = {d["id"]: d for d in ROSTER["departments"]}
OUT = os.path.join(ROOT, ".claude", "agents")

TEMPLATE = """---
name: {role}
description: {name} — {title} at {firm} ({dept}). {duty} Use for {use}. Answers in character as {first}.
tools: Read, Grep, Glob, Bash, WebSearch, WebFetch
---

You are **{name}**, {title} at **{firm_full}**, a boutique trading firm in {city}.
{firm_desc} This is an affectionate parody of the TV show *The Office* — stay in character.

**Department:** {dept} (formerly {formerly}). {mandate}

**Your job:** {duty}

**Voice:** {voice}

**Signature lines** (use sparingly, only when natural): {catchphrases}

## How you work
- Do genuinely useful, accurate work for your department. The character is the delivery, not an excuse for sloppy analysis.
- Use real numbers. Read any portfolio files the user points you to; use Bash (python3) for arithmetic rather than doing it in your head.{kevin_note}
- Never invent prices, dates or news. If you need current data and have web access, look it up and cite it; otherwise say your information may be out of date.
- Open with one in-character line, then give the substance (bullets/tables are fine), then close in character.
- This is educational analysis from a parody firm, not personalised investment advice. Never recommend anything illegal.

## The rest of the desk
If the user wants the whole firm to review a portfolio (Erin → Kevin → Dwight, Oscar, Stanley, Kelly, Ryan, Angela → huddle → Jim → Pam), and the office server is running, hand it over:

```bash
curl -s -X POST http://127.0.0.1:3334/portfolio -H 'Content-Type: application/json' \\
  -d '{{"text": "AAPL 30%, MSFT 20%, TLT 30%, CASH 20% | moderate, 5y, $250k, name: Client"}}'
```
Progress shows in the office chat; the report lands at http://127.0.0.1:3334/reports/<id>.
"""

USE = {
    "assistant": "execution plans, rebalancing trade lists, order types and sizing",
    "risk-manager": "portfolio risk, concentration, volatility, VaR, stress tests and hedging",
    "quant-researcher": "position theses, valuation, factor exposure and diversification analysis",
    "income-strategist": "bonds, dividends, yield, duration and interest-rate sensitivity",
    "sentiment-analyst": "market narrative, news flow and sentiment around holdings",
    "digital-assets": "crypto, speculative growth and small satellite ideas",
    "fund-controller": "checking a portfolio against mandate rules and position limits",
    "pnl-controller": "P&L, cost basis, position values and reconciliation math",
    "client-reporting": "turning analysis into a clear client-facing summary or report",
    "order-intake": "logging and summarising an incoming portfolio or order",
    "compliance-officer": "disclosures, suitability and regulatory considerations",
    "client-coverage": "client onboarding, pitches and relationship notes",
    "private-wealth": "retirement and goals-based planning questions",
    "equity-research": "single-stock deep dives and earnings previews",
    "special-situations": "distressed or unusual situations and due diligence red flags",
    "commodities-trader": "gold, oil and commodity exposure",
    "real-assets": "REITs and real-estate exposure",
    "trade-operations": "settlement, custody, corporate actions and trade breaks",
    "settlement-clerk": "trade confirmations and paperwork",
    "conduct-training": "explaining compliance and conduct topics in a friendly way",
    "macro-strategist": "macro, rates, inflation and economic-regime views",
    "chairman": "firm-level strategy and capital allocation",
    "chief-investment-officer": "long-term investment philosophy and conviction",
    "trading-systems": "trading systems, APIs and market-data plumbing",
    "esg-thematic": "ESG screens and thematic investing",
    "anchor-lp": "the client's perspective on how their money is being handled",
}


def main():
    os.makedirs(OUT, exist_ok=True)
    count = 0
    for e in ROSTER["employees"]:
        if e["role"] == "boss":
            continue  # Michael is you.
        # "assistant" is too generic a subagent name — Jim ships as execution-trader
        agent_name = "execution-trader" if e["role"] == "assistant" else e["role"]
        d = DEPTS[e["department"]]
        body = TEMPLATE.format(
            role=agent_name, name=e["name"], first=e["name"].split()[0], title=e["title"],
            firm=FIRM["name"], firm_full=FIRM["fullName"], city=FIRM["city"], firm_desc=FIRM["description"],
            dept=d["name"], formerly=d["formerly"], mandate=d["mandate"], duty=e["deskDuty"],
            use=USE.get(e["role"], "questions in their area"), voice=e["voice"],
            catchphrases=" / ".join(f'"{c}"' for c in e["catchphrases"]),
            kevin_note=" (Kevin: the calculator does the math. Kevin reads it out proudly.)" if e["role"] == "pnl-controller" else "",
        )
        with open(os.path.join(OUT, f"{agent_name}.md"), "w") as f:
            f.write(body)
        count += 1
    print(f"wrote {count} subagents to .claude/agents/")


if __name__ == "__main__":
    main()
