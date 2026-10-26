import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { parse } from 'yaml';

export interface LorebookEntry {
  keys: string[];
  text: string;
  alwaysOn: boolean;
}

export interface Character {
  /** File name without extension, used in /start. */
  id: string;
  name: string;
  memory: string;
  lorebook: LorebookEntry[];
  authorsNote: string;
  greeting: string;
}

function asString(value: unknown, field: string, file: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${file}: "${field}" must be a non-empty string`);
  }
  return value.trim();
}

function parseLorebook(value: unknown, file: string): LorebookEntry[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${file}: "lorebook" must be a list`);
  return value.map((raw, i) => {
    const entry = raw as Record<string, unknown>;
    const where = `lorebook[${i}]`;
    const keys = entry.keys ?? [];
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string')) {
      throw new Error(`${file}: ${where}.keys must be a list of strings`);
    }
    const alwaysOn = entry.always_on === true;
    if (!alwaysOn && keys.length === 0) {
      throw new Error(`${file}: ${where} needs keys or always_on: true`);
    }
    return {
      keys: keys.map((k: string) => k.trim()).filter(Boolean),
      text: asString(entry.text, `${where}.text`, file),
      alwaysOn,
    };
  });
}

/** An unquoted "[ ... ]" note is read by YAML as a list; reject it instead of silently dropping it. */
function parseAuthorsNote(value: unknown, file: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new Error(`${file}: "authors_note" must be text; put it in double quotes, e.g. authors_note: "[ ... ]"`);
  }
  return value.trim();
}

export function parseCharacter(id: string, source: string, file = id): Character {
  const data = parse(source) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') throw new Error(`${file}: file is empty or not a YAML mapping`);
  return {
    id,
    name: asString(data.name, 'name', file),
    memory: asString(data.memory, 'memory', file),
    lorebook: parseLorebook(data.lorebook, file),
    authorsNote: parseAuthorsNote(data.authors_note, file),
    greeting: asString(data.greeting, 'greeting', file),
  };
}

export interface LoadResult {
  characters: Map<string, Character>;
  /** One message per file that could not be loaded. Bad files are skipped. */
  errors: string[];
}

/**
 * Reads every .yaml/.yml file in the directory. Files are re-read on each call
 * so edits apply without restarting the bot.
 */
export function loadCharacters(dir: string): LoadResult {
  const characters = new Map<string, Character>();
  const errors: string[] = [];
  for (const fileName of readdirSync(dir)) {
    const ext = extname(fileName).toLowerCase();
    if (ext !== '.yaml' && ext !== '.yml') continue;
    const id = basename(fileName, ext).toLowerCase();
    const path = join(dir, fileName);
    try {
      characters.set(id, parseCharacter(id, readFileSync(path, 'utf8'), path));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { characters, errors };
}

const IMAGE_TAGS_LINE = /^\s*Image tags\s*\(([^)]+)\)\s*:\s*(.+?)\s*$/gim;

/**
 * Canonical appearance tags from every "Image tags (<name>): ..." line in the
 * lorebook, keyed by lowercase name. Used to lock how each character looks.
 */
export function imageTagsByName(character: Character): Map<string, string> {
  const tags = new Map<string, string>();
  for (const entry of character.lorebook) {
    for (const match of entry.text.matchAll(IMAGE_TAGS_LINE)) {
      tags.set(match[1]!.trim().toLowerCase(), match[2]!.trim());
    }
  }
  return tags;
}

/** Path of the file behind a character id (any .yaml/.yml casing), or null. */
export function findCharacterFile(dir: string, id: string): string | null {
  for (const fileName of readdirSync(dir)) {
    const ext = extname(fileName).toLowerCase();
    if ((ext === '.yaml' || ext === '.yml') && basename(fileName, extname(fileName)).toLowerCase() === id) {
      return join(dir, fileName);
    }
  }
  return null;
}

/**
 * Validates and writes a character file. An existing file is copied to
 * "<file>.bak" first (the loader skips .bak files).
 */
export function saveCharacterFile(dir: string, id: string, source: string): { path: string; backupPath: string | null } {
  parseCharacter(id, source, `${id}.yaml`);
  const path = findCharacterFile(dir, id) ?? join(dir, `${id}.yaml`);
  let backupPath: string | null = null;
  if (existsSync(path)) {
    backupPath = `${path}.bak`;
    copyFileSync(path, backupPath);
  }
  writeFileSync(path, source, 'utf8');
  return { path, backupPath };
}
