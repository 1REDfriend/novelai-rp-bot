import { unzipSync } from 'fflate';
import { NovelAIError } from './novelai.js';

export const IMAGE_MODEL = 'nai-diffusion-5-full';
export const GENERATE_IMAGE_URL = 'https://image.novelai.net/ai/generate-image';
export const SUBSCRIPTION_URL = 'https://image.novelai.net/user/subscription';

/** Sizes that stay inside Opus's free "Normal" size. Nothing else can be requested. */
export const IMAGE_SIZES = {
  portrait: { width: 832, height: 1216 },
  landscape: { width: 1216, height: 832 },
  square: { width: 1024, height: 1024 },
} as const;
export type ImageOrientation = keyof typeof IMAGE_SIZES;

const MAX_PIXELS = 1024 * 1024;
const MAX_STEPS = 28;
const STEPS = 28;
const OPUS_TIER = 3;
/** Refuse when the V5 allowance is below this, so a coarse percent never tips into Anlas. */
export const MIN_REMAINING_PERCENT = 2;

const QUALITY_TAGS = 'best quality, very aesthetic, absurdres';
const NEGATIVE_PROMPT =
  'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, ' +
  'very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, ' +
  'too many watermarks, negative space, blank page, text, signature';

/**
 * The only parameter keys a request may carry. Mirrors the keys known to stay
 * Anlas-free on Opus: no base image, no reference images, no Vibe Transfer.
 */
const ALLOWED_PARAMETER_KEYS = new Set([
  'width', 'height', 'n_samples', 'seed', 'extra_noise_seed', 'sampler', 'steps', 'scale',
  'negative_prompt', 'cfg_rescale', 'prefer_brownian', 'noise_schedule', 'params_version',
  'legacy', 'legacy_v3_extend', 'add_original_image', 'legacy_uc', 'v4_prompt', 'v4_negative_prompt',
]);

export interface ImagePrompt {
  main: string;
  characters: { name: string; tags: string }[];
}

export interface Allowance {
  percent: number;
  /** Seconds until the allowance gains 1%. */
  secondsPerPercent: number;
  anlas: number;
}

export class ImageQuotaError extends Error {
  constructor(
    readonly reason: 'low' | 'not_opus' | 'unverifiable',
    message: string,
    /** Rough wait until generation is allowed again, when known. */
    readonly waitSeconds?: number,
  ) {
    super(message);
    this.name = 'ImageQuotaError';
  }
}

export function buildImageRequest(prompt: ImagePrompt, orientation: ImageOrientation, seed: number) {
  const { width, height } = IMAGE_SIZES[orientation];
  const base = [prompt.main, QUALITY_TAGS].filter(Boolean).join(', ');
  const center = { x: 0.5, y: 0.5 };
  const parameters = {
    params_version: 4,
    width,
    height,
    n_samples: 1,
    seed,
    extra_noise_seed: seed,
    sampler: 'k_euler_ancestral',
    noise_schedule: 'karras',
    steps: STEPS,
    scale: 5,
    cfg_rescale: 0,
    prefer_brownian: true,
    negative_prompt: NEGATIVE_PROMPT,
    legacy: false,
    legacy_v3_extend: false,
    legacy_uc: false,
    add_original_image: true,
    v4_prompt: {
      caption: {
        base_caption: base,
        char_captions: prompt.characters.map((c) => ({ char_caption: c.tags, centers: [center] })),
      },
      // Let the model place characters; positions come from the prompt tags.
      use_coords: false,
      use_order: true,
      legacy_uc: false,
    },
    v4_negative_prompt: {
      caption: {
        base_caption: NEGATIVE_PROMPT,
        char_captions: prompt.characters.map(() => ({ char_caption: '', centers: [center] })),
      },
      use_coords: false,
      use_order: false,
      legacy_uc: false,
    },
  };
  return { input: base, model: IMAGE_MODEL, action: 'generate', parameters };
}

/** Throws unless the request is one image, V5 Full, within free size/steps, with no extra inputs. */
export function assertFreeRequest(request: ReturnType<typeof buildImageRequest>): void {
  const p = request.parameters as Record<string, unknown>;
  const extra = Object.keys(p).filter((k) => !ALLOWED_PARAMETER_KEYS.has(k));
  const width = p.width as number;
  const height = p.height as number;
  const steps = p.steps as number;
  if (
    request.model !== IMAGE_MODEL ||
    request.action !== 'generate' ||
    extra.length > 0 ||
    p.n_samples !== 1 ||
    !Number.isInteger(width) || !Number.isInteger(height) || width * height > MAX_PIXELS ||
    !Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS
  ) {
    throw new Error(`Image request outside the Opus free limits was blocked (extra keys: ${extra.join(', ') || 'none'})`);
  }
}

/** Throws ImageQuotaError unless this is an active Opus account with V5 allowance left. */
export function checkAllowance(subscription: unknown): Allowance {
  const s = subscription as {
    tier?: unknown;
    active?: unknown;
    usage?: { percent?: unknown; isNegative?: unknown; timeUntilNextPercent?: unknown };
    trainingStepsLeft?: { fixedTrainingStepsLeft?: unknown; purchasedTrainingSteps?: unknown };
  } | null;
  if (!s || typeof s !== 'object') throw new ImageQuotaError('unverifiable', 'Subscription response was empty');
  if (s.active !== true || s.tier !== OPUS_TIER) throw new ImageQuotaError('not_opus', 'No active Opus subscription');

  const usage = s.usage;
  const percent = usage?.percent;
  const secondsPerPercent = usage?.timeUntilNextPercent;
  if (typeof percent !== 'number' || !Number.isInteger(percent) || typeof usage?.isNegative !== 'boolean') {
    throw new ImageQuotaError('unverifiable', 'V5 usage could not be read');
  }
  const perPercent = typeof secondsPerPercent === 'number' && secondsPerPercent > 0 ? secondsPerPercent : 0;
  if (usage.isNegative || percent < MIN_REMAINING_PERCENT) {
    const missing = MIN_REMAINING_PERCENT - (usage.isNegative ? -Math.abs(percent) : percent);
    throw new ImageQuotaError('low', `V5 allowance is at ${percent}%`, perPercent ? missing * perPercent : undefined);
  }

  const steps = s.trainingStepsLeft;
  const fixed = typeof steps?.fixedTrainingStepsLeft === 'number' ? steps.fixedTrainingStepsLeft : NaN;
  const purchased = typeof steps?.purchasedTrainingSteps === 'number' ? steps.purchasedTrainingSteps : NaN;
  return { percent, secondsPerPercent: perPercent, anlas: fixed + purchased };
}

export function extractPng(zip: Uint8Array): Buffer {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch {
    throw new NovelAIError('server', 'NovelAI image response was not a zip archive');
  }
  const pngs = Object.entries(files).filter(([name]) => name.toLowerCase().endsWith('.png'));
  if (pngs.length !== 1) throw new NovelAIError('server', `Expected one PNG in the response, found ${pngs.length}`);
  return Buffer.from(pngs[0]![1]);
}

export interface ImageResult {
  png: Buffer;
  seed: number;
  width: number;
  height: number;
  /** Anlas spent according to the balance before and after; should always be 0. */
  anlasSpent: number;
  percentAfter: number | null;
}

/** NovelAI image client that only ever sends Anlas-free V5 Full requests. */
export class NovelAIImageClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly retryDelayMs = 3_000,
    private readonly concurrencyRetries = 4,
  ) {}

  async getAllowance(): Promise<Allowance> {
    let response: Response;
    try {
      response = await this.fetchImpl(SUBSCRIPTION_URL, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ImageQuotaError('unverifiable', 'Could not reach NovelAI to check the V5 allowance');
    }
    if (response.status === 401 || response.status === 403) {
      throw new NovelAIError('auth', `Subscription check returned ${response.status}`, response.status);
    }
    if (!response.ok) throw new ImageQuotaError('unverifiable', `Subscription check returned ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ImageQuotaError('unverifiable', 'Subscription response was not JSON');
    }
    return checkAllowance(body);
  }

  /** Checks the allowance, then generates. Callers must serialize calls (one generation at a time). */
  async generate(prompt: ImagePrompt, orientation: ImageOrientation, seed: number): Promise<ImageResult> {
    const before = await this.getAllowance();
    const request = buildImageRequest(prompt, orientation, seed);
    assertFreeRequest(request);

    let response: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await this.fetchImpl(GENERATE_IMAGE_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(180_000),
        });
      } catch (err) {
        if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
          throw new NovelAIError('timeout', 'Image generation timed out');
        }
        throw new NovelAIError('network', `Could not reach NovelAI: ${err instanceof Error ? err.message : err}`);
      }
      // 429 "Concurrent generation is locked": another generation on the account is still
      // finishing (often the text request that wrote the prompt). Nothing is charged; wait and retry.
      if (response.status !== 429 || attempt >= this.concurrencyRetries) break;
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * (attempt + 1)));
    }
    if (!response.ok) {
      const text = await response.text();
      const kind = response.status === 401 || response.status === 402 || response.status === 403 ? 'auth'
        : response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'server' : 'bad_request';
      throw new NovelAIError(kind, `Image generation returned ${response.status}: ${text.slice(0, 500)}`, response.status);
    }
    const png = extractPng(new Uint8Array(await response.arrayBuffer()));

    let anlasSpent = 0;
    let percentAfter: number | null = null;
    try {
      const after = await this.getAllowance();
      percentAfter = after.percent;
      if (Number.isFinite(before.anlas) && Number.isFinite(after.anlas)) anlasSpent = Math.max(0, before.anlas - after.anlas);
    } catch (err) {
      // The image is already made; a low allowance afterwards only matters for the next request.
      if (err instanceof ImageQuotaError && err.reason === 'low') percentAfter = 0;
    }
    const { width, height } = IMAGE_SIZES[orientation];
    return { png, seed, width, height, anlasSpent, percentAfter };
  }
}
