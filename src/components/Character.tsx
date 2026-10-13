import React, { useRef, useState, useEffect } from 'react'
import { Agent, AgentState } from '../types'
import SpeechBubble from './SpeechBubble'
import EffectBubble from './EffectBubble'
import { getEffect } from '../agentManager'
import { ROLE_TO_CHAR } from '../config'
import { getSpritePath, useTheme } from '../theme'

export { ROLE_TO_CHAR }

interface CharacterProps {
  agent: Agent
  /** Milliseconds the agent has been in the 'idle' state (for sleeping bubble) */
  idleDurationMs?: number
  /** Override z-index (for agents sitting behind desks) */
  zIndex?: number
  /** Show typing indicator (about to post a Slack message) */
  isTyping?: boolean
  /** Sprite height in px (Scranton floor map scales characters with the map) */
  spriteHeight?: number
  /** Iso Scranton map: pick the sprite whose face points the way they walk */
  isoFacing?: boolean
  /** Look this way while standing/sitting (e.g. at Michael, or whoever they're talking to) */
  facingOverride?: SpriteDirection
  /** Seated at a desk / meeting row / table / couch — draw the sitting pose */
  sitting?: boolean
  /** Michael can be picked up and dropped */
  pickable?: boolean
  /** currently being carried by the mouse */
  carried?: boolean
  /** click to start a conversation with them */
  clickable?: boolean
}

/** Where the hips are on the cast sprites (fraction of height from the top) and how much the legs fold. */
const HIP = 0.56
const LEG_FOLD = 0.42

// Movement direction → sprite variant
// front-left  = moving up-right
// front-right = moving up-left
// rear-left   = moving down-right
// rear-right  = not used for walking (idle/sitting only)
type SpriteDirection = 'front-left' | 'front-right' | 'rear-left' | 'rear-right'

function getDirectionFromDelta(dx: number, dy: number): SpriteDirection {
  // In isometric view:
  //   up-right   → front-left
  //   up-left    → front-right
  //   down-right → rear-left
  //   down-left  → front-left (facing camera, moving left)
  if (dy < 0 && dx >= 0)  return 'front-left'   // up-right
  if (dy < 0 && dx < 0)   return 'front-right'  // up-left
  if (dy >= 0 && dx >= 0)  return 'rear-left'    // down-right
  return 'front-left'                             // down-left
}

// The cast sprites are named from the character's point of view:
// front-left faces screen down-right, front-right faces down-left,
// rear-left faces up-left, rear-right faces up-right.
function getIsoDirection(dx: number, dy: number): SpriteDirection {
  if (dy >= 0) return dx >= 0 ? 'front-left' : 'front-right'
  return dx >= 0 ? 'rear-right' : 'rear-left'
}

function getCharBase(role: string): string {
  return ROLE_TO_CHAR[role] ?? 'employee-3'
}

function getAnimState(state: AgentState): string {
  switch (state) {
    case 'working':             return 'working'
    case 'walking-to-manager':
    case 'walking-to-desk':     return 'walking'
    case 'talking-to-manager':  return 'talking'
    case 'coffee-break':        return 'coffee'
    case 'new-hire':            return 'new-hire'
    default:                    return 'idle'
  }
}

// Speech bubble only shown briefly when statusText changes (like posting to Slack)
function shouldShowBubble(state: AgentState): boolean {
  return state === 'talking-to-manager'
}

// Opposite direction for random "looking around"
const OPPOSITE: Record<SpriteDirection, SpriteDirection> = {
  'front-left': 'rear-right',
  'front-right': 'rear-left',
  'rear-left': 'front-right',
  'rear-right': 'front-left',
}

const Character: React.FC<CharacterProps> = ({ agent, idleDurationMs = 0, zIndex, isTyping, spriteHeight, isoFacing, facingOverride, sitting, pickable, carried, clickable }) => {
  const prevPosRef = useRef({ x: agent.position.x, y: agent.position.y })
  const directionRef = useRef<SpriteDirection>(agent.spriteFacing ?? 'front-right')
  const [turnedAround, setTurnedAround] = useState(false)

  const isMoving = agent.state === 'new-hire' || agent.state === 'walking-to-desk' ||
    agent.state === 'coffee-break' || agent.state === 'completed' || agent.state === 'changing-room'

  // Calculate movement direction when walking
  const dx = agent.position.x - prevPosRef.current.x
  const dy = agent.position.y - prevPosRef.current.y

  if (isMoving && (Math.abs(dx) > 0.005 || Math.abs(dy) > 0.005)) {
    // dx/dy are in map %, the map is ~1.8× wider than tall — compare in screen terms
    directionRef.current = isoFacing ? getIsoDirection(dx, dy * 0.56) : getDirectionFromDelta(dx, dy)
  } else if (!isMoving && facingOverride) {
    directionRef.current = facingOverride
  } else if (!isMoving && agent.spriteFacing) {
    // At a spot — use the spot's facing direction (or opposite if turned around)
    // iso map: people keep their eyes on the screen (no random turning around)
    directionRef.current = turnedAround && !isoFacing ? OPPOSITE[agent.spriteFacing] : agent.spriteFacing
  }
  prevPosRef.current = { x: agent.position.x, y: agent.position.y }

  // Randomly turn around while working at desk for random durations
  useEffect(() => {
    if (agent.state !== 'working') {
      setTurnedAround(false)
      return
    }

    // cancelledRef prevents stale callbacks from firing after cleanup
    const cancelledRef = { current: false }
    let timeout: ReturnType<typeof setTimeout>

    const scheduleTurn = () => {
      if (cancelledRef.current) return
      // Wait 3–15 seconds before turning
      const waitTime = 3000 + Math.random() * 12000
      timeout = setTimeout(() => {
        if (cancelledRef.current) return
        setTurnedAround(prev => !prev)
        // Stay turned for 1–6 seconds then maybe turn back
        const stayTime = 1000 + Math.random() * 5000
        timeout = setTimeout(() => {
          if (cancelledRef.current) return
          setTurnedAround(prev => !prev)
          scheduleTurn()
        }, stayTime)
      }, waitTime)
    }

    scheduleTurn()
    return () => {
      cancelledRef.current = true
      clearTimeout(timeout)
    }
  }, [agent.state])

  const animState = getAnimState(agent.state)
  const charBase = getCharBase(agent.role)
  const theme = useTheme() // Why: re-render on theme toggle so sprite path updates
  const spriteSrc = getSpritePath(agent.id, agent.role, charBase, directionRef.current)
  void theme

  const effectSrc = isTyping
    ? '/sprites/effects/typing.png'
    : getEffect(agent.state, idleDurationMs, agent.statusText, agent.id, agent.task, agent.role)

  return (
    <div
      className={`character-wrapper state-${animState}${sitting && !carried ? ' seated' : ''}${carried ? ' carried' : ''}${pickable ? ' pickable' : ''}${clickable ? ' clickable' : ''}`}
      data-pick={pickable ? agent.id : undefined}
      data-person={clickable ? agent.id : undefined}
      title={pickable ? 'Drag to pick up Michael and drop him anywhere' : clickable ? 'Click to talk' : undefined}
      style={{
        left: `${agent.position.x}%`,
        top: `${agent.position.y}%`,
        transform: 'translate(-50%, -100%)',
        zIndex: zIndex ?? Math.round(agent.position.y),
      }}
    >
      {effectSrc && <EffectBubble src={effectSrc} alt={agent.state} />}

      {shouldShowBubble(agent.state) && agent.statusText && (
        <SpeechBubble key={agent.statusText} text={agent.statusText} />
      )}

      <div className="char-body-group">
        <div className="char-shadow" />
        {sitting && !carried ? (() => {
          // Seated pose: torso as drawn, legs folded (foreshortened thighs) — feet stay on the floor
          const H = spriteHeight ?? (agent.id.startsWith('boss-') ? 85 : 78)
          const top = Math.round(H * HIP), legs = Math.max(1, Math.round(H * (1 - HIP) * LEG_FOLD))
          const imgStyle: React.CSSProperties = {
            height: H, width: 'auto',
            filter: `drop-shadow(0 0 1px ${agent.color}) drop-shadow(0 0 0.5px #000)`,
            animationDelay: `${(agent.id.charCodeAt(0) * 0.37) % 3}s`,
          }
          return (
            <div className="char-seated">
              <div style={{ height: top, overflow: 'hidden' }}>
                <img src={spriteSrc} alt={agent.name} className="char-sprite" style={imgStyle} draggable={false} />
              </div>
              <div style={{ height: legs, overflow: 'hidden' }}>
                <img src={spriteSrc} alt="" className="char-sprite char-legs" draggable={false}
                  style={{ ...imgStyle, transformOrigin: 'top', transform: `translateY(${-top * LEG_FOLD}px) scaleY(${LEG_FOLD})` }} />
              </div>
            </div>
          )
        })() : (
          <img
            src={spriteSrc}
            alt={agent.name}
            className="char-sprite"
            style={{
              height: spriteHeight ?? (agent.id.startsWith('boss-') ? 85 : 78),
              width: 'auto',
              filter: `drop-shadow(0 0 1px ${agent.color}) drop-shadow(0 0 0.5px #000)`,
              animationDelay: `${(agent.id.charCodeAt(0) * 0.37) % 3}s`,
            }}
            draggable={false}
          />
        )}
      </div>
    </div>
  )
}

export default Character
