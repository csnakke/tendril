import type { Settings } from './settings'

/**
 * "Prompt Me": one chat completion against whichever OpenAI-compatible
 * endpoint Settings > AI has active — a local server (Ollama, LM Studio,
 * llama.cpp, …) or OpenRouter. Requests go from the main process so the
 * renderer's CSP and CORS never get in the way.
 */

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1'

const SYSTEM_PROMPT =
  'You are a writing assistant inside a Markdown editor. Reply with Markdown that can be inserted ' +
  'into the document as is: no preamble, no closing remarks, and no code fence around the whole answer.'

interface Endpoint {
  base: string
  model: string
  headers: Record<string, string>
}

function endpoint(s: Settings): Endpoint {
  if (s.llmProvider === 'openrouter') {
    if (!s.openRouterKey.trim()) throw new Error('No OpenRouter API key. Add one in Settings › AI.')
    return {
      base: OPENROUTER_URL,
      model: s.openRouterModel.trim(),
      headers: { Authorization: `Bearer ${s.openRouterKey.trim()}`, 'HTTP-Referer': 'https://github.com/csnakke/tendril', 'X-Title': 'Tendril' }
    }
  }
  if (s.llmProvider === 'local') {
    const base = s.llmLocalUrl.trim().replace(/\/+$/, '')
    if (!base) throw new Error('No local server URL. Add one in Settings › AI.')
    return { base, model: s.llmLocalModel.trim(), headers: {} }
  }
  throw new Error('No AI provider is active. Choose one in Settings › AI.')
}

/** How long the server gets to start answering; a reply, once streaming, is not timed (Escape cancels it). */
const CONNECT_TIMEOUT_MS = 180_000

async function request(ep: Endpoint, path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  let res: Response
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new DOMException('Timed out', 'TimeoutError')), CONNECT_TIMEOUT_MS)
  try {
    res = await fetch(ep.base + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...ep.headers, ...(init.headers as Record<string, string> | undefined) },
      signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
    })
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } }
    if (e.name === 'AbortError') throw e
    throw new Error(e.name === 'TimeoutError' ? 'The server did not answer in time.' : `Could not reach ${ep.base}: ${e.cause?.code ?? e.message}`)
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const body = await res.text()
    let msg: string | undefined
    try {
      msg = (JSON.parse(body) as { error?: { message?: string } }).error?.message
    } catch {
      /* not JSON */
    }
    throw new Error(`${res.status} ${res.statusText}${msg ? ': ' + msg : body ? ': ' + body.slice(0, 200) : ''}`)
  }
  return res
}

async function json(res: Response, base: string): Promise<unknown> {
  const body = await res.text()
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`Unexpected reply from ${base}: ${body.slice(0, 200)}`)
  }
}

type Content = string | { text?: string }[] | undefined
const contentText = (c: Content): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text ?? '').join('') : '')

/**
 * The assistant's reply to `prompt`, streamed: `onDelta` receives each piece
 * of text as it arrives and the promise resolves with the whole reply.
 * `selection` (the editor's selected text, if any) goes along as context.
 * A server that answers with plain JSON instead of an event stream still works.
 */
export async function complete(s: Settings, prompt: string, selection: string, onDelta: (text: string) => void, signal?: AbortSignal): Promise<string> {
  const ep = endpoint(s)
  if (!ep.model) throw new Error('No model set. Enter one in Settings › AI.')
  const user = selection ? `${prompt}\n\nSelected text:\n"""\n${selection}\n"""` : prompt
  const res = await request(
    ep,
    '/chat/completions',
    { method: 'POST', body: JSON.stringify({ model: ep.model, stream: true, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }] }) },
    signal
  )
  let text = ''
  if (!/text\/event-stream/i.test(res.headers.get('content-type') ?? '') || !res.body) {
    const whole = (await json(res, ep.base)) as { choices?: { message?: { content?: Content } }[] }
    text = contentText(whole.choices?.[0]?.message?.content)
    if (text) onDelta(text)
  } else {
    // Server-sent events: "data: {chunk}" lines, "data: [DONE]" at the end.
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') continue
        let chunk: { choices?: { delta?: { content?: Content } }[]; error?: { message?: string } }
        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }
        if (chunk.error?.message) throw new Error(chunk.error.message)
        const piece = contentText(chunk.choices?.[0]?.delta?.content)
        if (piece) {
          text += piece
          onDelta(piece)
        }
      }
      if (done) break
    }
  }
  if (!text.trim()) throw new Error('The model returned an empty reply.')
  return text
}

/** Settings › AI "Test": can the endpoint be reached, and does it know the model? */
export async function test(s: Settings): Promise<string> {
  const ep = endpoint(s)
  const list = (await json(await request(ep, '/models'), ep.base)) as { data?: { id?: string }[] }
  const ids = (list.data ?? []).map((m) => m.id ?? '')
  if (ep.model && ids.length && !ids.includes(ep.model)) return `Connected (${ids.length} models), but "${ep.model}" is not among them.`
  return ep.model ? `Connected; "${ep.model}" is available.` : `Connected (${ids.length} models). Enter a model name.`
}
