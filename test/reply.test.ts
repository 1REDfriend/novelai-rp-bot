import { describe, expect, it } from 'vitest';
import { cleanReply, splitForDiscord, stopSequences, trimIncomplete } from '../src/reply.js';

describe('stopSequences', () => {
  it('adds one line-start stop per user plus the image prompt terminator, within the limit', () => {
    expect(stopSequences(['Rowan', 'Mew', 'Rowan'])).toEqual(['\nRowan:', '\nMew:', '[/Image Prompt]']);
    expect(stopSequences(['a', 'b', 'c', 'd', 'e'])).toHaveLength(4);
  });
});

describe('cleanReply', () => {
  it('cuts text where the model starts speaking for a user', () => {
    expect(cleanReply(' Hello!\nRowan: I say something\nAria: more', 'Aria', ['Rowan'])).toBe('Hello!');
  });

  it('removes a repeated character label and a stray image prompt', () => {
    expect(cleanReply('Aria: Hi there [Image Prompt]\nMain: 1girl', 'Aria', ['Rowan'])).toBe('Hi there');
  });

  it('keeps only the first character turn', () => {
    expect(cleanReply('First.\nAria: Second turn', 'Aria', [])).toBe('First.');
  });

  it('does not cut on names that merely appear mid-line', () => {
    expect(cleanReply('I told Rowan: wait here.', 'Aria', ['Rowan'])).toBe('I told Rowan: wait here.');
  });

  it('handles names with regex characters', () => {
    expect(cleanReply('Ok\n(Rowan)*: hi', 'Aria', ['(Rowan)*'])).toBe('Ok');
  });
});

describe('splitForDiscord', () => {
  it('splits long text on line breaks under the limit', () => {
    const text = `${'a'.repeat(1500)}\n${'b'.repeat(1500)}`;
    const chunks = splitForDiscord(text);
    expect(chunks).toEqual(['a'.repeat(1500), 'b'.repeat(1500)]);
  });
});

describe('trimIncomplete', () => {
  it('cuts back to the last line break or closed action', () => {
    expect(trimIncomplete('Line one is complete.\nLine two is cut mid')).toBe('Line one is complete.');
    expect(trimIncomplete('*waves happily at you* Hello there my fri')).toBe('*waves happily at you*');
  });

  it('falls back to the last space for Thai text without punctuation', () => {
    expect(trimIncomplete('นั่นคือโมจิค่ะ เจ้านายตัวจริงของร้าน แต่ต้องแอบบ')).toBe('นั่นคือโมจิค่ะ เจ้านายตัวจริงของร้าน');
  });

  it('leaves the text alone when trimming would drop most of it', () => {
    expect(trimIncomplete('Hi. Thisisonelongunbrokenwordthatgoesonandon')).toBe('Hi. Thisisonelongunbrokenwordthatgoesonandon');
  });
});
