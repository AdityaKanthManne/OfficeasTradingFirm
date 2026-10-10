/**
 * llm.js — runs one in-character agent turn through the Claude Code CLI
 * (`claude -p`), the same engine the office chat watcher already uses.
 */

import { spawn, execFileSync } from 'child_process'

let cliChecked = null
export function claudeAvailable() {
  if (cliChecked !== null) return cliChecked
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { stdio: 'ignore' })
    cliChecked = true
  } catch {
    cliChecked = false
  }
  return cliChecked
}

/** Run `claude -p` and resolve with stdout text (rejects on error/timeout). */
export function runClaude(prompt, { model, liveResearch, timeoutSec = 150 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'text']
    if (liveResearch) args.push('--max-turns', '8', '--allowedTools', 'WebSearch,WebFetch')
    else args.push('--max-turns', '1')
    if (model) args.push('--model', model)

    const child = spawn('claude', args, {
      env: { ...process.env, AGENT_OFFICE_DESK: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('timeout')) }, timeoutSec * 1000)
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0 && out.trim()) resolve(out.trim())
      else reject(new Error(`claude exited ${code}: ${err.slice(0, 200)}`))
    })
    // Prompt via stdin — avoids argv length limits on big books
    child.stdin.write(prompt)
    child.stdin.end()
  })
}

/** Pull the first JSON object out of a model reply (tolerates code fences / chatter). */
export function extractJson(text) {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidates = [fenced?.[1], text]
  for (const c of candidates) {
    if (!c) continue
    const start = c.indexOf('{')
    const end = c.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    try { return JSON.parse(c.slice(start, end + 1)) } catch {}
  }
  return null
}
