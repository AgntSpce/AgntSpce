// agntspce-prompter – public barrel
// This module is AGNTSPCE-INTERNAL. Do not publish standalone.
// All imports must be from electron/services/prompter/* inside AgntSpce.
// Exposed only to Electron main process; never via IPC to untrusted renderer.

export * from './version'
export * from './utils'
export * from './compressor'

import { AgntspcePrompter, CompressOptions, CompressionResult } from './compressor'
import { AGNTSPCE_PROMPTER_VERSION } from './version'

// ---------------------------------------------------------------------------
// Singleton – mirrors LLMLingua's typical single PromptCompressor instance
// ---------------------------------------------------------------------------

let _prompter: AgntspcePrompter | null = null

export function getPrompter(): AgntspcePrompter {
  if (_prompter) return _prompter
  _prompter = new AgntspcePrompter()
  return _prompter
}

export function resetPrompter(): void {
  _prompter = null
}

// ---------------------------------------------------------------------------
// Convenience helpers – agntspce-prompter branded API
// Wraps AgntspcePrompter.compressPrompt with defaults suitable for
// terminal output / RAG docs / chat history inside AgntSpce.
// ---------------------------------------------------------------------------

export function compressPrompt(
  context: string | string[],
  opts: CompressOptions & { instruction?: string; question?: string } = {},
): CompressionResult {
  const p = getPrompter()
  const instruction = (opts as any).instruction || ''
  const question = (opts as any).question || ''
  return p.compressPrompt(context, instruction, question, opts)
}

export function compressWithRate(
  text: string,
  rate = 0.5,
  forceTokens: string[] = [],
): CompressionResult {
  return compressPrompt(text, { rate, forceTokens })
}

import { estimateTokens as estimateTokensFromUtils } from './utils'
export function estimateTokens(text: string): number {
  return estimateTokensFromUtils(text)
}

// ---------------------------------------------------------------------------
// Internal guard helper: verify caller is inside AgntSpce
// Returns true when running inside Electron main; false otherwise.
// ---------------------------------------------------------------------------

export function isAgntspcePrompterAvailable(): boolean {
  return typeof process !== 'undefined' && !!process.versions?.electron
}

export const AGNTSPCE_PROMPTER_NAME = 'agntspce-prompter'
export const AGNTSPCE_PROMPTER_TAG = 'agntspce-prompter'
export const VERSION = AGNTSPCE_PROMPTER_VERSION

// Back-compat alias for callers that still reference PromptCompressor name
export { AgntspcePrompter as PromptCompressor }
export { AgntspcePrompter as AgntspcePrompterCompressor }
