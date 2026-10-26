import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ChatMessage } from './context.js';

export interface ChannelBinding {
  channelId: string;
  characterId: string;
  /** Temporary Author's Note set with /note; null means use the character's default. */
  noteOverride: string | null;
}

export interface StoredMessage extends ChatMessage {
  id: number;
  /** Discord message ids that display this message (character replies may span several). */
  discordMessageIds: string[];
}

interface MessageRow {
  id: number;
  role: 'user' | 'character';
  author: string;
  content: string;
  discord_message_ids: string;
}

/** Per-channel character binding and chat history, persisted in SQLite. */
export class HistoryStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS channels (
        channel_id    TEXT PRIMARY KEY,
        character_id  TEXT NOT NULL,
        note_override TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id          TEXT NOT NULL,
        role                TEXT NOT NULL CHECK (role IN ('user', 'character')),
        author              TEXT NOT NULL,
        content             TEXT NOT NULL,
        discord_message_ids TEXT NOT NULL DEFAULT '[]',
        created_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS messages_by_channel ON messages (channel_id, id);
    `);
    // Added after the first release; older databases need the column.
    const columns = this.db.prepare('PRAGMA table_info(channels)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'image_seed')) {
      this.db.exec('ALTER TABLE channels ADD COLUMN image_seed INTEGER');
    }
  }

  getBinding(channelId: string): ChannelBinding | null {
    const row = this.db
      .prepare('SELECT channel_id, character_id, note_override FROM channels WHERE channel_id = ?')
      .get(channelId) as { channel_id: string; character_id: string; note_override: string | null } | undefined;
    if (!row) return null;
    return { channelId: row.channel_id, characterId: row.character_id, noteOverride: row.note_override };
  }

  /** Binds the channel to a character and starts a fresh history. */
  bind(channelId: string, characterId: string): void {
    this.db
      .prepare(
        `INSERT INTO channels (channel_id, character_id, note_override, image_seed) VALUES (?, ?, NULL, NULL)
         ON CONFLICT (channel_id) DO UPDATE SET character_id = excluded.character_id, note_override = NULL, image_seed = NULL`,
      )
      .run(channelId, characterId);
    this.clear(channelId);
  }

  /** Changes what the channel is bound to but keeps its history and note. */
  setCharacterId(channelId: string, characterId: string): void {
    this.db.prepare('UPDATE channels SET character_id = ? WHERE channel_id = ?').run(characterId, channelId);
  }

  /** Seed reused for every /image in the channel, so the art style stays steady. */
  getImageSeed(channelId: string): number | null {
    const row = this.db.prepare('SELECT image_seed FROM channels WHERE channel_id = ?').get(channelId) as
      | { image_seed: number | null }
      | undefined;
    return row?.image_seed ?? null;
  }

  setImageSeed(channelId: string, seed: number): void {
    this.db.prepare('UPDATE channels SET image_seed = ? WHERE channel_id = ?').run(seed, channelId);
  }

  setNoteOverride(channelId: string, note: string | null): void {
    this.db.prepare('UPDATE channels SET note_override = ? WHERE channel_id = ?').run(note, channelId);
  }

  addMessage(channelId: string, message: ChatMessage, discordMessageIds: string[] = []): number {
    const result = this.db
      .prepare('INSERT INTO messages (channel_id, role, author, content, discord_message_ids) VALUES (?, ?, ?, ?, ?)')
      .run(channelId, message.role, message.author, message.content, JSON.stringify(discordMessageIds));
    return Number(result.lastInsertRowid);
  }

  setDiscordMessageIds(messageId: number, discordMessageIds: string[]): void {
    this.db
      .prepare('UPDATE messages SET discord_message_ids = ? WHERE id = ?')
      .run(JSON.stringify(discordMessageIds), messageId);
  }

  getMessages(channelId: string): StoredMessage[] {
    const rows = this.db
      .prepare('SELECT id, role, author, content, discord_message_ids FROM messages WHERE channel_id = ? ORDER BY id')
      .all(channelId) as unknown as MessageRow[];
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      author: row.author,
      content: row.content,
      discordMessageIds: JSON.parse(row.discord_message_ids) as string[],
    }));
  }

  deleteMessages(ids: number[]): void {
    const stmt = this.db.prepare('DELETE FROM messages WHERE id = ?');
    for (const id of ids) stmt.run(id);
  }

  /** Clears the history but keeps the character binding. */
  clear(channelId: string): void {
    this.db.prepare('DELETE FROM messages WHERE channel_id = ?').run(channelId);
  }

  close(): void {
    this.db.close();
  }
}
