import 'dotenv/config';

export interface Config {
  discordToken: string;
  discordGuildId: string | undefined;
  novelaiToken: string;
  textUrl: string;
  textModel: string;
  chatUrl: string;
  chatMaxOutputTokens: number;
  builderMaxOutputTokens: number;
  builderMaxContextTokens: number;
  /** Rules added next to every roleplay Author's Note; "{{char}}" is the character's name. Empty when off. */
  storyDirective: string;
  maxOutputTokens: number;
  maxContextTokens: number;
  temperature: number;
  topP: number;
  lorebookScanDepth: number;
  authorsNoteDepth: number;
  charactersDir: string;
  databasePath: string;
}

/**
 * Reads an environment variable. Empty values and the "your-..." placeholders
 * from .env.example count as unset, so the built-in default applies.
 */
export function envValue(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name]?.trim();
  if (!value || value.toLowerCase().startsWith('your-')) return undefined;
  return value;
}

function required(name: string): string {
  const value = envValue(name);
  if (!value) {
    throw new Error(`Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return envValue(name) ?? fallback;
}

export const DEFAULT_STORY_DIRECTIVE =
  "[ Story rules: {{char}} has a mind of their own: every reply adds at least one idea, decision or action of {{char}}'s own that moves the scene forward. " +
  'When the user says they do something, write its obvious result and carry on (the user asks for a piggyback: {{char}} crouches, the user climbs on, and they set off); ' +
  "do not stop to ask permission again. Never invent the user's words or new decisions. Never repeat earlier lines; end each reply differently. " +
  'Keep bodies and positions physically believable and consistent with the last turn; when something goes wrong mid-action (slipping, tripping, dropping something), ' +
  '{{char}} reacts the way a real person would (hitches them back up, holds on tighter, or sets them down safely). ]';

/** STORY_DIRECTIVE: unset uses the default, "off" turns it off. */
function storyDirectiveSetting(): string {
  const value = optional('STORY_DIRECTIVE', DEFAULT_STORY_DIRECTIVE);
  return value.toLowerCase() === 'off' ? '' : value;
}

function number(name: string, fallback: number): number {
  const raw = envValue(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}".`);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    discordToken: required('DISCORD_TOKEN'),
    discordGuildId: envValue('DISCORD_GUILD_ID'),
    novelaiToken: required('NOVELAI_TOKEN'),
    textUrl: optional('NOVELAI_TEXT_URL', 'https://text.novelai.net/oa/v1/completions'),
    textModel: optional('NOVELAI_TEXT_MODEL', 'glm-4-6'),
    chatUrl: optional('NOVELAI_CHAT_URL', 'https://text.novelai.net/oa/v1/chat/completions'),
    chatMaxOutputTokens: number('CHAT_MAX_OUTPUT_TOKENS', 1500),
    builderMaxOutputTokens: number('BUILDER_MAX_OUTPUT_TOKENS', 3000),
    builderMaxContextTokens: number('BUILDER_MAX_CONTEXT_TOKENS', 16000),
    storyDirective: storyDirectiveSetting(),
    maxOutputTokens: number('MAX_OUTPUT_TOKENS', 500),
    maxContextTokens: number('MAX_CONTEXT_TOKENS', 8000),
    temperature: number('TEMPERATURE', 0.7),
    topP: number('TOP_P', 0.95),
    lorebookScanDepth: number('LOREBOOK_SCAN_DEPTH', 4),
    authorsNoteDepth: number('AUTHORS_NOTE_DEPTH', 1),
    charactersDir: optional('CHARACTERS_DIR', 'characters'),
    databasePath: optional('DATABASE_PATH', 'data/bot.db'),
  };
}
