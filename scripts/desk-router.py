#!/usr/bin/env python3
"""
desk-router.py — decides which Dunder Mifflin Capital employee answers a chat
message, and builds their in-character prompt.

Usage:
    python3 scripts/desk-router.py "Dwight, how risky is our book?"
    python3 scripts/desk-router.py --chime "<role>" "<first reply>" "<original message>"

Prints JSON:
    { "role", "sender", "prompt", "maxWords", "chime": { "role", "sender" } | null }

Routing order:
  1. A character named in the message ("Oscar, ...", "ask Kevin") answers.
  2. Finance keywords from firm/roster.json pick the department.
  3. Dev keywords (bugs, PRs, CSS…) fall back to the original Claude Office agents.
  4. Otherwise the assistant (Claude / Jim on the trading floor) answers.
"""

import json
import os
import random
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROSTER = json.load(open(os.path.join(ROOT, "firm", "roster.json")))
FIRM = ROSTER["firm"]
EMPLOYEES = ROSTER["employees"]
DEPTS = {d["id"]: d for d in ROSTER["departments"]}
BY_ROLE = {e["role"]: e for e in EMPLOYEES}
LATEST = os.path.join(os.path.expanduser("~"), ".agent-office", "desk-latest.json")

# Who loves to butt in on whom — used for the occasional second voice
RIVALS = {
    "risk-manager": ["assistant", "digital-assets", "pnl-controller"],
    "quant-researcher": ["pnl-controller", "fund-controller"],
    "fund-controller": ["pnl-controller", "quant-researcher", "digital-assets"],
    "digital-assets": ["risk-manager", "sentiment-analyst"],
    "sentiment-analyst": ["digital-assets", "income-strategist"],
    "income-strategist": ["risk-manager", "sentiment-analyst"],
    "pnl-controller": ["fund-controller", "quant-researcher"],
    "client-reporting": ["assistant"],
    "assistant": ["risk-manager", "client-reporting"],
    "compliance-officer": ["risk-manager", "fund-controller"],
    "client-coverage": ["assistant", "risk-manager"],
    "special-situations": ["risk-manager", "assistant"],
    "commodities-trader": ["fund-controller"],
    "macro-strategist": ["income-strategist", "quant-researcher"],
}

DEV_ROUTES = [
    (['bug', 'error', 'crash', 'fix', 'broken', 'debug', 'exception', 'traceback', 'stack trace', 'segfault'], 'debugger', 'Debugger'),
    (['review', 'pr', 'merge', 'approve', 'lgtm', 'pull request', 'code review', 'diff'], 'code-reviewer', 'Reviewer'),
    (['css', 'ui', 'ux', 'component', 'frontend', 'layout', 'responsive', 'tailwind', 'animation', 'dark mode', 'font'], 'frontend-developer', 'Frontend'),
    (['test', 'coverage', 'jest', 'pytest', 'unit test', 'e2e', 'playwright', 'cypress', 'mock'], 'test-engineer', 'Tester'),
    (['security', 'auth', 'vuln', 'xss', 'injection', 'csrf', 'cors', 'jwt', 'oauth', 'password', 'encrypt'], 'security-auditor', 'Security'),
    (['deploy', 'ci', 'pipeline', 'docker', 'devops', 'kubernetes', 'k8s', 'terraform', 'aws', 'gcp', 'azure', 'vercel'], 'devops-engineer', 'DevOps'),
    (['perf', 'slow', 'optimize', 'latency', 'bundle', 'lighthouse', 'memory leak', 'cache', 'fps', 'bottleneck'], 'performance-engineer', 'PerfEng'),
    (['db', 'query', 'schema', 'migration', 'sql', 'postgres', 'mysql', 'mongo', 'redis', 'prisma', 'supabase'], 'database-architect', 'DBA'),
    (['typescript', 'interface', 'generic', 'enum', 'zod'], 'typescript-pro', 'TS Pro'),
    (['llm', 'prompt', 'openai', 'anthropic', 'embedding', 'vector', 'rag', 'context window'], 'ai-engineer', 'AI Eng'),
    (['api', 'endpoint', 'rest', 'graphql', 'webhook', 'middleware', 'http', 'fetch', 'axios'], 'fullstack-developer', 'Fullstack'),
    (['git', 'branch', 'commit', 'rebase', 'cherry-pick', 'stash', 'conflict'], 'code-reviewer', 'Reviewer'),
    (['refactor', 'abstract', 'pattern', 'architecture', 'module', 'monorepo'], 'architect-reviewer', 'Architect'),
]


def kw_regex(kw):
    """Short keywords must match whole words ('eth' ≠ 'method'); longer ones may be prefixes ('diversif')."""
    k = re.escape(kw.lower())
    return re.compile(r"\b" + k + (r"\b" if len(kw) <= 4 else ""))


def hits(msg, keywords):
    return sum(1 for k in keywords if kw_regex(k).search(msg))


def route(message):
    msg = message.lower()
    # 1. Named character (first or full name). The boss is the user, so skip Michael.
    for e in EMPLOYEES:
        if e["role"] == "boss":
            continue
        first = e["name"].split()[0].lower()
        if re.search(r"\b" + re.escape(first) + r"\b", msg) or e["name"].lower() in msg:
            # "Bob" is ambiguous only with Bob Vance — fine.
            return e["role"]
    # 2. Finance keywords
    best, best_score = None, 0
    for e in EMPLOYEES:
        if e["role"] == "boss":
            continue
        score = hits(msg, e.get("keywords", []))
        if score > best_score or (score == best_score and score > 0 and e.get("pipeline") and not (best or {}).get("pipeline")):
            best, best_score = e, score
    if best and best_score > 0:
        return best["role"]
    # 3. Dev keywords (original Claude Office agents)
    for words, role, _name in DEV_ROUTES:
        if hits(msg, words):
            return role
    return "assistant"


def desk_context():
    try:
        d = json.load(open(LATEST))
    except Exception:
        return "The desk hasn't reviewed a portfolio yet. If asked about 'our book', say so and suggest /portfolio."
    lines = [
        f"LATEST BOOK THE DESK REVIEWED ({d.get('createdAt', '')[:10]}): client {d.get('client')}, ${round(d.get('totalValue', 0)):,}, {d.get('mandate', '')} mandate.",
        "Holdings: " + ", ".join(f"{p['ticker']} {p['weight']}%" for p in d.get("positions", [])),
    ]
    r = d.get("risk") or {}
    if r:
        lines.append(f"Risk: vol {r.get('vol')}%, 1-day 95% VaR ${r.get('var95_1d', 0):,}, equities -20% → {r.get('equityShockPct')}%, rates +100bp → {r.get('rateShockPct')}%, beta {r.get('beta')}.")
    if d.get("failingChecks"):
        lines.append("Mandate breaches: " + "; ".join(d["failingChecks"]))
    for who, h in (d.get("headlines") or {}).items():
        if h:
            lines.append(f"{who}: {h}")
    if d.get("trades"):
        lines.append("Agreed trades: " + "; ".join(d["trades"][:8]))
    if d.get("afterTrades"):
        a = d["afterTrades"]
        still = "; ".join(a.get("failing") or []) or "none"
        lines.append(f"After the agreed trades: vol {a.get('vol')}%, mandate checks PASSED {a.get('checksPassed')} of {a.get('checksTotal')} (still failing: {still}).")
    if d.get("reportUrl"):
        lines.append(f"Full report: {d['reportUrl']}")
    return "\n".join(lines)


def persona(e):
    d = DEPTS.get(e["department"], {})
    return "\n".join([
        f"You are {e['name']}, {e['title']} at {FIRM['fullName']}, a boutique trading firm in {FIRM['city']} "
        f"(formerly a paper company — an affectionate parody of the TV show The Office).",
        f"Department: {d.get('name', '')} (formerly {d.get('formerly', '')}). Your job: {e['deskDuty']}",
        f"Voice: {e['voice']}",
        "Signature lines (use at most one, only if natural): " + " / ".join(e.get("catchphrases", [])[:3]),
    ])


def build(role, message):
    e = BY_ROLE.get(role)
    if e:
        sender, max_words = e["name"], 60
        prompt = (
            f"{persona(e)}\n\n{desk_context()}\n\n"
            "You're replying in the firm's #trading-floor Slack channel. Stay fully in character. "
            "Answer the actual question with real substance from your department's point of view, using the numbers above when they're relevant "
            "(never invent prices or news). 1–3 sentences, under 60 words. "
            "It's educational banter at a parody firm, not personalised investment advice."
        )
    else:
        dev = next(((r, n) for _w, r, n in DEV_ROUTES if r == role), None)
        sender = dev[1] if dev else "Claude"
        max_words = 15
        prompt = (
            f"You are responding as {sender}, the office {role}. Stay in character. "
            "If the conversation is about the trading desk, you can reference it:\n" + desk_context() +
            "\nKeep it short (8-12 words)."
        )
    return {"role": role, "sender": sender, "prompt": prompt, "maxWords": max_words}


def main():
    args = sys.argv[1:]
    if args and args[0] == "--chime":
        # Second voice reacting to the first reply
        role, first_reply, original = args[1], args[2], args[3]
        e = BY_ROLE[role]
        first = BY_ROLE.get(args[4]) if len(args) > 4 else None
        prompt = (
            f"{persona(e)}\n\n{desk_context()}\n\n"
            f"In #trading-floor the boss asked: \"{original}\"\n"
            f"{first['name'] if first else 'A colleague'} replied: \"{first_reply}\"\n\n"
            "Chime in with ONE short in-character reaction (under 30 words): agree, push back, or undercut them — "
            "make it about the substance, true to your character and your relationship with them."
        )
        print(json.dumps({"role": role, "sender": e["name"], "prompt": prompt, "maxWords": 30}))
        return

    message = " ".join(args) if args else sys.stdin.read()
    role = route(message)
    out = build(role, message)
    chime = None
    if role in RIVALS and BY_ROLE.get(role) and random.random() < float(os.environ.get("DESK_CHIME_CHANCE", "0.35")):
        r2 = random.choice(RIVALS[role])
        if r2 in BY_ROLE and r2 != role:
            chime = {"role": r2, "sender": BY_ROLE[r2]["name"]}
    out["chime"] = chime
    print(json.dumps(out))


if __name__ == "__main__":
    main()
