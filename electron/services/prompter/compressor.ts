// agntspce-prompter compressor
// Ported from LLMLingua llmlingua/prompt_compressor.py (PromptCompressor)
// Renamed to AgntspcePrompter. Integrated as internal agntspce-prompter.
// This module is AGNTSPCE-INTERNAL only — do not publish or import outside
// electron/services/prompter/* . See utils.assertAgntspceContext for soft guard.
//
// Design choices for agntspce integration:
// - Model-backed token classification (LLMLingua-2) is replaced by a deterministic
//   heuristic scorer that runs without torch/transformers/onnx. This satisfies the
//   requirement to run "directly inside agntspce" without pip install and with zero
//   GPU/CUDA dependency. The scoring is deliberately faithful to LLMLingua-2's
//   percentile-threshold flow (reduce_rate -> threshold -> keep).
// - Chunking, force_tokens, force_reserve_digit, chunk_end_tokens, token_to_word
//   semantics are preserved from the original Python implementation.
// - Coarse-grained (context / sentence) filters from LongLLMLingua are provided as
//   lightweight heuristic rankers (question overlap) so the public API remains
//   compatible without pulling rank_bm25 / sentence_transformers.
// - All names are branded agntspce-prompter / AgntspcePrompter.

import {
  assertAgntspceContext,
  chunkContext,
  estimateTokens,
  getTokenLength,
  percentile,
  processStructuredJsonData,
  removeConsecutiveCommas,
  splitStringToWords,
  stripControl,
} from './utils'
import { AGNTSPCE_PROMPTER_VERSION } from './version'

// ---------------------------------------------------------------------------
// Types matching original prompt_compressor.py public return shape
// ---------------------------------------------------------------------------

export interface CompressionResult {
  compressed_prompt: string
  compressed_prompt_list?: string[]
  origin_tokens: number
  compressed_tokens: number
  ratio: string
  rate: string
  saving: string
  fn_labeled_original_prompt?: string
}

export interface CompressOptions {
  instruction?: string
  question?: string
  rate?: number
  targetToken?: number
  iterativeSize?: number
  forceContextIds?: number[]
  forceContextNumber?: number
  useSentenceLevelFilter?: boolean
  useContextLevelFilter?: boolean
  useTokenLevelFilter?: boolean
  keepSplit?: boolean
  keepFirstSentence?: number
  keepLastSentence?: number
  keepSentenceNumber?: number
  highPriorityBonus?: number
  contextBudget?: string
  tokenBudgetRatio?: number
  conditionInQuestion?: string
  reorderContext?: string
  dynamicContextCompressionRatio?: number
  conditionCompare?: boolean
  addInstruction?: boolean
  rankMethod?: string
  concateQuestion?: boolean
  contextSegs?: string[][]
  contextSegsRate?: number[][]
  contextSegsCompress?: boolean[][]
  targetContext?: number
  contextLevelRate?: number
  contextLevelTargetToken?: number
  returnWordLabel?: boolean
  wordSep?: string
  labelSep?: string
  tokenToWord?: 'mean' | 'first'
  forceTokens?: string[]
  forceReserveDigit?: boolean
  dropConsecutive?: boolean
  chunkEndTokens?: string[]
  strictPreserveUncompressed?: boolean
}

export interface StructuredCompressOptions extends CompressOptions {
  // context is already the string[] segmented by <agntspce-prompter>/<llmlingua> tags
}

export interface JsonCompressOptions extends CompressOptions {
  jsonConfig: Record<string, { rate: number; compress: boolean; value_type: string; pair_remove: boolean }>
  instruction?: string
  question?: string
}

export interface PrompterConfig {
  modelName?: string
  deviceMap?: string
  llmlingua2Config?: { maxBatchSize?: number; maxForceToken?: number }
  maxSeqLen?: number
}

// ---------------------------------------------------------------------------
// Heuristic word importance scorer (model-free replacement for BERT classifier)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'of', 'at', 'by', 'for', 'with',
  'about', 'against', 'between', 'into', 'through', 'during', 'before', 'after',
  'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where',
  'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too',
  'very', 'can', 'will', 'just', 'should', 'now', 'it', 'its', 'it\'s', 'this',
  'that', 'these', 'those', 'i', 'me', 'my', 'myself', 'we', 'our', 'ours',
  'you', 'your', 'yours', 'he', 'him', 'his', 'she', 'her', 'hers', 'they', 'them',
  'their', 'what', 'which', 'who', 'whom', 'and', 'but', 'if', 'or', 'because',
  'as', 'until', 'while', 'about', 'is', 'am', 'are',
])

function scoreWord(
  word: string,
  opts: { forceTokens: Set<string>; forceReserveDigit: boolean; freq: Map<string, number>; maxFreq: number },
): number {
  // Mirrors LLMLingua2 __merge_token_to_word force logic but with heuristic probs
  const lower = word.toLowerCase()
  if (opts.forceTokens.has(word) || opts.forceTokens.has(lower)) return 1.0
  // Keep question marks / newlines etc at max priority if listed as forceTokens
  // numeric preservation
  if (opts.forceReserveDigit && /\d/.test(word)) return 1.0
  // digit tokens already above; other pure digits keep high
  if (/^\d+$/.test(word)) return 0.92
  // punctuation-only
  if (/^[^\w]+$/.test(word)) {
    if (word === '.' || word === '\n' || word === '?') return 0.55
    return 0.18
  }
  // stopwords low
  if (STOPWORDS.has(lower)) return 0.22 + Math.min(0.12, word.length / 40)
  // rare words (low freq in context) are more informative
  const f = opts.freq.get(lower) || 1
  const rarity = 1 - f / Math.max(1, opts.maxFreq)
  let s = 0.45 + rarity * 0.30
  // length bonus
  s += Math.min(0.12, word.length / 60)
  // cap
  if (/[A-Z]/.test(word[0] || '')) s += 0.06
  if (word.length >= 10) s += 0.05
  // code-like tokens (snake_case, kebab, path) high value
  if (/[_/\-.]/.test(word) && word.length > 3) s += 0.08
  return Math.min(0.97, Math.max(0, s))
}

// Split into words preserving original reconstructability via tokenizer.convert_tokens_to_string parity
function wordsForChunk(chunk: string): string[] {
  return splitStringToWords(chunk)
}

// ---------------------------------------------------------------------------
// AgntspcePrompter – main class
// ---------------------------------------------------------------------------

export class AgntspcePrompter {
  readonly modelName: string
  readonly deviceMap: string
  readonly maxSeqLen: number
  readonly maxBatchSize: number
  readonly maxForceToken: number
  readonly version = AGNTSPCE_PROMPTER_VERSION

  // Mirror LLMLingua's special_tokens / added_tokens handling for force_tokens
  private addedTokens: string[] = []

  constructor(config: PrompterConfig = {}) {
    this.modelName = config.modelName || 'agntspce-prompter-heuristic-v1'
    this.deviceMap = config.deviceMap || 'cpu'
    this.maxSeqLen = config.maxSeqLen || 512
    this.maxBatchSize = config.llmlingua2Config?.maxBatchSize ?? 50
    this.maxForceToken = config.llmlingua2Config?.maxForceToken ?? 100
    this.addedTokens = Array.from({ length: this.maxForceToken }, (_, i) => `[NEW${i}]`)
  }

  // -----------------------------------------------------------------------
  // Public API – mirrors PromptCompressor.compress_prompt
  // -----------------------------------------------------------------------

  compressPrompt(
    context: string | string[],
    instruction = '',
    question = '',
    opts: CompressOptions = {},
  ): CompressionResult {
    assertAgntspceContext('AgntspcePrompter.compressPrompt')
    // Normalize context
    let ctxList: string[] = Array.isArray(context) ? [...context] : [context]
    if (ctxList.length === 0) ctxList = [' ']
    // Decode-encode roundtrip parity – heuristic we just strip control
    ctxList = ctxList.map(c => stripControl(String(c)))

    // Rate / targetToken handling mirrors Python compress_prompt
    const rate = opts.rate ?? 0.5
    let targetToken = opts.targetToken ?? -1

    if (rate > 1.0) throw new Error('rate must not exceed 1.0 (agntspce-prompter)')

    const originTokens = estimateTokens(['', ...ctxList, question].join('\n\n').trim() ? ['','',...ctxList, question].join('\n\n') : ctxList.join('\n\n'))
    // Use precise origin counting matching Python oai_tokenizer.encode(join)
    const originTokensPrecise = this.getOriginTokens(ctxList, instruction, question)

    const contextTokensLen = ctxList.map(c => estimateTokens(c))
    const instructionTokensLen = instruction ? estimateTokens(instruction) : 0
    const questionTokensLen = question ? estimateTokens(question) : 0
    const concateQuestion = opts.concateQuestion ?? true

    if (targetToken === -1) {
      targetToken =
        (instructionTokensLen + questionTokensLen + contextTokensLen.reduce((a, b) => a + b, 0)) *
          rate -
        instructionTokensLen -
        (concateQuestion ? questionTokensLen : 0)
    }
    // Defer to lingua2 path when rate < 1 (default) – matches Python branch when use_llmlingua2 true.
    // In agntspce-prompter we always use the heuristic lingua2 path (no causal LM). Keep options for compat.
    return this.compressPromptLingua2(ctxList, {
      instruction,
      question,
      rate,
      targetToken,
      originTokens: originTokensPrecise,
      // propagate opts
      ...opts,
    })
  }

  // Alias preserving Python name
  compress_prompt = this.compressPrompt.bind(this)

  structuredCompressPrompt(
    context: string[] | string,
    instruction = '',
    question = '',
    opts: CompressOptions = {},
  ): CompressionResult {
    assertAgntspceContext('AgntspcePrompter.structuredCompressPrompt')
    let ctx = Array.isArray(context) ? context : [context]
    if (ctx.length === 0) ctx = [' ']
    const rate = opts.rate ?? 0.5
    // segment by <llmlingua> or <agntspce-prompter> tags
    const { newContext, contextSegs, contextSegsRate, contextSegsCompress } = this.segmentStructuredContext(
      ctx.map(c => stripControl(String(c))),
      rate,
    )
    return this.compressPrompt(newContext, instruction, question, {
      ...opts,
      rate,
      contextSegs,
      contextSegsRate,
      contextSegsCompress,
    })
  }

  structured_compress_prompt = this.structuredCompressPrompt.bind(this)

  compressJson(
    jsonData: Record<string, unknown>,
    jsonConfig: Record<string, { rate: number; compress: boolean; value_type: string; pair_remove: boolean }>,
    instruction = '',
    question = '',
    opts: CompressOptions = {},
  ): CompressionResult {
    assertAgntspceContext('AgntspcePrompter.compressJson')
    const { context, forceContextIds } = processStructuredJsonData(jsonData, jsonConfig)
    const res = this.structuredCompressPrompt(context, instruction, question, {
      ...opts,
      rate: opts.rate ?? 0.5,
      forceContextIds,
      useSentenceLevelFilter: opts.useSentenceLevelFilter ?? false,
      useContextLevelFilter: opts.useContextLevelFilter ?? false,
      useTokenLevelFilter: opts.useTokenLevelFilter ?? true,
      keepSplit: opts.keepSplit ?? false,
      contextBudget: opts.contextBudget ?? '+100',
      tokenBudgetRatio: opts.tokenBudgetRatio ?? 1.4,
    })
    // restore json
    let compressedText = removeConsecutiveCommas(res.compressed_prompt)
    try {
      const parsed = JSON.parse(compressedText)
      return { ...res, compressed_prompt: JSON.stringify(parsed), compressed_prompt_list: [JSON.stringify(parsed)] } as any
    } catch {
      // Fallback: return as text
      return { ...res, compressed_prompt: compressedText }
    }
  }

  compress_json = this.compressJson.bind(this)

  // -----------------------------------------------------------------------
  // Internal: lingua2 path (heuristic, no torch)
  // -----------------------------------------------------------------------

  private compressPromptLingua2(
    context: string[],
    opts: CompressOptions & { instruction?: string; question?: string; originTokens?: number; targetToken: number },
  ): CompressionResult {
    const {
      rate = 0.5,
      targetToken,
      originTokens,
      useContextLevelFilter = false,
      useTokenLevelFilter = true,
      targetContext = -1,
      contextLevelRate = 1.0,
      contextLevelTargetToken = -1,
      forceContextIds = [],
      returnWordLabel = false,
      wordSep = '\t\t|\t\t',
      labelSep = ' ',
      tokenToWord = 'mean',
      forceTokens = [],
      forceReserveDigit = false,
      dropConsecutive = false,
      chunkEndTokens = ['.', '\n'],
    } = opts as any

    if (forceTokens.length > this.maxForceToken) throw new Error(`forceTokens length exceeds max ${this.maxForceToken}`)

    // Build tokenMap for forceTokens that are multi-char tokens (mirrors Python added_tokens logic)
    const tokenMap = new Map<string, string>()
    for (let i = 0; i < forceTokens.length; i++) {
      const t = forceTokens[i]
      if (splitStringToWords(t).length !== 1) {
        // multi-token forceTokens get placeholder
        tokenMap.set(t, this.addedTokens[i])
      }
    }
    const chunkEndSet = new Set(chunkEndTokens)
    // For parity, expand chunkEndTokens with placeholders for tokenMap values
    for (const v of tokenMap.values()) chunkEndSet.add(v)

    // Deep copy context with placeholder substitution
    let ctxCopy = context.map(c => {
      let s = String(c)
      for (const [orig, repl] of tokenMap.entries()) s = s.split(orig).join(repl)
      return s
    })

    // Structured path: respect per-segment compress flags and rates (agntspce-prompter/llmlingua tags)
    // If contextSegs info is present, we compress per segment to honor compress=False.
    const segInfo = (opts as any).contextSegs as string[][] | undefined
    const segRates = (opts as any).contextSegsRate as number[][] | undefined
    const segCompress = (opts as any).contextSegsCompress as boolean[][] | undefined
    const hasSegInfo = Array.isArray(segInfo) && Array.isArray(segRates) && Array.isArray(segCompress)
    if (hasSegInfo && useTokenLevelFilter) {
      const nOriginalTokenSeg = originTokens ?? ctxCopy.reduce((s, c) => s + estimateTokens(c), 0)
      const compressedContextSeg: string[] = []
      const wordListSeg: string[][] = []
      const wordLabelListSeg: number[][] = []
      // Build global freq across all segments that will be compressed (for scoring parity)
      const allWordsForFreq: string[] = []
      for (let ci = 0; ci < segInfo.length; ci++) {
        const segs = segInfo[ci] || []
        const compressFlags = segCompress[ci] || []
        for (let si = 0; si < segs.length; si++) {
          if (compressFlags[si] === false) continue
          let segText = segs[si]
          for (const [orig, repl] of tokenMap.entries()) segText = segText.split(orig).join(repl)
          const ws = wordsForChunk(segText)
          allWordsForFreq.push(...ws.map(w => w.toLowerCase()))
        }
      }
      const freqSeg = new Map<string, number>()
      for (const w of allWordsForFreq) freqSeg.set(w, (freqSeg.get(w) || 0) + 1)
      let maxFreqSeg = 1
      for (const v of freqSeg.values()) if (v > maxFreqSeg) maxFreqSeg = v
      const forceSetSeg = new Set(forceTokens)

      for (let ci = 0; ci < segInfo.length; ci++) {
        const segs = segInfo[ci] || []
        const rates = segRates[ci] || []
        const compressFlags = segCompress[ci] || []
        const compressedSegs: string[] = []
        const wordsAccum: string[] = []
        const labelsAccum: number[] = []
        for (let si = 0; si < segs.length; si++) {
          const seg = segs[si] ?? ''
          const rateSeg = rates[si] ?? 1.0
          const doCompress = compressFlags[si] !== false
          if (!doCompress || rateSeg >= 1.0) {
            // Preserve verbatim (no compression) – keep exactly as authored
            compressedSegs.push(seg)
            const ws = wordsForChunk(seg)
            wordsAccum.push(...ws)
            labelsAccum.push(...ws.map(() => 1))
            continue
          }
          const reduceRate = Math.max(0, 1 - rateSeg)
          if (reduceRate <= 0) {
            compressedSegs.push(seg)
            const ws = wordsForChunk(seg)
            wordsAccum.push(...ws)
            labelsAccum.push(...ws.map(() => 1))
            continue
          }
          // Chunk the segment then compress per chunk (handles long segments)
          const segChunks = chunkContext(seg, this.maxSeqLen, chunkEndSet)
          const compressedChunks: string[] = []
          for (const ch of segChunks) {
            let chunkText = ch
            for (const [orig, repl] of tokenMap.entries()) chunkText = chunkText.split(repl).join(orig)
            const words = wordsForChunk(chunkText)
            if (words.length === 0) {
              compressedChunks.push(chunkText)
              wordsAccum.push(...words)
              labelsAccum.push(...words.map(() => 0))
              continue
            }
            const wordProbs = words.map(w => scoreWord(w, { forceTokens: forceSetSeg, forceReserveDigit, freq: freqSeg, maxFreq: maxFreqSeg }))
            const newTokenProbs: number[] = []
            for (let i = 0; i < words.length; i++) {
              const tlen = estimateTokens(words[i])
              for (let k = 0; k < tlen; k++) newTokenProbs.push(wordProbs[i])
            }
            const threshold = percentile(newTokenProbs, Math.floor(100 * reduceRate + 1))
            const keepWords: string[] = []
            const labels: number[] = []
            for (let i = 0; i < words.length; i++) {
              const p = wordProbs[i]
              const keep = p > threshold || (threshold === 1.0 && p === threshold)
              if (keep) {
                if (dropConsecutive && forceSetSeg.has(words[i]) && keepWords.length > 0 && keepWords[keepWords.length - 1] === words[i]) {
                  labels.push(0)
                } else {
                  keepWords.push(words[i])
                  labels.push(1)
                }
              } else {
                labels.push(0)
              }
            }
            const keepStr = keepWords.join(' ').replace(/\s+([.,;!?])/g, '$1').replace(/\s+([\)\]])/g, '$1').replace(/([\[\(])\s+/g, '$1')
            compressedChunks.push(keepStr)
            wordsAccum.push(...words)
            labelsAccum.push(...labels)
          }
          compressedSegs.push(compressedChunks.join(''))
        }
        // Re-join segments for this context
        compressedContextSeg.push(compressedSegs.join(''))
        wordListSeg.push(wordsAccum)
        wordLabelListSeg.push(labelsAccum)
      }

      // Reverse placeholder substitution for compressed contexts
      const finalCompressed = compressedContextSeg.map(s => {
        let out = s
        for (const [orig, repl] of tokenMap.entries()) out = out.split(repl).join(orig)
        return out
      })
      const compressedPromptSeg = finalCompressed.join('\n\n')
      const nCompressedTokenSeg = estimateTokens(compressedPromptSeg)
      const savingSeg = (nOriginalTokenSeg - nCompressedTokenSeg) * 0.06 / 1000
      const ratioSeg = nCompressedTokenSeg === 0 ? 1 : nOriginalTokenSeg / nCompressedTokenSeg
      const resSeg: CompressionResult = {
        compressed_prompt: compressedPromptSeg,
        compressed_prompt_list: finalCompressed,
        origin_tokens: nOriginalTokenSeg,
        compressed_tokens: nCompressedTokenSeg,
        ratio: `${ratioSeg.toFixed(1)}x`,
        rate: `${((1 / ratioSeg) * 100).toFixed(1)}%`,
        saving: `, Saving $${savingSeg.toFixed(1)} in GPT-4.`,
      }
      if (returnWordLabel) {
        const words: string[] = []
        const labels: number[] = []
        for (let i = 0; i < wordListSeg.length; i++) {
          words.push(...wordListSeg[i])
          labels.push(...wordLabelListSeg[i])
        }
        resSeg.fn_labeled_original_prompt = words.map((w, i) => `${w}${labelSep}${labels[i]}`).join(wordSep)
      }
      return resSeg
    }

    // Chunk each context
    const contextChunked: string[][] = ctxCopy.map(c => chunkContext(c, this.maxSeqLen, chunkEndSet))

    const nOriginalToken = originTokens ?? ctxCopy.reduce((s, c) => s + estimateTokens(c), 0)

    // Context-level filtering (coarse) – heuristic ranking if enabled
    let effectiveContexts = contextChunked
    let effectiveRate = rate
    let effectiveContextLevelRate = contextLevelRate

    // Resolve contextLevelRate from targetToken / targetContext if not set (parity with Python)
    if (useContextLevelFilter && ctxCopy.length > 1) {
      if (targetContext >= 0) {
        effectiveContextLevelRate = Math.min(targetContext / ctxCopy.length, 1.0)
      } else if (contextLevelTargetToken >= 0) {
        effectiveContextLevelRate = Math.min(contextLevelTargetToken / Math.max(1, nOriginalToken), 1.0)
      } else if (targetToken >= 0 && contextLevelRate >= 1.0 && contextLevelTargetToken <= 0) {
        // Python fallback: if no context params but targetToken set, derive context level
        // we approximate (rate+1)/2 path; rely on caller rate
        // keep as is for heuristic
      } else if (rate < 1.0 && contextLevelRate >= 1.0 && useTokenLevelFilter) {
        effectiveContextLevelRate = (rate + 1.0) / 2
      }

      if (effectiveContextLevelRate < 1.0) {
        // Rank contexts by question overlap (heuristic for longllmlingua)
        const probs = this.rankContexts(ctxCopy, opts.question || '')
        const threshold = percentile(probs, Math.floor(100 * (1 - effectiveContextLevelRate)))
        const keepIdx = new Set<number>()
        probs.forEach((p, idx) => {
          if (p >= threshold || (forceContextIds && forceContextIds.includes(idx))) keepIdx.add(idx)
        })
        // Ensure at least one
        if (keepIdx.size === 0) keepIdx.add(0)
        const keptChunks: string[][] = []
        const keptRaw: string[] = []
        for (let i = 0; i < contextChunked.length; i++) if (keepIdx.has(i)) {
          keptChunks.push(contextChunked[i])
          keptRaw.push(ctxCopy[i])
        }
        effectiveContexts = keptChunks
        // recompute nReserved for rate adjustment
        if (targetToken >= 0) {
          const nReserved = keptChunks.flat().reduce((s, ch) => s + estimateTokens(ch), 0)
          effectiveRate = Math.min(targetToken / Math.max(1, nReserved), 1.0)
        }
        // Return path filtered; update nOriginal handling handled below
        void keptRaw
      }
    } else if (targetToken > 0 && !useContextLevelFilter) {
      effectiveRate = Math.min(targetToken / Math.max(1, nOriginalToken), 1.0)
    } else if (targetToken > 0 && useContextLevelFilter && effectiveContextLevelRate >= 1.0) {
      effectiveRate = Math.min(targetToken / Math.max(1, nOriginalToken), 1.0)
    }

    // Token-level compression
    let compressedContext: string[]
    let wordList: string[][]
    let wordLabelList: number[][]

    if (useTokenLevelFilter) {
      const reduceRate = Math.max(0, 1 - effectiveRate)
      const out = this.heuristicCompress(effectiveContexts, reduceRate, {
        tokenToWord,
        forceTokens,
        tokenMap,
        forceReserveDigit,
        dropConsecutive,
        chunkEndTokens: chunkEndSet,
      })
      compressedContext = out.compressed
      wordList = out.wordList
      wordLabelList = out.wordLabelList
    } else {
      // No token filtering – just reconstruct
      const out = this.heuristicCompress(effectiveContexts, 0, {
        tokenToWord,
        forceTokens,
        tokenMap,
        forceReserveDigit,
        dropConsecutive,
        chunkEndTokens: chunkEndSet,
      })
      compressedContext = out.compressed // will be original when reduceRate 0
      wordList = out.wordList
      wordLabelList = out.wordLabelList
    }

    // Reverse placeholder substitution
    compressedContext = compressedContext.map(s => {
      let out = s
      for (const [orig, repl] of tokenMap.entries()) out = out.split(repl).join(orig)
      return out
    })

    const compressedPrompt = compressedContext.join('\n\n')
    const nCompressedToken = estimateTokens(compressedPrompt)
    const saving = (nOriginalToken - nCompressedToken) * 0.06 / 1000
    const ratio = nCompressedToken === 0 ? 1 : nOriginalToken / nCompressedToken
    const res: CompressionResult = {
      compressed_prompt: compressedPrompt,
      compressed_prompt_list: compressedContext,
      origin_tokens: nOriginalToken,
      compressed_tokens: nCompressedToken,
      ratio: `${ratio.toFixed(1)}x`,
      rate: `${((1 / ratio) * 100).toFixed(1)}%`,
      saving: `, Saving $${saving.toFixed(1)} in GPT-4.`,
    }
    if (returnWordLabel) {
      const words: string[] = []
      const labels: number[] = []
      for (let i = 0; i < wordList.length; i++) {
        words.push(...wordList[i])
        labels.push(...wordLabelList[i])
      }
      res.fn_labeled_original_prompt = words.map((w, i) => `${w}${labelSep}${labels[i]}`).join(wordSep)
    }
    return res
  }

  // -----------------------------------------------------------------------
  // Heuristic token-level compression (replaces torch model inference)
  // -----------------------------------------------------------------------

  private heuristicCompress(
    contextChunked: string[][],
    reduceRate: number,
    opts: {
      tokenToWord: string
      forceTokens: string[]
      tokenMap: Map<string, string>
      forceReserveDigit: boolean
      dropConsecutive: boolean
      chunkEndTokens: Set<string>
    },
  ): { compressed: string[]; wordList: string[][]; wordLabelList: number[][] } {
    if (reduceRate <= 0) {
      const compressed: string[] = []
      const wList: string[][] = []
      const lList: number[][] = []
      for (const chunks of contextChunked) {
        const words: string[] = []
        for (const ch of chunks) {
          // revert placeholder for word split parity
          let chunk = ch
          for (const [orig, repl] of opts.tokenMap.entries()) chunk = chunk.split(repl).join(orig)
          const ws = wordsForChunk(chunk)
          words.push(...ws)
        }
        const labels = words.map(() => 1)
        // reconstruct original chunk via join (for reduceRate 0 we keep original)
        const joined = chunks.join('')
        // but for parity return chunks joined with original spacing approximated
        // Instead use heuristic reconstruct with space joining
        void joined
        // For reduceRate 0, return original text joined
        // Build via original chunks text direct (without word filtering)
        // Use original chunk texts joined
        const orig = chunks.join('')
        compressed.push(orig)
        wList.push(words)
        lList.push(labels)
      }
      return { compressed, wordList: wList, wordLabelList: lList }
    }

    // Flatten chunks for per-chunk scoring (like DataLoader batches in Python)
    const flatChunks: string[] = []
    const chunkToContextIdx: number[] = []
    for (let ci = 0; ci < contextChunked.length; ci++) {
      for (const ch of contextChunked[ci]) {
        flatChunks.push(ch)
        chunkToContextIdx.push(ci)
      }
    }

    // Compute global word frequencies for rarity scoring
    const allWordsLower: string[] = []
    for (const ch of flatChunks) {
      let chunk = ch
      for (const [orig, repl] of opts.tokenMap.entries()) chunk = chunk.split(repl).join(orig)
      const ws = wordsForChunk(chunk)
      allWordsLower.push(...ws.map(w => w.toLowerCase()))
    }
    const freq = new Map<string, number>()
    for (const w of allWordsLower) freq.set(w, (freq.get(w) || 0) + 1)
    let maxFreq = 1
    for (const v of freq.values()) if (v > maxFreq) maxFreq = v

    const forceSet = new Set(opts.forceTokens)
    const compressedFlat: string[] = []
    const wordListFlat: string[][] = []
    const labelListFlat: number[][] = []

    for (const ch of flatChunks) {
      let chunk = ch
      for (const [orig, repl] of opts.tokenMap.entries()) chunk = chunk.split(repl).join(orig)
      const words = wordsForChunk(chunk)
      if (words.length === 0) {
        compressedFlat.push('')
        wordListFlat.push([])
        labelListFlat.push([])
        continue
      }
      const wordProbs = words.map(w => scoreWord(w, { forceTokens: forceSet, forceReserveDigit: opts.forceReserveDigit, freq, maxFreq }))

      // Handle drop_consecutive: if a force token appears consecutively without informative tokens between, demote duplicates
      if (opts.dropConsecutive) {
        const threshold = percentile(wordProbs, Math.floor(100 * reduceRate))
        let isBetween = false
        let prev: string | null = null
        for (let i = 0; i < words.length; i++) {
          if (forceSet.has(words[i])) {
            if (isBetween) isBetween = false
            else if (!isBetween && words[i] === prev) {
              wordProbs[i] = 0
            }
            prev = words[i]
          } else {
            if (wordProbs[i] > threshold) isBetween = true
          }
        }
      }

      // Map word probs to token probs via tokenToWord (mean/first). For heuristic we expand by oai token length
      const newTokenProbs: number[] = []
      for (let i = 0; i < words.length; i++) {
        const tlen = estimateTokens(words[i])
        for (let k = 0; k < tlen; k++) newTokenProbs.push(wordProbs[i])
      }
      const threshold = percentile(newTokenProbs, Math.floor(100 * reduceRate + 1))

      const keepWords: string[] = []
      const labels: number[] = []
      for (let i = 0; i < words.length; i++) {
        const p = wordProbs[i]
        const keep = p > threshold || (threshold === 1.0 && p === threshold)
        if (keep) {
          if (opts.dropConsecutive && forceSet.has(words[i]) && keepWords.length > 0 && keepWords[keepWords.length - 1] === words[i]) {
            labels.push(0)
          } else {
            keepWords.push(words[i])
            labels.push(1)
          }
        } else {
          labels.push(0)
        }
      }
      // reconstruct via simple space join but preserving punctuation spacing similar to Python's convert_tokens_to_string
      // We'll approximate: join with space then fix punctuation spacing
      let keepStr = keepWords.join(' ').replace(/\s+([.,;!?])/g, '$1').replace(/\s+([\)\]])/g, '$1').replace(/([\[\(])\s+/g, '$1')
      // Restore newlines if force token includes '\n'
      if (forceSet.has('\n')) {
        // heuristic: keepStr already without newlines; we don't artificially add
      }
      compressedFlat.push(keepStr)
      wordListFlat.push(words)
      labelListFlat.push(labels)
    }

    // Re-aggregate per context
    const compressed: string[] = []
    const wordList: string[][] = []
    const wordLabelList: number[][] = []
    let ptr = 0
    for (const chunks of contextChunked) {
      const n = chunks.length
      compressed.push(compressedFlat.slice(ptr, ptr + n).join(''))
      const wl: string[] = []
      const ll: number[] = []
      for (let i = 0; i < n; i++) {
        wl.push(...wordListFlat[ptr + i])
        ll.push(...labelListFlat[ptr + i])
      }
      wordList.push(wl)
      wordLabelList.push(ll)
      ptr += n
    }
    return { compressed, wordList, wordLabelList }
  }

  // -----------------------------------------------------------------------
  // Context / sentence level heuristics (lightweight rankers)
  // -----------------------------------------------------------------------

  private rankContexts(contexts: string[], question: string): number[] {
    if (!question.trim()) return contexts.map(() => 0.5)
    const qTokens = new Set(splitStringToWords(question.toLowerCase()))
    return contexts.map(ctx => {
      const toks = splitStringToWords(ctx.toLowerCase())
      if (toks.length === 0) return 0
      let overlap = 0
      for (const t of toks) if (qTokens.has(t)) overlap++
      return overlap / Math.max(1, toks.length)
    })
  }

  // -----------------------------------------------------------------------
  // Structured tag parsing – supports both <llmlingua> and <agntspce-prompter>
  // -----------------------------------------------------------------------

  private segmentStructuredContext(
    context: string[],
    globalRate: number,
  ): { newContext: string[]; contextSegs: string[][]; contextSegsRate: number[][]; contextSegsCompress: boolean[][] } {
    const newContext: string[] = []
    const contextSegs: string[][] = []
    const contextSegsRate: number[][] = []
    const contextSegsCompress: boolean[][] = []

    // Match both brand tags: <llmlingua ...>content</llmlingua> and <agntspce-prompter ...>...</agntspce-prompter>
    // We also support self-closing style where tag name is agntspce-prompter
    const pattern =
      /<(?:llmlingua|agntspce-prompter)\s*(?:,\s*rate\s*=\s*([\d\.]+))?\s*(?:,\s*compress\s*=\s*(True|False))?\s*(?:,\s*rate\s*=\s*([\d\.]+))?\s*(?:,\s*compress\s*=\s*(True|False))?\s*>([^<]+)<\/(?:llmlingua|agntspce-prompter)>/g

    for (let text of context) {
      const hasTag = /<(?:llmlingua|agntspce-prompter)/.test(text)
      if (!hasTag) text = `<llmlingua>${text}</llmlingua>`
      if (!text.trim().endsWith('</llmlingua>') && !text.trim().endsWith('</agntspce-prompter>')) {
        // If wrapped with agntspce-prompter, keep consistent closing
        if (text.includes('<agntspce-prompter')) text = text + '</agntspce-prompter>'
        else text = text + '</llmlingua>'
      }
      const matches = [...text.matchAll(pattern)]
      // Fallback: if pattern didn't match, treat whole text as single segment
      if (matches.length === 0) {
        const stripped = stripControl(text.replace(/<[^>]+>/g, ''))
        newContext.push(stripped)
        contextSegs.push([stripped])
        contextSegsRate.push([globalRate])
        contextSegsCompress.push([true])
        continue
      }
      const segments: string[] = []
      const segsRate: (number | null)[] = []
      const segsCompress: (boolean | null)[] = []
      for (const m of matches) {
        // m[1]=rate first pos, m[2]=compress first, m[3]=rate second, m[4]=compress second, m[5]=content
        const content = m[5]
        segments.push(content)
        const r1 = m[1] ? parseFloat(m[1]) : null
        const c1 = m[2] ? m[2] === 'True' : null
        const r2 = m[3] ? parseFloat(m[3]) : null
        const c2 = m[4] ? m[4] === 'True' : null
        let rateVal: number | null = r1 ?? r2 ?? null
        let compVal: boolean | null = c1 ?? c2 ?? null
        segsRate.push(rateVal)
        segsCompress.push(compVal)
      }
      const finalCompress = segsCompress.map(c => (c !== null ? c : true))
      const finalRate = segsRate.map((r, idx) => {
        if (r !== null) return r
        const comp = finalCompress[idx]
        return comp ? globalRate : 1.0
      })
      for (const r of finalRate) if (r > 1.0) throw new Error('rate must not exceed 1.0 (agntspce-prompter)')

      newContext.push(segments.join(''))
      contextSegs.push(segments)
      contextSegsRate.push(finalRate)
      contextSegsCompress.push(finalCompress)
    }
    return { newContext, contextSegs, contextSegsRate, contextSegsCompress }
  }

  // -----------------------------------------------------------------------
  // Token counting helpers
  // -----------------------------------------------------------------------

  private getOriginTokens(context: string[], instruction: string, question: string): number {
    const parts: string[] = []
    if (instruction) parts.push(instruction)
    for (const c of context) parts.push(c)
    if (question) parts.push(question)
    const joined = parts.join('\n\n')
    return estimateTokens(joined)
  }

  getTokenLength(text: string, addSpecialTokens = true, useOai = false): number {
    void addSpecialTokens
    return getTokenLength(text, useOai)
  }

  // -----------------------------------------------------------------------
  // Recover (mirrors PromptCompressor.recover)
  // -----------------------------------------------------------------------

  recover(originalPrompt: string, compressedPrompt: string, response: string): string {
    assertAgntspceContext('AgntspcePrompter.recover')
    const responseWords = response.split(' ')
    const N = responseWords.length
    const recovered: string[] = []
    let l = 0
    while (l < N) {
      if (!compressedPrompt.includes(responseWords[l])) {
        recovered.push(responseWords[l])
        l++
        continue
      }
      let r = l
      while (r + 1 < N && compressedPrompt.includes(responseWords.slice(l, r + 2).join(' '))) r++
      // For heuristic runtime, we simply map back the slice as-is (no tokenizer id matching)
      // Preserve original semantic: return the matched span
      recovered.push(responseWords.slice(l, r + 1).join(' '))
      l = r + 1
    }
    void originalPrompt
    return recovered.join(' ')
  }

  // -----------------------------------------------------------------------
  // Compatibility shims
  // -----------------------------------------------------------------------

  getVersion(): string {
    return this.version
  }
}
