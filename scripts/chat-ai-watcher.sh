#!/usr/bin/env bash
# =============================================================================
# chat-ai-watcher.sh — Watches office chat and replies in character
# (Dunder Mifflin Capital employees by name/topic, or the original dev agents)
# Started by start-office.sh, stopped by stop-office.sh
# =============================================================================

set -u

SERVER="http://127.0.0.1:3334"
POLL_INTERVAL=8
PID_FILE="$HOME/.agent-office/chat-watcher.pid"
STATE_DIR="$HOME/.agent-office"
LAST_TS_FILE="$STATE_DIR/chat-ai-last-ts"

LOCK_FILE="$STATE_DIR/chat-ai.lock"

mkdir -p "$STATE_DIR"
echo $$ > "$PID_FILE"

# Initialise last-seen timestamp to now
if [ -f "$LAST_TS_FILE" ]; then
    LAST_TS=$(cat "$LAST_TS_FILE")
else
    LAST_TS=$(date +%s)000
    echo "$LAST_TS" > "$LAST_TS_FILE"
fi

echo "[chat-ai] Started (pid $$), polling every ${POLL_INTERVAL}s"

cleanup() { rm -f "$PID_FILE" "$LOCK_FILE"; echo "[chat-ai] Stopped"; exit 0; }
trap cleanup EXIT INT TERM

while true; do
    sleep "$POLL_INTERVAL"

    # Check server
    curl -sf "$SERVER/health" > /dev/null 2>&1 || continue

    # Check AI toggle
    IS_PAUSED=$(curl -sf "$SERVER/chat/cron-state" 2>/dev/null | python3 -c "import sys,json; print('true' if json.load(sys.stdin).get('paused') else 'false')" 2>/dev/null || echo "true")
    [ "$IS_PAUSED" = "true" ] && continue

    # Fetch messages since last seen
    RESPONSE=$(curl -sf "$SERVER/chat?since=$LAST_TS" 2>/dev/null || echo '{"messages":[]}')

    # Check for new user messages (not from Claude or system)
    RESULT=$(echo "$RESPONSE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
msgs = data.get('messages', [])
# Why: only the human's own messages (role 'default'); agents/desk characters post with their role,
# and slash commands (/portfolio, /desk…) are handled by the server.
user_msgs = [m for m in msgs
             if m.get('sender','').lower() not in ('claude', 'system')
             and m.get('role', 'default') == 'default'
             and not m.get('is_system')
             and not str(m.get('text','')).startswith('/')]
if user_msgs:
    last = user_msgs[-1]
    print(last.get('text', ''))
else:
    print('')
# Always update to latest timestamp
if msgs:
    print(msgs[-1]['timestamp'], file=sys.stderr)
" 2>"$STATE_DIR/chat-ai-ts-tmp")

    # Update timestamp
    NEW_TS=$(cat "$STATE_DIR/chat-ai-ts-tmp" 2>/dev/null | head -1)
    rm -f "$STATE_DIR/chat-ai-ts-tmp"
    if [ -n "$NEW_TS" ]; then
        LAST_TS="$NEW_TS"
        echo "$LAST_TS" > "$LAST_TS_FILE"
    fi

    # Skip if no new user message
    [ -z "$RESULT" ] && continue

    # Skip if already generating a reply (prevent concurrent claude -p)
    if [ -f "$LOCK_FILE" ]; then
        echo "[chat-ai] Skipping — already generating a reply"
        continue
    fi

    echo "[chat-ai] New message: $RESULT"
    touch "$LOCK_FILE"

    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

    # Route to a Dunder Mifflin Capital employee (by name or topic) or a dev agent.
    # desk-router.py reads firm/roster.json + the desk's latest book for context.
    ROUTE_JSON=$(python3 "$SCRIPT_DIR/desk-router.py" "$RESULT" 2>/dev/null)
    if [ -z "$ROUTE_JSON" ]; then
        echo "[chat-ai] Router failed, skipping"
        rm -f "$LOCK_FILE"; continue
    fi
    jget() { echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d; [v:=v.get(k) if isinstance(v,dict) else None for k in sys.argv[1].split('.')]; print('' if v is None else v)" "$2"; }
    AGENT_ROLE=$(jget "$ROUTE_JSON" role)
    AGENT_NAME=$(jget "$ROUTE_JSON" sender)
    ROLE_PROMPT=$(jget "$ROUTE_JSON" prompt)
    MAX_WORDS=$(jget "$ROUTE_JSON" maxWords)
    CHIME_ROLE=$(jget "$ROUTE_JSON" chime.role)

    echo "[chat-ai] Routed to: $AGENT_NAME ($AGENT_ROLE)"
    echo "[chat-ai] Generating reply..."

    # Gather dev context
    DEV_CONTEXT=$(bash "$SCRIPT_DIR/gather-context.sh" 2>/dev/null || echo "")

    # Load persona file
    PERSONA=""
    if [ -f "$HOME/.agent-office/claude-persona.md" ]; then
        PERSONA=$(cat "$HOME/.agent-office/claude-persona.md")
    fi

    # Fetch last 10 messages for context
    CONTEXT=$(curl -sf "$SERVER/chat" 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
msgs = data.get('messages', [])[-10:]
lines = []
for m in msgs:
    s = m.get('sender','?')
    t = m.get('text','')
    lines.append(f'{s}: {t}')
print(chr(10).join(lines))
" 2>/dev/null)

    PROMPT="$PERSONA

$ROLE_PROMPT

$DEV_CONTEXT

Recent conversation:
$CONTEXT

Reply to the latest message naturally. Continue the conversation — reference previous messages if relevant. Reply with only your message."

    post_reply() {
        CHAT_REPLY="$1" CHAT_ROLE="$2" CHAT_SENDER="$3" python3 -c "
import urllib.request, json, os
data = json.dumps({
    'sender': os.environ.get('CHAT_SENDER', 'Claude'),
    'role': os.environ.get('CHAT_ROLE', 'assistant'),
    'text': os.environ.get('CHAT_REPLY', '')
}).encode()
req = urllib.request.Request('http://127.0.0.1:3334/chat/reply', data=data,
    headers={'Content-Type': 'application/json'}, method='POST')
try: urllib.request.urlopen(req, timeout=5)
except: pass
" 2>/dev/null
    }
    trim_words() { python3 -c "import sys; w=sys.stdin.read().strip().split(); n=int(sys.argv[1]); print(' '.join(w[:n]) + ('…' if len(w) > n else ''))" "$1"; }

    # Call Claude CLI
    REPLY=$(claude -p "$PROMPT" --max-turns 1 2>/dev/null | tr '\n' ' ' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

    [ -z "$REPLY" ] && { echo "[chat-ai] Empty reply, skipping"; rm -f "$LOCK_FILE"; continue; }

    REPLY=$(echo "$REPLY" | trim_words "${MAX_WORDS:-15}")
    echo "[chat-ai] Replying as $AGENT_NAME: $REPLY"
    post_reply "$REPLY" "$AGENT_ROLE" "$AGENT_NAME"

    # Sometimes a colleague can't help themselves and chimes in (Dwight vs Jim, Angela vs Kevin…)
    if [ -n "$CHIME_ROLE" ]; then
        sleep 3
        CHIME_JSON=$(python3 "$SCRIPT_DIR/desk-router.py" --chime "$CHIME_ROLE" "$REPLY" "$RESULT" "$AGENT_ROLE" 2>/dev/null)
        if [ -n "$CHIME_JSON" ]; then
            CHIME_NAME=$(jget "$CHIME_JSON" sender)
            CHIME_PROMPT=$(jget "$CHIME_JSON" prompt)
            CHIME=$(claude -p "$CHIME_PROMPT" --max-turns 1 2>/dev/null | tr '\n' ' ' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | trim_words 30)
            if [ -n "$CHIME" ]; then
                echo "[chat-ai] $CHIME_NAME chimes in: $CHIME"
                post_reply "$CHIME" "$CHIME_ROLE" "$CHIME_NAME"
            fi
        fi
    fi

    rm -f "$LOCK_FILE"
    echo "[chat-ai] Done"
done
