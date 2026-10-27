import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  assertFreeRequest,
  buildImageRequest,
  checkAllowance,
  GENERATE_IMAGE_URL,
  IMAGE_SIZES,
  ImageQuotaError,
  NovelAIImageClient,
} from '../src/image.js';
import { applyImageTags, formatImagePrompt, parseImagePrompt } from '../src/imagePrompt.js';

const prompt = {
  main: '1girl, 1boy, indoors, potion shop',
  characters: [
    { name: 'Aria', tags: '1girl, silver hair, smile' },
    { name: 'Rowan', tags: '1boy, traveler cloak' },
  ],
};

const subscription = (usage: object, anlas = 9963) => ({
  tier: 3,
  active: true,
  usage: { percent: 100, purchasedPercent: 0, isNegative: false, timeUntilNextPercent: 7888, ...usage },
  trainingStepsLeft: { fixedTrainingStepsLeft: anlas, purchasedTrainingSteps: 0 },
});

describe('parseImagePrompt', () => {
  it('splits Main and per-character lines, dropping labels', () => {
    const out = parseImagePrompt(
      ' 1girl, indoors, potion shop, warm lighting.\nCharacter 1 (Aria): 1girl, silver hair, smile, holding bottle\n[/Image Prompt]',
    );
    expect(out).toEqual({
      main: '1girl, indoors, potion shop, warm lighting',
      characters: [{ name: 'Aria', tags: '1girl, silver hair, smile, holding bottle' }],
    });
  });

  it('drops empty template slots like "no held item"', () => {
    expect(parseImagePrompt(' 1girl\nCharacter 1 (Aria): 1girl, smile, no held item, none')?.characters[0]?.tags).toBe('1girl, smile');
  });

  it('rejects story text, sentences and missing Main', () => {
    expect(parseImagePrompt(' 1girl, shop\nAria: Hello there!')).toBeNull();
    expect(parseImagePrompt(' she is standing in the shop smiling at the traveler who just walked in')).toBeNull();
    expect(parseImagePrompt('')).toBeNull();
  });

  it('round-trips through formatImagePrompt', () => {
    const text = formatImagePrompt(prompt);
    expect(parseImagePrompt(text.replace(/^Main:/, ''))).toEqual(prompt);
  });
});

describe('buildImageRequest / assertFreeRequest', () => {
  it('builds a V5 Full request with per-character captions inside the free limits', () => {
    const request = buildImageRequest(prompt, 'portrait', 42);
    expect(request.model).toBe('nai-diffusion-5-full');
    expect(request.parameters.params_version).toBe(4);
    expect(request.parameters.n_samples).toBe(1);
    expect(request.parameters.steps).toBeLessThanOrEqual(28);
    expect(request.parameters.v4_prompt.caption.char_captions.map((c) => c.char_caption)).toEqual([
      '1girl, silver hair, smile',
      '1boy, traveler cloak',
    ]);
    expect(() => assertFreeRequest(request)).not.toThrow();
  });

  it('every offered size fits in one megapixel', () => {
    for (const { width, height } of Object.values(IMAGE_SIZES)) expect(width * height).toBeLessThanOrEqual(1024 * 1024);
  });

  it('blocks requests that could cost Anlas', () => {
    const tamper = (change: (p: Record<string, unknown>) => void, model?: string) => {
      const request = buildImageRequest(prompt, 'square', 1);
      change(request.parameters as Record<string, unknown>);
      if (model) request.model = model;
      return () => assertFreeRequest(request);
    };
    expect(tamper((p) => (p.n_samples = 2))).toThrow();
    expect(tamper((p) => (p.steps = 29))).toThrow();
    expect(tamper((p) => ((p.width = 1216), (p.height = 1216)))).toThrow();
    expect(tamper((p) => (p.reference_image_multiple = ['x']))).toThrow();
    expect(tamper((p) => (p.image = 'base64'))).toThrow();
    expect(tamper(() => undefined, 'nai-diffusion-4-5-full')).toThrow();
  });
});

describe('checkAllowance', () => {
  it('passes with allowance left and reports the Anlas balance', () => {
    expect(checkAllowance(subscription({ percent: 40 }))).toEqual({ percent: 40, secondsPerPercent: 7888, anlas: 9963 });
  });

  it('refuses when the allowance is low or negative, with a wait estimate', () => {
    const low = (() => {
      try {
        checkAllowance(subscription({ percent: 1, timeUntilNextPercent: 600 }));
      } catch (err) {
        return err;
      }
    })();
    expect(low).toBeInstanceOf(ImageQuotaError);
    expect(low).toMatchObject({ reason: 'low', waitSeconds: 600 });
    expect(() => checkAllowance(subscription({ percent: 5, isNegative: true }))).toThrow(ImageQuotaError);
  });

  it('fails closed on non-Opus or unreadable responses', () => {
    expect(() => checkAllowance({ ...subscription({}), tier: 2 })).toThrow(/Opus/);
    expect(() => checkAllowance({ ...subscription({}), usage: undefined })).toThrow(ImageQuotaError);
    expect(() => checkAllowance(null)).toThrow(ImageQuotaError);
  });
});

describe('NovelAIImageClient', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  function fakeFetch(subs: object[], calls: string[]) {
    return (async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url) === GENERATE_IMAGE_URL) return new Response(zipSync({ 'image_0.png': png }));
      return Response.json(subs.shift());
    }) as typeof fetch;
  }

  it('checks the allowance, generates, unzips the PNG and compares Anlas', async () => {
    const calls: string[] = [];
    const client = new NovelAIImageClient('t', fakeFetch([subscription({}), subscription({ percent: 99 })], calls));
    const result = await client.generate(prompt, 'landscape', 7);
    expect([...result.png]).toEqual([...png]);
    expect(result).toMatchObject({ width: 1216, height: 832, anlasSpent: 0, percentAfter: 99 });
    expect(calls.filter((u) => u === GENERATE_IMAGE_URL)).toHaveLength(1);
  });

  it('reports Anlas spent when the balance drops', async () => {
    const client = new NovelAIImageClient('t', fakeFetch([subscription({}, 100), subscription({}, 55)], []));
    expect((await client.generate(prompt, 'square', 7)).anlasSpent).toBe(45);
  });

  it('never calls generate when the allowance is used up', async () => {
    const calls: string[] = [];
    const client = new NovelAIImageClient('t', fakeFetch([subscription({ percent: 0 })], calls));
    await expect(client.generate(prompt, 'portrait', 7)).rejects.toBeInstanceOf(ImageQuotaError);
    expect(calls).not.toContain(GENERATE_IMAGE_URL);
  });
});

describe('NovelAIImageClient concurrency lock', () => {
  it('waits and retries on 429 "Concurrent generation is locked", then succeeds', async () => {
    let generateCalls = 0;
    const subs = [subscription({}), subscription({})];
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url) !== GENERATE_IMAGE_URL) return Response.json(subs.shift());
      generateCalls++;
      if (generateCalls < 3) return Response.json({ statusCode: 429, message: 'Concurrent generation is locked' }, { status: 429 });
      return new Response(zipSync({ 'a.png': new Uint8Array([1]) }));
    }) as typeof fetch;
    const client = new NovelAIImageClient('t', fetchImpl, 1, 4);
    await expect(client.generate(prompt, 'square', 7)).resolves.toMatchObject({ anlasSpent: 0 });
    expect(generateCalls).toBe(3);
  });

  it('gives up after the retry limit with a rate_limit error', async () => {
    const fetchImpl = (async (url: string | URL | Request) =>
      String(url) === GENERATE_IMAGE_URL
        ? Response.json({ message: 'Concurrent generation is locked' }, { status: 429 })
        : Response.json(subscription({}))) as typeof fetch;
    await expect(new NovelAIImageClient('t', fetchImpl, 1, 2).generate(prompt, 'square', 7)).rejects.toMatchObject({ kind: 'rate_limit' });
  });
});

describe('applyImageTags', () => {
  it('puts canonical tags first, keeps scene tags, drops duplicates, leaves unknown characters alone', () => {
    const canonical = new Map([['aria', '1girl, silver hair, long skirt']]);
    const out = applyImageTags(
      {
        main: '1girl, 1boy, shop',
        characters: [
          { name: 'Aria', tags: 'smile, Silver hair, from behind, looking back' },
          { name: 'Stranger', tags: '1boy, hood' },
        ],
      },
      canonical,
    );
    expect(out.characters).toEqual([
      { name: 'Aria', tags: '1girl, silver hair, long skirt, smile, from behind, looking back' },
      { name: 'Stranger', tags: '1boy, hood' },
    ]);
  });
});

describe('parseImagePrompt: real outputs that used to fail', () => {
  it('accepts a bare "Name:" character label', () => {
    const out = parseImagePrompt(
      ' 1girl, full body shot, potion shop\nAria: shocked and embarrassed expression, wide eyes, both hands clutching the hem of her green apron\n',
    );
    expect(out?.characters).toEqual([
      { name: 'Aria', tags: 'shocked and embarrassed expression, wide eyes, both hands clutching the hem of her green apron' },
    ]);
  });

  it('accepts descriptive phrases longer than 8 words', () => {
    const out = parseImagePrompt(
      ' 1girl, 1boy, shop\nCharacter 1 (Aria): blushing, pulling her green apron down to cover her rear\nCharacter 2 (1REDfriend): standing in front of Aria\n',
    );
    expect(out?.characters.map((c) => c.name)).toEqual(['Aria', '1REDfriend']);
  });

  it('accepts "Character 1 - Name:" and bulleted bold labels', () => {
    const out = parseImagePrompt(' 1girl, shop\nCharacter 1 - Aria: smile\n- **Mochi**: sleeping, curled up');
    expect(out?.characters).toEqual([
      { name: 'Aria', tags: 'smile' },
      { name: 'Mochi', tags: 'sleeping, curled up' },
    ]);
  });
});

describe('parseImagePrompt: characters named in Thai', () => {
  it('replaces Thai names inside tags instead of rejecting the prompt', () => {
    const parsed = parseImagePrompt(
      " 1girl, 1boy, forest\nCharacter 1 (ดาวเรือง): smile, looking at user\nCharacter 2 (User): looking at ดาวเรือง, holding ดาวเรือง's hand",
    );
    expect(parsed?.characters).toEqual([
      { name: 'ดาวเรือง', tags: 'smile, looking at user' },
      { name: 'User', tags: "looking at the other person, holding the other person's hand" },
    ]);
  });

  it('still rejects Thai text that is not a character name', () => {
    expect(parseImagePrompt(' 1girl, forest\nCharacter 1 (ดาวเรือง): ยิ้ม, smile')).toBeNull();
  });
});
