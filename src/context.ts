import type { Character, LorebookEntry } from './characters.js';

export interface ChatMessage {
  role: 'user' | 'character';
  author: string;
  content: string;
}

export interface BuildOptions {
  character: Character;
  /** Full chat history, oldest first. The last item is the latest message. */
  history: ChatMessage[];
  authorsNote: string;
  scanDepth: number;
  noteDepth: number;
  /** Token budget for the prompt alone (context size minus output tokens). */
  maxPromptTokens: number;
  /** Extra context entries placed after the lorebook (used by /image). */
  extraEntries?: string[];
  /** Text the model continues from. Defaults to "<character name>:". */
  prefill?: string;
}

export interface BuiltPrompt {
  prompt: string;
  estimatedTokens: number;
  /** How many history messages made it into the prompt. */
  historyUsed: number;
}

/**
 * Rough token estimate without a tokenizer, calibrated against glm-4-6:
 * about 3 ASCII characters per token, and about 1 token per Thai character.
 * Errs on the high side so the real prompt stays under the budget.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3 + other);
}

export function formatLine(message: ChatMessage): string {
  return `${message.author}: ${message.content}`;
}

/** Entries that are always on, plus those whose key appears in the last `scanDepth` messages. */
export function activeLorebookEntries(
  entries: LorebookEntry[],
  history: ChatMessage[],
  scanDepth: number,
): LorebookEntry[] {
  const recent = history
    .slice(-Math.max(0, scanDepth))
    .map((m) => m.content.toLowerCase())
    .join('\n');
  return entries.filter(
    (entry) => entry.alwaysOn || entry.keys.some((key) => recent.includes(key.toLowerCase())),
  );
}

/**
 * Order: Memory -> active lorebook -> extra entries -> history (Author's Note
 * inserted `noteDepth` messages before the end) -> prefill.
 * When over budget, the oldest history is dropped first. Memory, lorebook and
 * Author's Note are never cut, and the latest message is always kept.
 */
export function buildPrompt(options: BuildOptions): BuiltPrompt {
  const { character, history, authorsNote, scanDepth, noteDepth, maxPromptTokens } = options;
  const prefill = options.prefill ?? `${character.name}:`;

  const header = [
    character.memory,
    ...activeLorebookEntries(character.lorebook, history, scanDepth).map((e) => e.text),
    ...(options.extraEntries ?? []),
  ];
  const note = authorsNote.trim();

  let used = estimateTokens([...header, note, prefill].join('\n'));
  const lines = history.map(formatLine);
  let start = lines.length;
  while (start > 0) {
    const cost = estimateTokens(lines[start - 1]!) + 1;
    if (start < lines.length && used + cost > maxPromptTokens) break;
    used += cost;
    start--;
  }

  const kept = lines.slice(start);
  if (note) {
    const at = Math.max(0, kept.length - Math.max(0, noteDepth));
    kept.splice(at, 0, note);
  }

  const prompt = [...header, ...kept, prefill].join('\n');
  return { prompt, estimatedTokens: used, historyUsed: lines.length - start };
}
