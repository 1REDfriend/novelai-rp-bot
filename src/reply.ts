function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Stop sequences for a chat turn: other speakers' line starts plus the image prompt terminator. */
export function stopSequences(userNames: string[], limit = 4): string[] {
  const unique = [...new Set(userNames.map((n) => n.trim()).filter(Boolean))];
  return [...unique.slice(0, limit - 1).map((name) => `\n${name}:`), '[/Image Prompt]'];
}

/**
 * Cleans a raw completion into the character's reply:
 * - cuts everything from the first line where the model starts speaking as
 *   one of the known users,
 * - cuts any stray [Image Prompt] block,
 * - drops a repeated "<character>:" label at the start.
 */
export function cleanReply(raw: string, characterName: string, userNames: string[]): string {
  let text = raw;

  const imageAt = text.indexOf('[Image Prompt]');
  if (imageAt !== -1) text = text.slice(0, imageAt);
  const imageEndAt = text.indexOf('[/Image Prompt]');
  if (imageEndAt !== -1) text = text.slice(0, imageEndAt);

  const ownLabel = new RegExp(`^\\s*${escapeRegExp(characterName)}\\s*:\\s*`);
  text = text.replace(ownLabel, '');

  const names = userNames.map((n) => n.trim()).filter(Boolean).map(escapeRegExp);
  if (names.length > 0) {
    const speaker = new RegExp(`^\\s*(?:${names.join('|')})\\s*:`, 'm');
    const match = speaker.exec(text);
    if (match) text = text.slice(0, match.index);
  }

  // A later "<character>:" line means the model started another turn; keep only the first.
  const nextOwnTurn = new RegExp(`\\n\\s*${escapeRegExp(characterName)}\\s*:`);
  const ownMatch = nextOwnTurn.exec(text);
  if (ownMatch) text = text.slice(0, ownMatch.index);

  return text.trim();
}

/**
 * Trims a reply that was cut off by the token limit back to its last complete
 * sentence. Thai rarely uses periods, so line breaks and spaces count as
 * boundaries too. Gives up (returns the text unchanged) if that would drop
 * more than 60% of it.
 */
export function trimIncomplete(text: string): string {
  const trimmed = text.trimEnd();
  const minKeep = Math.ceil(trimmed.length * 0.4);
  const boundaries = [
    trimmed.lastIndexOf('\n'),
    ...['.', '!', '?', '…', '"', '”', ')', '~'].map((c) => {
      const i = trimmed.lastIndexOf(c);
      return i === -1 ? -1 : i + 1;
    }),
    closingAsteriskEnd(trimmed),
  ];
  const strong = Math.max(...boundaries);
  if (strong >= minKeep) return trimmed.slice(0, strong).trimEnd();
  const space = trimmed.lastIndexOf(' ');
  if (space >= minKeep) return trimmed.slice(0, space).trimEnd();
  return trimmed;
}

/** End index of the last "*action*" that is closed, or -1. */
function closingAsteriskEnd(text: string): number {
  let count = 0;
  let lastClose = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '*') {
      count++;
      if (count % 2 === 0) lastClose = i + 1;
    }
  }
  return lastClose;
}

/**
 * Splits text into chunks that fit Discord's 2000-character message limit.
 * A code block cut in two is closed at the end of one chunk and reopened at
 * the start of the next, keeping its indentation.
 */
export function splitForDiscord(text: string, max = 2000): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    // Leave room to close an open code block.
    const room = max - 4;
    let cut = rest.lastIndexOf('\n', room);
    let next: number;
    if (cut >= room / 2) {
      next = cut + 1;
    } else {
      cut = rest.lastIndexOf(' ', room);
      if (cut < room / 2) cut = room;
      next = cut;
    }
    let chunk = rest.slice(0, cut).trimEnd();
    rest = rest.slice(next);
    const fence = openFence(chunk);
    if (fence !== null) {
      chunk += '\n```';
      rest = `${fence}\n${rest}`;
    } else {
      rest = rest.trimStart();
    }
    chunks.push(chunk);
  }
  if (rest.trim()) chunks.push(rest);
  return chunks;
}

/** The opening line of a code block left open at the end of the text, or null. */
function openFence(text: string): string | null {
  let open: string | null = null;
  for (const line of text.split('\n')) {
    if (!line.trimStart().startsWith('```')) continue;
    open = open === null ? line.trim() : null;
  }
  return open;
}
