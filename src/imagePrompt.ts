import type { ImagePrompt } from './image.js';

/** Context entry added only for /image. Never stored in chat history. */
export const IMAGE_PROMPT_RULES = `[Image Prompt] means: write ONLY an image prompt of the exact current moment in the story. Do not continue the story. Do not write dialogue. End with [/Image Prompt].
Base it on the most recent events: where everyone is now, what they are doing right now, what they are holding, and their current emotions. Ignore earlier scenes.
Format:
[Image Prompt]
Main: <character count e.g. 1girl, 1boy>, <composition>, <camera angle and framing>, <location>, <background objects>, <time of day>, <weather>, <lighting>, <atmosphere>
Character 1 (<name>): <expression>, <eye direction>, <pose>, <hand action>, <held item>, <position in frame>, <clothing or hair changes>
Character 2 (<name>): <same structure>
[/Image Prompt]
Location: the place where the current moment happens, as the story last described it. If that place has a "Scene tags (<place>): ..." line, copy those tags into Main as the location and background objects, then add only what the scene changes.
Interactions: when characters do something to each other, name the action in Main (e.g. piggyback, hug, holding hands) and mark who does what: put "source#<action>" in the line of the one doing it and "target#<action>" in the line of the one it is done to (piggyback: the carrier gets source#piggyback, the rider gets target#piggyback). Use "mutual#<action>" in both lines when they do it together (mutual#hug). Add the body position that follows (carrying, on back, arms around neck). Check before writing: the line that says carrying gets source#piggyback, the line that says being carried gets target#piggyback.
Rules: tags only, comma separated, English, no sentences. Main must not describe any character's appearance. Each character line describes only that one character. Only include characters who are present in the current moment. Use each character's exact name.
Appearance: a character's Image tags are added automatically, so do not repeat their hair, eyes, body or usual clothes. Write <clothing or hair changes> only if the story explicitly changed them (took off a coat, changed clothes, got wet); otherwise leave it out. For a character with no Image tags, start their line with gender and basic appearance tags.`;

export const IMAGE_PROMPT_PREFILL = '[Image Prompt]\nMain:';
export const IMAGE_PROMPT_STOP = '[/Image Prompt]';

/** V5 accepts many character slots; more than this is almost always a parsing mistake. */
const MAX_CHARACTERS = 6;

/**
 * Template slots the model fills with "nothing" (e.g. "no held item"). In a
 * positive prompt these can pull the named thing into the image, so drop them.
 */
const EMPTY_SLOT = /^(?:none|n\/a|nothing|no (?:held )?items?|no held object|not holding anything|empty hands?)$/i;

function cleanTags(text: string): string {
  return text
    .split(',')
    .map((t) => t.trim().replace(/[.。]+$/, '').trim())
    .filter((t) => t && !EMPTY_SLOT.test(t))
    .join(', ');
}

/**
 * Parses the model's continuation of IMAGE_PROMPT_PREFILL. Returns null when
 * the output does not follow the format closely enough to use.
 */
export function parseImagePrompt(continuation: string): ImagePrompt | null {
  const text = `Main:${continuation.split(IMAGE_PROMPT_STOP)[0]}`;
  let main = '';
  const characters: ImagePrompt['characters'] = [];

  for (const rawLine of text.split('\n')) {
    // Tolerate list bullets and bold labels ("- **Aria**: ...").
    const line = rawLine.trim().replace(/^[-*•]\s+/, '').replace(/\*\*/g, '');
    if (!line) continue;
    if (/^\[\/?Image Prompt\]$/i.test(line)) continue;
    const mainMatch = /^Main\s*:\s*(.*)$/i.exec(line);
    if (mainMatch) {
      if (main) return null;
      main = cleanTags(mainMatch[1]!);
      continue;
    }
    const character = parseCharacterLine(line);
    if (character) {
      if (character.tags) characters.push(character);
      continue;
    }
    // Any other line means the model wandered off-format (story text, dialogue).
    return null;
  }

  if (!main || characters.length > MAX_CHARACTERS) return null;
  const allTags = [main, ...characters.map((c) => c.tags)].join(', ').split(', ');
  if (allTags.some(looksLikeProse)) return null;
  // A Main that is one long comma-free phrase is a sentence, not a tag list.
  if (!main.includes(',') && main.split(/\s+/).length > 6) return null;
  return fixReversedCarry({ main, characters });
}

const CARRIER = /\b(?<!being )carr(?:ying|ies)\b/i;
const CARRIED = /\b(?:being carried|on (?:\w+(?:'s)? )?back|riding|clinging)\b/i;

/**
 * The model sometimes writes "carrying" in one line but gives that line the
 * target# tag and the carried character the source# tag. When both lines
 * contradict their tag that way, swap the tags back.
 */
export function fixReversedCarry(prompt: ImagePrompt): ImagePrompt {
  const characters = prompt.characters.map((c) => ({ ...c }));
  for (const target of characters) {
    for (const action of target.tags.match(/target#[\w-]+/gi) ?? []) {
      const name = action.slice('target#'.length);
      const source = characters.find((c) => c !== target && new RegExp(`source#${name}\\b`, 'i').test(c.tags));
      if (!source) continue;
      // "carrying someone on her back" is a carrier, so CARRIED only counts without CARRIER.
      const reversed = CARRIER.test(target.tags) && CARRIED.test(source.tags) && !CARRIER.test(source.tags);
      if (!reversed) continue;
      target.tags = target.tags.replace(action, `source#${name}`);
      source.tags = source.tags.replace(new RegExp(`source#${name}\\b`, 'i'), `target#${name}`);
    }
  }
  return { main: prompt.main, characters };
}

/**
 * "Character 1 (Aria): tags" is the requested form; the model sometimes writes
 * "Character 1 - Aria: tags" or just "Aria: tags", which mean the same thing.
 */
function parseCharacterLine(line: string): { name: string; tags: string } | null {
  const match =
    /^Character\s*\d+\s*\(([^)]+)\)\s*:\s*(.*)$/i.exec(line) ??
    /^Character\s*\d+\s*[-–:]\s*([^:,()]{1,40}?)\s*:\s*(.*)$/i.exec(line) ??
    /^([^:,()[\]]{1,40}?)\s*:\s*(.*)$/.exec(line);
  if (!match) return null;
  return { name: match[1]!.trim(), tags: cleanTags(match[2]!) };
}

/**
 * Story text or dialogue leaking in: very long phrases, quotes, ! or ?, or
 * non-English script. Descriptive tags of 10-20 words are normal for V5.
 */
function looksLikeProse(tag: string): boolean {
  return (
    tag.split(/\s+/).length > 20 ||
    /["“”「」!?]/.test(tag) ||
    /[^\x00-\x7F‐-―À-ɏ]/.test(tag)
  );
}

/** Lowercase tag set for duplicate checks. */
function tagSet(tags: string): Set<string> {
  return new Set(tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean));
}

/**
 * Puts each character's canonical Image tags first, so their look does not
 * drift between images. The model's scene tags (pose, expression, changes)
 * follow, minus any duplicates. Characters without Image tags are unchanged.
 */
export function applyImageTags(prompt: ImagePrompt, canonical: Map<string, string>): ImagePrompt {
  return {
    main: prompt.main,
    characters: prompt.characters.map((c) => {
      const fixed = canonical.get(c.name.trim().toLowerCase());
      if (!fixed) return c;
      const seen = tagSet(fixed);
      const scene = c.tags
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t && !seen.has(t.toLowerCase()));
      return { name: c.name, tags: [fixed, ...scene].join(', ') };
    }),
  };
}

/** The prompt as shown to users, in the same format the model wrote it. */
export function formatImagePrompt(prompt: ImagePrompt): string {
  return [
    `Main: ${prompt.main}`,
    ...prompt.characters.map((c, i) => `Character ${i + 1} (${c.name}): ${c.tags}`),
  ].join('\n');
}
