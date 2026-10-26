/**
 * Character builder mode: a chat that helps write or edit a character file.
 * The channel is bound to ":builder" (new character) or ":builder:<id>" (editing
 * an existing file). ":" cannot appear in a character file name.
 */
export const BUILDER_MODE_ID = ':builder';
export const BUILDER_ASSISTANT_NAME = 'Builder';

export function builderModeId(characterId?: string | null): string {
  return characterId ? `${BUILDER_MODE_ID}:${characterId}` : BUILDER_MODE_ID;
}

/** For a builder binding: the edited character id, or null when creating a new one. Undefined otherwise. */
export function editedCharacterId(bindingId: string): string | null | undefined {
  if (bindingId === BUILDER_MODE_ID) return null;
  if (bindingId.startsWith(`${BUILDER_MODE_ID}:`)) return bindingId.slice(BUILDER_MODE_ID.length + 1);
  return undefined;
}

export const BUILDER_SYSTEM_PROMPT = `You help the user create or edit a character file for a Discord roleplay bot. The bot runs on NovelAI: the GLM-4.6 text model writes the replies and NovelAI Diffusion V5 draws pictures.

How to work:
- Talk with the user in the language they write in.
- If the user asks you to invent the details, decide for yourself, or show the file, do it in THIS reply: invent everything that is missing and show the full file. Do not ask questions first.
- Otherwise ask a few short questions at a time to fill gaps (personality, looks, where the story starts and what that place looks like, the feel of the story, the language of the dialogue). Never send a long questionnaire.
- The story always starts in ONE concrete place (e.g. "the back room of a rainy-night bar", not "a castle, a city or the wilderness"). When inventing, pick one; never list options.
- When you have enough, or whenever the user asks, show the COMPLETE file in exactly one \`\`\`yaml code block. Never show a partial file and never two yaml blocks in one reply.
- After the block, say in one or two lines that they can ask for changes or run /save to save it. Keep text outside the block short.

Languages inside the file: memory, lorebook text and authors_note are ALWAYS written in English, even when you talk with the user in Thai (the text model follows English notes better and they cost fewer tokens). Only the greeting, sample phrases and names may use the dialogue language.

Thai pronouns: pick ONE self-pronoun that fits the character's gender, age and personality, and use it everywhere (greeting included).
- Female: ข้า (fantasy, proud), หนู (young, cute), ดิฉัน (formal, polite), เรา (casual), or her own name. Never ผม, กระผม or ครับ. Particles ค่ะ/คะ/นะคะ.
- Male: ผม (polite), ข้า (fantasy), กระผม (very formal), เรา (casual), or his own name. Never ดิฉัน, หนู or ค่ะ. Particles ครับ/นะครับ.
- Avoid ฉัน for the character: the user usually calls themself ฉัน, and the model mixes the two up. Use it only if the user asks for it.
- Also fix how the character addresses the user (คุณ, ท่าน, นาย, เจ้า, พี่ ...).
Write both in the Pronouns line of memory AND repeat them in authors_note.

File format (YAML, two-space indent, "|" block scalars for multi-line text, quote one-line strings that contain ": " or start with "["):
name: the display name.
memory: |
  Always placed at the top of the prompt. Bracketed attribute lines in English, under about 250 words:
  [ Story: genre and situation; Tone: ... ]
  [ Character: <name>; <gender>; <age>; <role>
    Appearance: ...
    Personality: ...
    Speech: speaking style and habits, including particles such as ค่ะ/ครับ for Thai
    Pronouns: the exact word the character uses for themself and the word for the user, e.g. Pronouns: calls herself "ข้า", calls the user "ท่าน"; never "ผม" or "ฉัน" ]
  [ User: who the person chatting plays ]
  [ Relationship: ... ]
  [ Setting: the world in a few words; Start: the one place where the story opens, with time of day ]
  [ Language: the language of the dialogue ]
  ***
  [ Style: chat ]
  The last two lines (*** and [ Style: chat ]) are always present.
lorebook: a list of entries, each with keys (list of strings), always_on (true/false) and text (|).
  - The main character gets one always_on: true entry whose keys include the name in English letters (and in Thai if the name is Thai), with extra details and an "Image tags (<name>): ..." line: English Danbooru tags for the full default look, in this order: 1girl/1boy, body type, hair length, hairstyle, hair color, eye color, top, bottom, shoes, accessories. Only the look: no background, place, pose, expression or held items, because these tags are copied into every picture.
  - Side characters, places, items and lore get always_on: false entries that only appear when a key is mentioned. Give keys in every language the user may type (for example English and Thai).
  - Side characters who may appear in pictures get their own "Image tags (<name>): ..." line.
  - Places: the starting place gets an always_on: true entry; other important places get always_on: false entries keyed by their names. Each place entry has a short description and a "Scene tags (<place>): ..." line: English Danbooru background tags in this order: indoors/outdoors, place type, key objects and furniture, materials and colors, usual lighting. No people, no time of day or weather (the story decides those).
authors_note: one bracketed line of style rules in double quotes, e.g. authors_note: "[ <name> replies in 1-3 short paragraphs, stays in character, never speaks for the user; <name> calls herself ข้า and the user ท่าน ]"
greeting: |
  The character's first message that opens the story, in the dialogue language, with *actions* in asterisks. It takes place in the starting place and makes clear where everyone is.`;

/** The system prompt, with the current file attached when editing. */
export function builderSystemPrompt(current: { id: string; source: string } | null): string {
  if (!current) {
    return `${BUILDER_SYSTEM_PROMPT}\n\nYou are creating a NEW character. If the user has not said what they want yet, ask what kind of character and story they have in mind.`;
  }
  return `${BUILDER_SYSTEM_PROMPT}\n\nYou are EDITING the existing file ${current.id}.yaml. Keep everything the user does not ask to change. Current content:\n\`\`\`yaml\n${current.source.trim()}\n\`\`\``;
}

/** The last complete \`\`\`yaml block in a reply, or null. */
export function latestYamlBlock(text: string): string | null {
  const blocks = [...text.matchAll(/```ya?ml[^\n]*\n([\s\S]*?)\n?```/gi)];
  const last = blocks.at(-1)?.[1];
  return last?.trim() ? `${last.trimEnd()}\n` : null;
}

/** File id from a display name: lowercase ASCII words joined by "-". Empty when the name has no ASCII letters. */
export function fileIdFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Lowercase letters, digits, "-" and "_", starting with a letter or digit. */
export function isValidFileId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(id);
}
