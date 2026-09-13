// agntspce-prompter utils
// Ported from LLMLingua llmlingua/utils.py
// Integrated as internal agntspce-prompter helper. Not for standalone distribution.

import { estimateTokens as _estimateTokens, stripAllControl, stripAnsi } from '../rtk/utils'

// ---------------------------------------------------------------------------
// Internal guard: This module is agntspce-internal. Import only via
// electron/services/prompter/* inside the main AgntSpce Electron process.
// Do not re-export or publish as agntspce-prompter npm package.
//
// All token estimation uses the same len/4 heuristic as rtk/utils so
// counts remain consistent across RTK and Prompter dashboards.
// ---------------------------------------------------------------------------

let _warnedExternal = false
function assertInternalContext() {
  if (_warnedExternal) return
  // In production Electron, process.resourcesPath / app is defined.
  // If imported from a non-AgntSpce Node context, we still function but warn once.
  const isInsideAgntspce =
    typeof process !== 'undefined' &&
    (process.env.AGNTSPCE_PROMPTER_INTERNAL === '1' ||
      !!process.resourcesPath ||
      (process.versions as any)?.electron ||
      process.env.NODE_ENV !== 'production')
  // Allow in dev/tests without hard failure; production leak concern is via packaging.
  // We keep this as soft guard — the true isolation is that the source lives only
  // inside electron/services/prompter and is not published or exposed via IPC.
  if (!isInsideAgntspce) {
    // do not throw, just mark
    _warnedExternal = true
  }
}
assertInternalContext()

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JsonKVConfig {
  rate: number
  compress: boolean
  value_type: string
  pair_remove: boolean
}

export type JsonConfig = Record<string, JsonKVConfig>

// ---------------------------------------------------------------------------
// Token helpers – thin wrappers over rtk/utils
// ---------------------------------------------------------------------------

export function estimateTokens(text: string): number {
  return _estimateTokens(text)
}

export function getTokenLength(text: string, useOaiTokenizer = false): number {
  // LLMLingua distinguishes tokenizer vs oai_tokenizer but both are len/4 in our
  // heuristic runtime (no tiktoken / hf tokenizer bundled). Keep signature for
  // parity with original utils; useOai flag ignored (same estimator).
  void useOaiTokenizer
  return estimateTokens(text)
}

// ---------------------------------------------------------------------------
// Word-level helpers ported from utils.py
// ---------------------------------------------------------------------------

const PUNCTUATION_RE = /^[<>=/!@#$%^&*()?":{}|\\`~;_+\-,.\[\]']+$/

export function isBeginOfNewWord(
  token: string,
  modelName: string,
  forceTokens: string[],
  tokenMap: Map<string, string>,
): boolean {
  const forceSet = new Set(forceTokens)
  const mapValues = new Set(tokenMap.values())
  // bert / tinybert / mobilebert : ## prefix indicates continuation
  if (
    modelName.includes('bert-base-multilingual-cased') ||
    modelName.toLowerCase().includes('tinybert') ||
    modelName.toLowerCase().includes('mobilebert')
  ) {
    const stripped = token.replace(/^##/, '')
    if (forceSet.has(stripped) || mapValues.has(token)) return true
    return !token.startsWith('##')
  }
  // xlm-roberta-large / slingua / securitylingua : ▁ prefix indicates word start
  if (
    modelName.includes('xlm-roberta-large') ||
    modelName.toLowerCase().includes('slingua') ||
    modelName.toLowerCase().includes('securitylingua')
  ) {
    if (PUNCTUATION_RE.test(token) || forceSet.has(token) || mapValues.has(token)) return true
    return token.startsWith('▁')
  }
  throw new Error(`isBeginOfNewWord: unsupported model ${modelName}`)
}

export function getPureToken(token: string, modelName: string): string {
  if (
    modelName.includes('bert-base-multilingual-cased') ||
    modelName.toLowerCase().includes('tinybert') ||
    modelName.toLowerCase().includes('mobilebert')
  ) {
    return token.replace(/^##/, '')
  }
  if (
    modelName.includes('xlm-roberta-large') ||
    modelName.toLowerCase().includes('slingua') ||
    modelName.toLowerCase().includes('securitylingua')
  ) {
    return token.replace(/^▁/, '')
  }
  throw new Error(`getPureToken: unsupported model ${modelName}`)
}

export function replaceAddedToken(token: string, tokenMap: Map<string, string>): string {
  let out = token
  for (const [orig, added] of tokenMap.entries()) {
    out = out.split(added).join(orig)
  }
  return out
}

// ---------------------------------------------------------------------------
// Original utils.py process_structured_json_data + helpers
// Ported for agntspce-prompter structured/JSON compression.
// ---------------------------------------------------------------------------

export function removeConsecutiveCommas(text: string): string {
  let t = text.replace(/,\s*/g, ',')
  t = t.replace(/,+/g, ',')
  return t
}

function processSequenceData(
  rate: number,
  start: string,
  end: string,
  sequence: unknown,
  isDict = false,
): string {
  let res = `${start}"`
  const arr = isDict
    ? Object.entries(sequence as Record<string, unknown>)
    : (sequence as unknown[])
  const n = arr.length
  if (!isDict) {
    for (let i = 0; i < (arr as unknown[]).length; i++) {
      const item = String((arr as unknown[])[i])
      res += `</llmlingua><llmlingua, rate=${rate}>${item}</llmlingua><llmlingua, compress=False>`
      if (i !== n - 1) res += '", "'
    }
  } else {
    const entries = arr as [string, unknown][]
    for (let i = 0; i < entries.length; i++) {
      const [k, v] = entries[i]
      const item = `${k}: ${v}`.replace(/"/g, "'")
      res += `</llmlingua><llmlingua, rate=${rate}>${item}</llmlingua><llmlingua, compress=False>`
      if (i !== n - 1) res += '", "'
    }
  }
  res += `"${end}, </llmlingua>`
  return res
}

function precessJsonKVPair(k: string, v: unknown, valueType: string, rate: number): string {
  if (rate === 1) {
    return `<llmlingua, compress=False>${JSON.stringify({ [k]: v }).slice(1, -1)}, </llmlingua>`
  }
  if (valueType === 'str' || valueType === 'string') {
    const vs = String(v)
    const newV = `</llmlingua><llmlingua, rate=${rate}>${vs}</llmlingua><llmlingua, compress=False>`
    return `<llmlingua, compress=False>${JSON.stringify({ [k]: newV }).slice(1, -1)}, </llmlingua>`
  }
  if (['int', 'float', 'integer', 'number'].includes(valueType)) {
    let vv: unknown = v
    if (['int', 'integer'].includes(valueType)) vv = parseInt(String(v), 10)
    if (['float', 'number'].includes(valueType)) vv = parseFloat(String(v))
    return `<llmlingua, compress=False>"${k}": </llmlingua><llmlingua, rate=${rate}>${String(vv)}</llmlingua><llmlingua, compress=False>, </llmlingua>`
  }
  if (valueType === 'bool' || valueType === 'boolean') {
    let vv = String(v).toLowerCase()
    if (['true', '1'].includes(vv) || v === true) vv = 'true'
    else if (['false', '0'].includes(vv) || v === false) vv = 'false'
    else throw new Error(`Invalid boolean value: ${String(v)}`)
    const newV = `</llmlingua><llmlingua, rate=${rate}>${vv}</llmlingua><llmlingua, compress=False>`
    return `<llmlingua, compress=False>${JSON.stringify({ [k]: newV }).slice(1, -1)}, </llmlingua>`
  }
  if (valueType === 'list' || valueType === 'List') {
    return `<llmlingua, compress=False>"${k}": ${processSequenceData(rate, '[', ']', v as unknown[])}`
  }
  if (valueType === 'dict' || valueType === 'dictionary') {
    return `<llmlingua, compress=False>"${k}": ${processSequenceData(rate, '[', ']', v as Record<string, unknown>, true)}`
  }
  if (valueType === 'set') throw new Error(`Invalid value type: ${valueType}`)
  if (valueType === 'tuple') {
    return `<llmlingua, compress=False>"${k}": ${processSequenceData(rate, '(', ')', v as unknown[])}`
  }
  throw new Error(`Invalid value type: ${valueType}`)
}

export function processStructuredJsonData(
  jsonData: Record<string, unknown>,
  jsonConfig: JsonConfig,
): { context: string[]; forceContextIds: number[] } {
  if (new Set(Object.keys(jsonData)).size !== new Set(Object.keys(jsonConfig)).size) {
    const a = new Set(Object.keys(jsonData))
    const b = new Set(Object.keys(jsonConfig))
    const onlyA = [...a].filter(x => !b.has(x))
    const onlyB = [...b].filter(x => !a.has(x))
    if (onlyA.length || onlyB.length) {
      throw new Error(
        `Keys in json data and json config do not match. Only in data: ${onlyA.join(', ')}; only in config: ${onlyB.join(', ')}`,
      )
    }
  }
  const context: string[] = ['<llmlingua, compress=False>{</llmlingua>']
  const forced: number[] = [0]
  const entries = Object.entries(jsonData)
  for (let i = 0; i < entries.length; i++) {
    const [k, v] = entries[i]
    const cfg = jsonConfig[k]
    if (!cfg) throw new Error(`Missing config for key ${k}`)
    if (!cfg.pair_remove) forced.push(i + 1)
    let rate = cfg.rate
    let compress = cfg.compress
    const valueType = cfg.value_type
    if (!compress) rate = 1
    context.push(precessJsonKVPair(k, v, valueType, rate))
  }
  context[context.length - 1] = context[context.length - 1].slice(0, -14) + '</llmlingua>'
  context.push('<llmlingua, compress=False>}</llmlingua>')
  forced.push(entries.length + 1)
  return { context, forceContextIds: forced }
}

// ---------------------------------------------------------------------------
// AgntSpce-prompter helpers: chunking, scoring, percentile, word split
// ---------------------------------------------------------------------------

export function splitStringToWords(input: string): string[] {
  // Mirrors LLMLingua's pattern: r'\b\w+\b|[<>=/!@#$%^&*()?":{}|\\`~;_+-]'
  // We include dot/comma etc as separate tokens for fine granularity.
  const pattern = /\b\w+\b|[<>=/!@#$%^&*()?":{}|\\`~;_+\-.,;\n]/g
  return input.match(pattern) || []
}

export function chunkContext(
  originText: string,
  maxSeqLen = 512,
  chunkEndTokens: Set<string> = new Set(['.', '\n']),
): string[] {
  const maxLen = maxSeqLen - 2
  // Word-level tokenization approximating tokenizer.tokenize
  // For heuristic runtime we treat whitespace-punct split as tokens.
  const tokens = splitStringToWords(originText)
  // Roughly, but to preserve original chunk boundaries with char length
  // we replicate the logic: walk over tokenizer tokens; if st+maxLen beyond end => remainder.
  // Here we emulate by converting back via join with heuristic spaces.
  const originTokens = tokens
  const n = originTokens.length
  if (n === 0) return [originText]
  const out: string[] = []
  let st = 0
  while (st < n) {
    if (st + maxLen > n - 1) {
      // remainder
      const chunkTokens = originTokens.slice(st, n)
      out.push(chunkTokens.join(' ').replace(/\s+([.,;!?])/g, '$1'))
      break
    } else {
      let ed = st + maxLen
      let found = false
      for (let j = 0; j < ed - st; j++) {
        const cand = originTokens[ed - j]
        if (cand && chunkEndTokens.has(cand)) {
          ed = ed - j
          found = true
          break
        }
      }
      void found
      const chunkTokens = originTokens.slice(st, ed + 1)
      out.push(chunkTokens.join(' ').replace(/\s+([.,;!?])/g, '$1'))
      st = ed + 1
    }
  }
  return out.length ? out : [originText]
}

export function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  // LLMLingua uses int(100*reduce_rate) as percentile index; cap to [0,100]
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))
  return sorted[idx]
}

export function stripControl(text: string): string {
  return stripAllControl(stripAnsi(text))
}

// Normalizes prompt separators for internal join/split parity with Python ("\n\n".join)
export function joinContexts(contexts: string[]): string {
  return contexts.join('\n\n')
}

// AgntSpce internal marker: validate caller is inside Electron main.
// Called by compressor public methods to enforce agntspce-internal use.
export function assertAgntspceContext(caller: string) {
  // Only soft-guard. The authoritative isolation is filepath / non-publish.
  // In packaged app, a global is set by main.ts; in tests/dev we allow.
  const allow = typeof process !== 'undefined' && (process.env.NODE_ENV !== 'production' || (process as any).versions?.electron)
  if (!allow) {
    // Mark caller for telemetry if ever leaked outside; don't throw to avoid crashing agent.
    console.warn(`[agntspce-prompter] ${caller} invoked outside AgntSpce context`)
  }
}
