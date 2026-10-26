import { describe, expect, it } from 'vitest';
import type { Character } from '../src/characters.js';
import { activeLorebookEntries, buildPrompt, type ChatMessage } from '../src/context.js';

const character: Character = {
  id: 'aria',
  name: 'Aria',
  memory: '[ MEMORY ]',
  authorsNote: '[ NOTE ]',
  greeting: 'Hi',
  lorebook: [
    { keys: ['aria'], text: '[ ALWAYS ]', alwaysOn: true },
    { keys: ['cat', 'Mochi'], text: '[ CAT ]', alwaysOn: false },
    { keys: ['lighthouse'], text: '[ LIGHTHOUSE ]', alwaysOn: false },
  ],
};

const user = (content: string, author = 'Rowan'): ChatMessage => ({ role: 'user', author, content });
const aria = (content: string): ChatMessage => ({ role: 'character', author: 'Aria', content });

describe('activeLorebookEntries', () => {
  it('includes always-on entries and keyword matches within the scan depth only', () => {
    const history = [user('the lighthouse'), aria('ok'), user('where is mochi?')];
    expect(activeLorebookEntries(character.lorebook, history, 2).map((e) => e.text)).toEqual(['[ ALWAYS ]', '[ CAT ]']);
    expect(activeLorebookEntries(character.lorebook, history, 3).map((e) => e.text)).toEqual([
      '[ ALWAYS ]',
      '[ CAT ]',
      '[ LIGHTHOUSE ]',
    ]);
  });
});

describe('buildPrompt', () => {
  it('orders memory, lorebook, history, note before the latest message, then prefill', () => {
    const history = [aria('Welcome!'), user('Hello'), aria('Hi there'), user('Tell me about the cat')];
    const { prompt } = buildPrompt({
      character,
      history,
      authorsNote: character.authorsNote,
      scanDepth: 4,
      noteDepth: 1,
      maxPromptTokens: 10_000,
    });
    expect(prompt.split('\n')).toEqual([
      '[ MEMORY ]',
      '[ ALWAYS ]',
      '[ CAT ]',
      'Aria: Welcome!',
      'Rowan: Hello',
      'Aria: Hi there',
      '[ NOTE ]',
      'Rowan: Tell me about the cat',
      'Aria:',
    ]);
  });

  it('drops the oldest history first and keeps memory, lorebook, note and the latest message', () => {
    const filler = 'x'.repeat(350); // about 120 estimated tokens per line
    const history = [user(`old ${filler}`), aria(`mid ${filler}`), user(`new ${filler}`)];
    const { prompt, historyUsed } = buildPrompt({
      character,
      history,
      authorsNote: character.authorsNote,
      scanDepth: 4,
      noteDepth: 1,
      maxPromptTokens: 270,
    });
    expect(historyUsed).toBe(2);
    expect(prompt).not.toContain('old ');
    expect(prompt).toContain('[ MEMORY ]');
    expect(prompt).toContain('[ ALWAYS ]');
    expect(prompt).toContain('[ NOTE ]');
    expect(prompt).toContain('new ');
  });

  it('keeps the latest message even when it alone exceeds the budget', () => {
    const { historyUsed } = buildPrompt({
      character,
      history: [user('y'.repeat(5000))],
      authorsNote: '',
      scanDepth: 4,
      noteDepth: 1,
      maxPromptTokens: 10,
    });
    expect(historyUsed).toBe(1);
  });

  it('places extra entries after the lorebook and uses a custom prefill', () => {
    const { prompt } = buildPrompt({
      character,
      history: [user('hi')],
      authorsNote: '',
      scanDepth: 4,
      noteDepth: 1,
      maxPromptTokens: 10_000,
      extraEntries: ['[ EXTRA ]'],
      prefill: '[Image Prompt]\nMain:',
    });
    expect(prompt).toBe('[ MEMORY ]\n[ ALWAYS ]\n[ EXTRA ]\nRowan: hi\n[Image Prompt]\nMain:');
  });
});
