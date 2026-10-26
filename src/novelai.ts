export type NovelAIErrorKind = 'auth' | 'rate_limit' | 'server' | 'bad_request' | 'network' | 'timeout' | 'empty';

export class NovelAIError extends Error {
  constructor(
    readonly kind: NovelAIErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'NovelAIError';
  }
}

export interface CompletionRequest {
  prompt: string;
  maxTokens: number;
  stop: string[];
  temperature: number;
  topP: number;
}

export interface CompletionResult {
  text: string;
  /** "length" means the output hit max_tokens and may end mid-sentence. */
  finishReason: string | null;
}

export interface TextClientOptions {
  url: string;
  model: string;
  token: string;
  timeoutMs?: number;
  /** Delay before the single retry of a transient failure. */
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

function kindForStatus(status: number): NovelAIErrorKind {
  if (status === 401 || status === 402 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'bad_request';
}

/** Client for NovelAI's OpenAI-style text completions endpoint. */
export class NovelAITextClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TextClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Retries once on transient failures (server errors, empty bodies, network drops). */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    try {
      return await this.completeOnce(request);
    } catch (err) {
      if (!(err instanceof NovelAIError) || (err.kind !== 'server' && err.kind !== 'network')) throw err;
      await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs ?? 1_500));
      return this.completeOnce(request);
    }
  }

  private async completeOnce(request: CompletionRequest): Promise<CompletionResult> {
    const body = {
      model: this.options.model,
      prompt: request.prompt,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      top_p: request.topP,
      stop: request.stop,
      stream: false,
    };

    let response: Response;
    try {
      response = await this.fetchImpl(this.options.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new NovelAIError('timeout', 'NovelAI did not respond in time');
      }
      throw new NovelAIError('network', `Could not reach NovelAI: ${err instanceof Error ? err.message : err}`);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new NovelAIError(kindForStatus(response.status), `NovelAI returned ${response.status}: ${text.slice(0, 500)}`, response.status);
    }

    let data: { choices?: { text?: string; finish_reason?: string | null }[] };
    try {
      data = JSON.parse(text);
    } catch {
      throw new NovelAIError('server', `NovelAI returned a non-JSON response: ${text.slice(0, 200)}`);
    }
    const choice = data.choices?.[0];
    if (typeof choice?.text !== 'string') {
      throw new NovelAIError('empty', `NovelAI response had no choices[0].text: ${text.slice(0, 200)}`);
    }
    return { text: choice.text, finishReason: choice.finish_reason ?? null };
  }
}
