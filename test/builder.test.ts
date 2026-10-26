import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { builderSystemPrompt, editedCharacterId, fileIdFromName, latestYamlBlock } from '../src/builder.js';
import { loadCharacters } from '../src/characters.js';
import type { ChatRequest } from '../src/chat.js';
import { HistoryStore } from '../src/history.js';
import type { CompletionRequest } from '../src/novelai.js';
import { splitForDiscord } from '../src/reply.js';
import { RoleplayService } from '../src/roleplay.js';

const yamlFile = (name: string, greeting = 'Hello!') =>
  `name: ${name}\nmemory: |\n  [ Character: ${name} ]\n  ***\n  [ Style: chat ]\nlorebook: []\nauthors_note: "[ short replies ]"\ngreeting: |\n  ${greeting}\n`;
const reply = (yaml: string) => `Here is the file:\n\`\`\`yaml\n${yaml}\`\`\`\nAsk for changes or run /save.`;

describe('builder helpers', () => {
  it('reads the mode id', () => {
    expect(editedCharacterId(':builder')).toBeNull();
    expect(editedCharacterId(':builder:aria')).toBe('aria');
    expect(editedCharacterId(':chat')).toBeUndefined();
    expect(editedCharacterId('aria')).toBeUndefined();
  });

  it('takes the last complete yaml block and ignores an unclosed one', () => {
    expect(latestYamlBlock('```yaml\nname: A\n```\n```yaml\nname: B\n```')).toBe('name: B\n');
    expect(latestYamlBlock('```yaml\nname: A\n```\n```yaml\nname: cut off')).toBe('name: A\n');
    expect(latestYamlBlock('no file here')).toBeNull();
  });

  it('makes file ids from names', () => {
    expect(fileIdFromName('Captain Mira Vale')).toBe('captain-mira-vale');
    expect(fileIdFromName('Élise')).toBe('elise');
    expect(fileIdFromName('มิระ')).toBe('');
  });

  it('attaches the current file when editing', () => {
    expect(builderSystemPrompt({ id: 'aria', source: 'name: Aria' })).toContain('EDITING the existing file aria.yaml');
    expect(builderSystemPrompt(null)).toContain('creating a NEW character');
  });

  it('asks for one concrete starting place with scene tags', () => {
    expect(builderSystemPrompt(null)).toContain('ONE concrete place');
    expect(builderSystemPrompt(null)).toContain('Scene tags (<place>)');
  });

  it('fixes one self-pronoun in memory and authors_note', () => {
    expect(builderSystemPrompt(null)).toContain('Pronouns:');
    expect(builderSystemPrompt(null)).toContain('repeat them in authors_note');
  });
});

describe('splitForDiscord with code blocks', () => {
  it('closes and reopens a code block that is cut, keeping indentation', () => {
    const lines = Array.from({ length: 120 }, (_, i) => `  line ${i} ${'x'.repeat(20)}`);
    const text = `Intro\n\`\`\`yaml\n${lines.join('\n')}\n\`\`\`\nDone`;
    const chunks = splitForDiscord(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(chunks[1]!.startsWith('```yaml\n  line')).toBe(true);
  });
});

describe('RoleplayService builder mode', () => {
  const config = {
    maxOutputTokens: 150,
    maxContextTokens: 8000,
    temperature: 0.7,
    topP: 0.95,
    lorebookScanDepth: 4,
    authorsNoteDepth: 1,
    chatMaxOutputTokens: 1500,
    builderMaxOutputTokens: 3000,
    builderMaxContextTokens: 16000,
  };
  const text = { complete: async (_r: CompletionRequest) => ({ text: 'unused', finishReason: 'stop' }) };

  let dir: string;
  let store: HistoryStore;
  let replies: string[];
  let requests: ChatRequest[];
  let service: RoleplayService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rp-builder-'));
    writeFileSync(join(dir, 'aria.yaml'), yamlFile('Aria'));
    store = new HistoryStore(':memory:');
    replies = [];
    requests = [];
    const chat = {
      chat: async (r: ChatRequest) => {
        requests.push(r);
        return { text: replies.shift() ?? 'What kind of character?', finishReason: 'stop' };
      },
    };
    service = new RoleplayService(config, store, text, () => loadCharacters(dir), chat, dir);
  });

  it('creates a new character, saves it under a name-based file, then keeps editing it', async () => {
    service.startBuilder('c');
    expect(service.mode('c')).toBe('builder');
    replies.push(reply(yamlFile('Mira Vale')));
    await service.reply('c', 'Rowan', 'a sky pirate captain');
    expect(requests[0]).toMatchObject({ maxTokens: 3000 });
    expect(requests[0]!.messages[0]!.content).toContain('creating a NEW character');

    expect(service.saveCharacter('c')).toEqual({ id: 'mira-vale', name: 'Mira Vale', backupPath: null });
    expect(loadCharacters(dir).characters.get('mira-vale')?.greeting).toBe('Hello!');

    replies.push(reply(yamlFile('Mira Vale', 'Ahoy!')));
    await service.reply('c', 'Rowan', 'make her greet with ahoy');
    expect(requests[1]!.messages[0]!.content).toContain('EDITING the existing file mira-vale.yaml');
    const second = service.saveCharacter('c');
    expect(second.backupPath).toMatch(/mira-vale\.yaml\.bak$/);
    expect(loadCharacters(dir).characters.get('mira-vale')?.greeting).toBe('Ahoy!');
    expect(loadCharacters(dir).errors).toEqual([]);
  });

  it('edits an existing character in place', async () => {
    service.startBuilder('c', 'aria');
    replies.push(reply(yamlFile('Aria', 'Welcome back!')));
    await service.reply('c', 'Rowan', 'change the greeting');
    expect(service.saveCharacter('c').id).toBe('aria');
    expect(readFileSync(join(dir, 'aria.yaml'), 'utf8')).toContain('Welcome back!');
    expect(readdirSync(dir).sort()).toEqual(['aria.yaml', 'aria.yaml.bak']);
  });

  it('refuses to replace another character unless asked', async () => {
    service.startBuilder('c');
    replies.push(reply(yamlFile('Aria', 'Imposter')));
    await service.reply('c', 'Rowan', 'make aria');
    expect(() => service.saveCharacter('c')).toThrow(expect.objectContaining({ kind: 'file_exists' }));
    expect(service.saveCharacter('c', 'aria-2').id).toBe('aria-2');
    expect(service.saveCharacter('c', 'aria', true).backupPath).not.toBeNull();
  });

  it('explains what is wrong instead of saving', async () => {
    service.startBuilder('c');
    expect(() => service.saveCharacter('c')).toThrow(expect.objectContaining({ kind: 'nothing_to_save' }));
    replies.push(reply('name: Broken\nmemory: |\n  x\n'));
    await service.reply('c', 'Rowan', 'go');
    expect(() => service.saveCharacter('c')).toThrow(expect.objectContaining({ kind: 'invalid_character' }));
    replies.push(reply(yamlFile('มิระ')));
    await service.reply('c', 'Rowan', 'thai name');
    expect(() => service.saveCharacter('c')).toThrow(expect.objectContaining({ kind: 'needs_file_name' }));
    expect(service.saveCharacter('c', 'mira').id).toBe('mira');
  });

  it('names a Thai-named file after its English lorebook key, and rejects an unquoted note', async () => {
    service.startBuilder('c');
    const thai = yamlFile('เอลาร่า').replace(
      'lorebook: []',
      'lorebook:\n  - keys: [เอลาร่า, Elera]\n    always_on: true\n    text: |\n      Image tags (Elera): 1girl',
    );
    replies.push(reply(thai.replace('"[ short replies ]"', '[ short replies ]')));
    await service.reply('c', 'Rowan', 'go');
    expect(() => service.saveCharacter('c')).toThrow(expect.objectContaining({ kind: 'invalid_character' }));
    replies.push(reply(thai));
    await service.reply('c', 'Rowan', 'fix it');
    expect(service.saveCharacter('c')).toMatchObject({ id: 'elera', name: 'เอลาร่า' });
  });

  it('keeps /save and the scene prompt to their own modes', async () => {
    service.start('r', 'aria');
    expect(() => service.saveCharacter('r')).toThrow(expect.objectContaining({ kind: 'not_builder' }));
    expect(() => service.builderPortrait('r')).toThrow(expect.objectContaining({ kind: 'not_builder' }));
    service.startBuilder('c');
    await expect(service.writeImagePrompt('c')).rejects.toMatchObject({ kind: 'chat_mode' });
    expect(service.reset('c')).toEqual({ character: null, messageId: null });
  });

  it('draws a portrait from the latest unsaved draft, falling back to the edited file', async () => {
    const withTags = (name: string, tags: string) =>
      yamlFile(name).replace(
        'lorebook: []',
        `lorebook:\n  - keys: [${name}]\n    always_on: true\n    text: |\n      Image tags (${name}): ${tags}`,
      );
    writeFileSync(join(dir, 'aria.yaml'), withTags('Aria', '1girl, short hair, silver hair'));

    service.startBuilder('c', 'aria');
    expect(service.builderPortrait('c')).toEqual({
      main: '1girl, solo, simple background, white background, cowboy shot, standing, looking at viewer, neutral expression',
      characters: [{ name: 'Aria', tags: '1girl, short hair, silver hair' }],
    });

    replies.push(reply(withTags('Aria', '1girl, long hair, red hair')));
    await service.reply('c', 'Rowan', 'make her hair long and red');
    expect(service.builderPortrait('c').characters[0]!.tags).toBe('1girl, long hair, red hair');
    expect(readFileSync(join(dir, 'aria.yaml'), 'utf8')).toContain('silver hair'); // nothing saved

    const seed = service.imageSeed('c');
    expect(service.imageSeed('c')).toBe(seed);
  });

  it('says why it cannot draw', async () => {
    service.startBuilder('c');
    expect(() => service.builderPortrait('c')).toThrow(expect.objectContaining({ kind: 'nothing_to_draw' }));
    replies.push(reply(yamlFile('Mira')));
    await service.reply('c', 'Rowan', 'go');
    expect(() => service.builderPortrait('c')).toThrow(expect.objectContaining({ kind: 'no_image_tags' }));
  });
});
