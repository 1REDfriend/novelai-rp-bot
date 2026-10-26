import { estimateTokens, type ChatMessage } from './context.js';
import { type CompletionResult, NovelAIError } from './novelai.js';

/** Reserved binding id for assistant chat mode. ":" cannot appear in a character file name. */
export const CHAT_MODE_ID = ':chat';
export const CHAT_ASSISTANT_NAME = 'Assistant';

export const CHAT_SYSTEM_PROMPT = [
  'You are a helpful, knowledgeable assistant chatting in a Discord channel.',
  'Answer the latest message directly and accurately. Explain step by step when it helps.',
  'If you are not sure, say so instead of guessing. Ask a short clarifying question when the request is unclear.',
  "Reply in the same language the user wrote in (Thai if they wrote Thai).",
  'Format with Discord markdown: short paragraphs, lists, and code blocks where useful.',
].join('\n');

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatTurn[];
  maxTokens: number;
  temperature: number;
  topP: number;
}

/**
 * Turns channel history into chat turns. Oldest messages are dropped first to
 * fit the budget; the system prompt and the latest message are always kept.
 * When more than one person has spoken, user turns are prefixed with the name.
 */
export function buildChatMessages(
  history: ChatMessage[],
  note: string | null,
  maxPromptTokens: number,
  systemPrompt = CHAT_SYSTEM_PROMPT,
): ChatTurn[] {
  const system = note ? `${systemPrompt}\n\nExtra instructions for this channel: ${note}` : systemPrompt;
  const multiUser = new Set(history.filter((m) => m.role === 'user').map((m) => m.author)).size > 1;
  const turns: ChatTurn[] = history.map((m) =>
    m.role === 'user'
      ? { role: 'user', content: multiUser ? `${m.author}: ${m.content}` : m.content }
      : { role: 'assistant', content: m.content },
  );

  let used = estimateTokens(system);
  let start = turns.length;
  while (start > 0) {
    const cost = estimateTokens(turns[start - 1]!.content) + 4;
    if (start < turns.length && used + cost > maxPromptTokens) break;
    used += cost;
    start--;
  }
  return [{ role: 'system', content: system }, ...turns.slice(start)];
}

/** Removes any reasoning block the model might emit before its answer. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export interface ChatClientOptions {
  url: string;
  model: string;
  token: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Client for NovelAI's OpenAI-style chat endpoint. The endpoint only returns
 * text when streaming (stream: false gives an empty "text"), so this always
 * streams and joins the deltas.
 */
export class NovelAIChatClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ChatClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Retries once on transient failures (server errors, network drops). */
  async chat(request: ChatRequest): Promise<CompletionResult> {
    try {
      return await this.chatOnce(request);
    } catch (err) {
      if (!(err instanceof NovelAIError) || (err.kind !== 'server' && err.kind !== 'network')) throw err;
      await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs ?? 1_500));
      return this.chatOnce(request);
    }
  }

  private async chatOnce(request: ChatRequest): Promise<CompletionResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.options.model,
          messages: request.messages,
          max_tokens: request.maxTokens,
          temperature: request.temperature,
          top_p: request.topP,
          stream: true,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 240_000),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new NovelAIError('timeout', 'NovelAI did not respond in time');
      }
      throw new NovelAIError('network', `Could not reach NovelAI: ${err instanceof Error ? err.message : err}`);
    }

    if (!response.ok) {
      const body = await response.text();
      const s = response.status;
      const kind = s === 401 || s === 402 || s === 403 ? 'auth' : s === 429 ? 'rate_limit' : s >= 500 ? 'server' : 'bad_request';
      throw new NovelAIError(kind, `NovelAI returned ${s}: ${body.slice(0, 500)}`, s);
    }

    let body: string;
    try {
      body = await response.text();
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new NovelAIError('timeout', 'NovelAI stopped responding mid-reply');
      }
      throw new NovelAIError('network', 'The connection dropped mid-reply');
    }
    return parseChatStream(body);
  }
}

/** Joins the content deltas of an OpenAI-style server-sent event stream. */
export function parseChatStream(body: string): CompletionResult {
  let text = '';
  let finishReason: string | null = null;
  let events = 0;
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let chunk: { choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[] };
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    events++;
    const choice = chunk.choices?.[0];
    text += choice?.delta?.content ?? '';
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  }
  if (events === 0) throw new NovelAIError('server', `NovelAI chat stream had no events: ${body.slice(0, 200)}`);
  return { text: stripThinking(text), finishReason };
}
