import { describe, expect, it } from 'vitest';
import { buildChatMessages, CHAT_SYSTEM_PROMPT, NovelAIChatClient, parseChatStream } from '../src/chat.js';
import type { ChatMessage } from '../src/context.js';
import { HistoryStore } from '../src/history.js';
import type { CompletionRequest } from '../src/novelai.js';
import { RoleplayService } from '../src/roleplay.js';

const user = (content: string, author = 'Rowan'): ChatMessage => ({ role: 'user', author, content });
const bot = (content: string): ChatMessage => ({ role: 'character', author: 'Assistant', content });

function sse(...deltas: (string | { finish: string })[]): string {
  return [
    ...deltas.map((d) =>
      typeof d === 'string'
        ? `data: ${JSON.stringify({ choices: [{ delta: { content: d }, finish_reason: null }] })}`
        : `data: ${JSON.stringify({ choices: [{ delta: { content: '' }, finish_reason: d.finish }] })}`,
    ),
    'data: [DONE]',
  ].join('\n\n');
}

describe('buildChatMessages', () => {
  it('maps history to system/user/assistant turns', () => {
    expect(buildChatMessages([user('hi'), bot('hello'), user('why is the sky blue?')], null, 10_000)).toEqual([
      { role: 'system', content: CHAT_SYSTEM_PROMPT },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'why is the sky blue?' },
    ]);
  });

  it('prefixes names only when several people talk, and appends the /note', () => {
    const turns = buildChatMessages([user('hi', 'A'), user('yo', 'B')], 'Answer in English', 10_000);
    expect(turns[0]!.content).toContain('Extra instructions for this channel: Answer in English');
    expect(turns.slice(1).map((t) => t.content)).toEqual(['A: hi', 'B: yo']);
  });

  it('drops the oldest turns first but keeps the latest', () => {
    const long = 'x'.repeat(3000);
    const turns = buildChatMessages([user(`old ${long}`), bot(`mid ${long}`), user('latest')], null, 1200);
    expect(turns.map((t) => t.content.slice(0, 4))).toEqual([CHAT_SYSTEM_PROMPT.slice(0, 4), 'mid ', 'late']);
  });
});

describe('parseChatStream', () => {
  it('joins deltas, reads finish_reason and strips <think> blocks', () => {
    expect(parseChatStream(sse('<think>plan</think>', 'Hel', 'lo!', { finish: 'stop' }))).toEqual({
      text: 'Hello!',
      finishReason: 'stop',
    });
  });

  it('treats a body without events as a server error', () => {
    expect(() => parseChatStream('')).toThrow(/no events/);
  });
});

describe('NovelAIChatClient', () => {
  it('always streams and returns the joined text', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(sse('Hi', ' there', { finish: 'stop' }), { headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch;
    const client = new NovelAIChatClient({ url: 'u', model: 'glm-4-6', token: 't', fetchImpl });
    const result = await client.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100, temperature: 0.7, topP: 0.95 });
    expect(result.text).toBe('Hi there');
    expect(sent).toMatchObject({ model: 'glm-4-6', stream: true, max_tokens: 100 });
  });

  it('maps 401 to an auth error', async () => {
    const fetchImpl = (async () => new Response('no', { status: 401 })) as unknown as typeof fetch;
    const client = new NovelAIChatClient({ url: 'u', model: 'm', token: 't', fetchImpl });
    await expect(client.chat({ messages: [], maxTokens: 1, temperature: 1, topP: 1 })).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('RoleplayService chat mode', () => {
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
    storyDirective: '',
  };
  const noCharacters = () => ({ characters: new Map(), errors: [] });
  const text = { complete: async (_r: CompletionRequest) => ({ text: 'unused', finishReason: 'stop' }) };

  function setup(replies: string[]) {
    const store = new HistoryStore(':memory:');
    const requests: unknown[] = [];
    const chat = {
      chat: async (r: unknown) => {
        requests.push(r);
        return { text: replies.shift() ?? 'default', finishReason: 'stop' };
      },
    };
    const service = new RoleplayService(config, store, text, noCharacters, chat);
    service.startChat('c');
    return { service, store, requests };
  }

  it('replies through the chat client with no greeting and no character', async () => {
    const { service, store, requests } = setup(['Because of Rayleigh scattering.']);
    expect(store.getMessages('c')).toHaveLength(0);
    const reply = await service.reply('c', 'Rowan', 'why is the sky blue?');
    expect(reply).toMatchObject({ character: null, text: 'Because of Rayleigh scattering.' });
    expect(requests[0]).toMatchObject({ maxTokens: 1500 });
  });

  it('supports /regen, /undo, /note and /reset', async () => {
    const { service, store, requests } = setup(['first', 'second']);
    await service.reply('c', 'Rowan', 'q');
    expect((await service.regen('c')).text).toBe('second');
    service.setNote('c', 'Be brief');
    await service.reply('c', 'Rowan', 'q2');
    expect(JSON.stringify(requests.at(-1))).toContain('Be brief');
    expect(service.undo('c').removed).toHaveLength(2);
    expect(service.reset('c')).toEqual({ character: null, messageId: null });
    expect(store.getMessages('c')).toHaveLength(0);
    expect(service.isChat('c')).toBe(true);
  });

  it('refuses /image in chat mode', async () => {
    const { service } = setup([]);
    await expect(service.writeImagePrompt('c')).rejects.toMatchObject({ kind: 'chat_mode' });
  });
});
