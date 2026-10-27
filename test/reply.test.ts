import { describe, expect, it } from 'vitest';
import { cleanReply, dropRepeatedPieces, splitForDiscord, stopSequences, trimIncomplete } from '../src/reply.js';

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

  it('does not stop at an ellipsis, which is a pause mid-sentence', () => {
    expect(trimIncomplete('*เธอเดินต่อไปอย่างระมัดระวัง* อาเรียว่า... ถ้าเราไปทางท่าเรือ')).toBe('*เธอเดินต่อไปอย่างระมัดระวัง*');
    expect(trimIncomplete('She nods and looks at the path ahead. Well… I think we sho')).toBe('She nods and looks at the path ahead.');
  });

  it('falls back to the last space for Thai text without punctuation', () => {
    expect(trimIncomplete('นั่นคือโมจิค่ะ เจ้านายตัวจริงของร้าน แต่ต้องแอบบ')).toBe('นั่นคือโมจิค่ะ เจ้านายตัวจริงของร้าน');
  });

  it('leaves the text alone when trimming would drop most of it', () => {
    expect(trimIncomplete('Hi. Thisisonelongunbrokenwordthatgoesonandon')).toBe('Hi. Thisisonelongunbrokenwordthatgoesonandon');
  });
});

describe('dropRepeatedPieces', () => {
  const earlier = '*She waves.* ยินดีต้อนรับนะคะ\n*อาเรียยิ้มกว้างแล้วโบกมือให้อย่างร่าเริง* วันนี้อากาศดีจังเลยนะคะ!';

  it('removes actions and sentences already used in recent replies', () => {
    const reply = 'โมจิหลับอยู่บนเคาน์เตอร์ค่ะ\n*อาเรียยิ้มกว้างแล้วโบกมือให้อย่างร่าเริง* วันนี้อากาศดีจังเลยนะคะ!';
    expect(dropRepeatedPieces(reply, [earlier])).toBe('โมจิหลับอยู่บนเคาน์เตอร์ค่ะ');
  });

  it('ignores spacing and punctuation differences but keeps short pieces', () => {
    const reply = 'อุ๊ย! *She waves.* ไปกันเลย *อาเรียยิ้มกว้าง แล้วโบกมือให้อย่างร่าเริง*';
    expect(dropRepeatedPieces(reply, [earlier])).toBe('อุ๊ย! *She waves.* ไปกันเลย');
    expect(dropRepeatedPieces('ไปกันเลย วันนี้อากาศดีจังเลยนะคะ...', [earlier])).toBe('ไปกันเลย');
  });

  it('returns an empty string when everything repeats', () => {
    expect(dropRepeatedPieces('วันนี้อากาศดีจังเลยนะคะ!', [earlier])).toBe('');
  });
});
