import { afterEach, describe, expect, it } from 'vitest';
import { envValue, loadConfig } from '../src/config.js';

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

describe('envValue', () => {
  it('treats empty values and your- placeholders as unset', () => {
    const env = { A: '', B: '  ', C: 'your-max_output_tokens', D: 'YOUR-thing', E: ' 300 ' };
    expect(envValue('A', env)).toBeUndefined();
    expect(envValue('B', env)).toBeUndefined();
    expect(envValue('C', env)).toBeUndefined();
    expect(envValue('D', env)).toBeUndefined();
    expect(envValue('E', env)).toBe('300');
    expect(envValue('MISSING', env)).toBeUndefined();
  });
});

describe('loadConfig', () => {
  it('falls back to defaults for every placeholder copied from .env.example', () => {
    Object.assign(process.env, {
      DISCORD_TOKEN: 'discord-real',
      NOVELAI_TOKEN: 'pst-real',
      DISCORD_GUILD_ID: 'your-discord_guild_id',
      NOVELAI_TEXT_URL: 'your-novelai_text_url',
      NOVELAI_TEXT_MODEL: 'your-novelai_text_model',
      MAX_OUTPUT_TOKENS: 'your-max_output_tokens',
      MAX_CONTEXT_TOKENS: 'your-max_context_tokens',
      TEMPERATURE: 'your-temperature',
      TOP_P: 'your-top_p',
      LOREBOOK_SCAN_DEPTH: 'your-lorebook_scan_depth',
      AUTHORS_NOTE_DEPTH: 'your-authors_note_depth',
      CHARACTERS_DIR: 'your-characters_dir',
      DATABASE_PATH: 'your-database_path',
    });
    expect(loadConfig()).toEqual({
      discordToken: 'discord-real',
      discordGuildId: undefined,
      novelaiToken: 'pst-real',
      textUrl: 'https://text.novelai.net/oa/v1/completions',
      textModel: 'glm-4-6',
      chatUrl: 'https://text.novelai.net/oa/v1/chat/completions',
      chatMaxOutputTokens: 1500,
      builderMaxOutputTokens: 3000,
      builderMaxContextTokens: 16000,
      maxOutputTokens: 500,
      maxContextTokens: 8000,
      temperature: 0.7,
      topP: 0.95,
      lorebookScanDepth: 4,
      authorsNoteDepth: 1,
      charactersDir: 'characters',
      databasePath: 'data/bot.db',
    });
  });

  it('still requires real tokens', () => {
    Object.assign(process.env, { DISCORD_TOKEN: 'your-discord_token', NOVELAI_TOKEN: 'pst-real' });
    expect(() => loadConfig()).toThrow(/DISCORD_TOKEN/);
  });
});
