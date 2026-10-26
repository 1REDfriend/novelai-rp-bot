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
    maxOutputTokens: number('MAX_OUTPUT_TOKENS', 300),
    maxContextTokens: number('MAX_CONTEXT_TOKENS', 8000),
    temperature: number('TEMPERATURE', 0.7),
    topP: number('TOP_P', 0.95),
    lorebookScanDepth: number('LOREBOOK_SCAN_DEPTH', 4),
    authorsNoteDepth: number('AUTHORS_NOTE_DEPTH', 1),
    charactersDir: optional('CHARACTERS_DIR', 'characters'),
    databasePath: optional('DATABASE_PATH', 'data/bot.db'),
  };
}
