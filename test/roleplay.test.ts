import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { imageTagsByName, loadCharacters } from '../src/characters.js';
import { HistoryStore } from '../src/history.js';
import type { CompletionRequest, CompletionResult } from '../src/novelai.js';
import { RoleplayError, RoleplayService } from '../src/roleplay.js';

const charactersDir = join(import.meta.dirname, '..', 'characters');

class FakeText {
  requests: CompletionRequest[] = [];
  outputs: string[] = [];
  finishReason: string | null = 'stop';
  /** Per-call finish reasons, used before falling back to finishReason. */
  finishReasons: (string | null)[] = [];
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(request);
    const finishReason = this.finishReasons.length ? this.finishReasons.shift()! : this.finishReason;
    return { text: this.outputs.shift() ?? ' Default reply.', finishReason };
  }
}

const config = {
  maxOutputTokens: 150,
  maxContextTokens: 8000,
  temperature: 1,
  topP: 0.95,
  lorebookScanDepth: 4,
  authorsNoteDepth: 1,
  chatMaxOutputTokens: 1500,
  builderMaxOutputTokens: 3000,
  builderMaxContextTokens: 16000,
};

let store: HistoryStore;
let text: FakeText;
let service: RoleplayService;

beforeEach(() => {
  store = new HistoryStore(':memory:');
  text = new FakeText();
  service = new RoleplayService(config, store, text, () => loadCharacters(charactersDir));
});

describe('example character', () => {
  it('loads without errors', () => {
    const { characters, errors } = loadCharacters(charactersDir);
    expect(errors).toEqual([]);
    expect(characters.get('aria')?.name).toBe('Aria');
  });
});

describe('RoleplayService', () => {
  it('only answers in bound channels', async () => {
    await expect(service.reply('c1', 'Rowan', 'hi')).rejects.toBeInstanceOf(RoleplayError);
  });

  it('start stores the greeting; reply builds a prompt ending in the character label', async () => {
    service.start('c1', 'Aria');
    text.outputs.push(' Hello traveler!\nRowan: (model wrote for the user)');
    const reply = await service.reply('c1', 'Rowan', 'Hi, is Mochi here?');

    expect(reply.text).toBe('Hello traveler!');
    const request = text.requests[0]!;
    expect(request.prompt.endsWith('Rowan: Hi, is Mochi here?\nAria:')).toBe(true);
    expect(request.prompt).toContain('[ Mochi:'); // keyword lorebook entry triggered
    expect(request.prompt).toContain('never speaks for the traveler'); // author's note
    expect(request.stop).toEqual(['\nRowan:', '[/Image Prompt]']);
    expect(store.getMessages('c1').map((m) => m.role)).toEqual(['character', 'user', 'character']);
  });

  it('regen replaces the latest reply and returns the old Discord ids', async () => {
    service.start('c1', 'aria');
    const first = await service.reply('c1', 'Rowan', 'hi');
    service.attachDiscordIds(first.messageId, ['d1']);
    text.outputs.push(' New reply.');
    const regen = await service.regen('c1');

    expect(regen.removedDiscordIds).toEqual(['d1']);
    expect(store.getMessages('c1').map((m) => m.content).at(-1)).toBe('New reply.');
    expect(store.getMessages('c1')).toHaveLength(3);
  });

  it('regen refuses when only the greeting exists', async () => {
    service.start('c1', 'aria');
    await expect(service.regen('c1')).rejects.toMatchObject({ kind: 'nothing_to_regen' });
  });

  it('regen recovers after a failed generation left a trailing user message', async () => {
    service.start('c1', 'aria');
    store.addMessage('c1', { role: 'user', author: 'Rowan', content: 'hi' });
    const regen = await service.regen('c1');
    expect(regen.removedDiscordIds).toEqual([]);
    expect(store.getMessages('c1')).toHaveLength(3);
  });

  it('undo removes the last pair but never the greeting', async () => {
    service.start('c1', 'aria');
    await service.reply('c1', 'Rowan', 'hi');
    expect(service.undo('c1').removed).toHaveLength(2);
    expect(store.getMessages('c1')).toHaveLength(1);
    expect(() => service.undo('c1')).toThrow(RoleplayError);
  });

  it('note override replaces the default note until reset', async () => {
    service.start('c1', 'aria');
    service.setNote('c1', '[ Aria is sleepy ]');
    await service.reply('c1', 'Rowan', 'hi');
    expect(text.requests[0]!.prompt).toContain('[ Aria is sleepy ]');
    expect(text.requests[0]!.prompt).not.toContain('never speaks for the traveler');

    service.reset('c1');
    expect(store.getMessages('c1')).toHaveLength(1);
    await service.reply('c1', 'Rowan', 'hi again');
    expect(text.requests[1]!.prompt).toContain('never speaks for the traveler');
  });

  it('lets a reply cut off by the token limit finish its sentence', async () => {
    service.start('c1', 'aria');
    text.finishReasons.push('length', 'stop');
    text.outputs.push(' *She smiles.* That is Mochi!\n\n*She reaches for the sh', 'elf.* Want a treat?');
    const reply = await service.reply('c1', 'Rowan', 'who is the cat?');
    expect(reply.text).toBe('*She smiles.* That is Mochi!\n\n*She reaches for the shelf.* Want a treat?');
    expect(text.requests[1]!.prompt.endsWith('*She reaches for the sh')).toBe(true);
    expect(text.requests[1]!.maxTokens).toBe(120);
  });

  it('trims back to the last complete sentence when the extra budget runs out too', async () => {
    service.start('c1', 'aria');
    text.finishReason = 'length';
    text.outputs.push(' *She smiles.* That is Mochi!', ' He loves fish. *She reaches for the sh');
    const reply = await service.reply('c1', 'Rowan', 'who is the cat?');
    expect(reply.text).toBe('*She smiles.* That is Mochi! He loves fish.');
  });

  it('retries once when the cleaned reply is empty, then gives up', async () => {
    service.start('c1', 'aria');
    text.outputs.push('Rowan: only user lines', 'Rowan: again');
    await expect(service.reply('c1', 'Rowan', 'hi')).rejects.toMatchObject({ kind: 'empty' });
    expect(text.requests).toHaveLength(2);
  });
});

describe('RoleplayService.writeImagePrompt', () => {
  it('adds the image rules and prefill, skips the Author\'s Note, and stores nothing', async () => {
    service.start('c1', 'aria');
    await service.reply('c1', 'Rowan', 'hi');
    text.outputs.push(' 1girl, indoors\nCharacter 1 (Aria): 1girl, silver hair, smile\n');
    const before = store.getMessages('c1').length;

    const prompt = await service.writeImagePrompt('c1');

    expect(prompt.characters[0]!.name).toBe('Aria');
    expect(prompt.characters[0]!.tags.endsWith('brown boots, ink on fingers, smile')).toBe(true);
    const request = text.requests.at(-1)!;
    expect(request.prompt).toContain('[Image Prompt] means:');
    expect(request.prompt.endsWith('[Image Prompt]\nMain:')).toBe(true);
    expect(request.prompt).not.toContain('never speaks for the traveler');
    expect(request.stop).toEqual(['[/Image Prompt]']);
    expect(store.getMessages('c1')).toHaveLength(before);
  });

  it('retries up to 3 times on unparseable output, then fails', async () => {
    service.start('c1', 'aria');
    text.outputs.push(' 1girl\nAria: เธอยิ้ม', ' 1girl\nAria: "Hello there!"', ' 1girl\n(stray narration line)');
    await expect(service.writeImagePrompt('c1')).rejects.toMatchObject({ kind: 'image_prompt_failed' });
    expect(text.requests).toHaveLength(3);
  });
});

describe('image tags and seed', () => {
  it('reads every Image tags line from the lorebook, including keyword-only entries', () => {
    const aria = loadCharacters(charactersDir).characters.get('aria')!;
    const tags = imageTagsByName(aria);
    expect(tags.get('aria')).toContain('long skirt');
    expect(tags.get('mochi')).toContain('orange cat');
  });

  it('locks Aria\'s lorebook look into the image prompt even if the model changes it', async () => {
    service.start('c1', 'aria');
    text.outputs.push(' 1girl, shop\nCharacter 1 (Aria): smile, jeans, from behind\n');
    const prompt = await service.writeImagePrompt('c1');
    expect(prompt.characters[0]!.tags.startsWith('1girl, petite, short hair, bob cut, silver hair')).toBe(true);
    expect(prompt.characters[0]!.tags.endsWith('smile, jeans, from behind')).toBe(true);
  });

  it('keeps one seed per channel until asked for a new one, and /start resets it', () => {
    service.start('c1', 'aria');
    const first = service.imageSeed('c1');
    expect(service.imageSeed('c1')).toBe(first);
    const fresh = service.imageSeed('c1', true);
    expect(service.imageSeed('c1')).toBe(fresh);
    service.reset('c1');
    expect(service.imageSeed('c1')).toBe(fresh);
    service.start('c1', 'aria');
    expect(store.getImageSeed('c1')).toBeNull();
  });
});
