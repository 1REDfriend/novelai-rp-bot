import { readFileSync } from 'node:fs';
import {
  BUILDER_ASSISTANT_NAME,
  builderModeId,
  builderSystemPrompt,
  editedCharacterId,
  fileIdFromName,
  isValidFileId,
  latestYamlBlock,
} from './builder.js';
import {
  type Character,
  findCharacterFile,
  imageTagsByName,
  type LoadResult,
  parseCharacter,
  saveCharacterFile,
} from './characters.js';
import { buildChatMessages, CHAT_ASSISTANT_NAME, CHAT_MODE_ID, CHAT_SYSTEM_PROMPT, type NovelAIChatClient } from './chat.js';
import type { Config } from './config.js';
import { buildPrompt } from './context.js';
import type { HistoryStore, StoredMessage } from './history.js';
import type { ImagePrompt } from './image.js';
import { applyImageTags, IMAGE_PROMPT_PREFILL, IMAGE_PROMPT_RULES, IMAGE_PROMPT_STOP, parseImagePrompt } from './imagePrompt.js';
import { NovelAIError, type NovelAITextClient } from './novelai.js';
import { cleanReply, stopSequences, trimIncomplete } from './reply.js';

export class RoleplayError extends Error {
  constructor(
    readonly kind:
      | 'not_bound'
      | 'unknown_character'
      | 'nothing_to_undo'
      | 'nothing_to_regen'
      | 'image_prompt_failed'
      | 'chat_mode'
      | 'not_builder'
      | 'nothing_to_save'
      | 'needs_file_name'
      | 'file_exists'
      | 'invalid_character'
      | 'nothing_to_draw'
      | 'no_image_tags',
    message: string,
  ) {
    super(message);
    this.name = 'RoleplayError';
  }
}

export interface GeneratedReply {
  /** Null in assistant chat mode. */
  character: Character | null;
  text: string;
  /** History row id, so the caller can attach the Discord message ids. */
  messageId: number;
}

export type ConfigSubset = Pick<
  Config,
  | 'maxOutputTokens'
  | 'maxContextTokens'
  | 'temperature'
  | 'topP'
  | 'lorebookScanDepth'
  | 'authorsNoteDepth'
  | 'chatMaxOutputTokens'
  | 'builderMaxOutputTokens'
  | 'builderMaxContextTokens'
>;

export type ChannelMode = 'roleplay' | 'chat' | 'builder';

export interface SavedCharacter {
  id: string;
  name: string;
  /** Copy of the previous version when an existing file was overwritten. */
  backupPath: string | null;
}

/** Chat logic independent of Discord: binding, history edits and reply generation. */
export class RoleplayService {
  constructor(
    private readonly config: ConfigSubset,
    private readonly store: HistoryStore,
    private readonly text: Pick<NovelAITextClient, 'complete'>,
    private readonly loadCharacters: () => LoadResult,
    private readonly chat?: Pick<NovelAIChatClient, 'chat'>,
    /** Needed by builder mode to read and save character files. */
    private readonly charactersDir?: string,
  ) {}

  listCharacters(): LoadResult {
    return this.loadCharacters();
  }

  isBound(channelId: string): boolean {
    return this.store.getBinding(channelId) !== null;
  }

  /** Binds the channel to a character, wipes history and stores the greeting. */
  start(channelId: string, characterId: string): { character: Character; messageId: number } {
    const character = this.loadCharacters().characters.get(characterId.toLowerCase());
    if (!character) throw new RoleplayError('unknown_character', `No character named "${characterId}"`);
    this.store.bind(channelId, character.id);
    const messageId = this.store.addMessage(channelId, {
      role: 'character',
      author: character.name,
      content: character.greeting,
    });
    return { character, messageId };
  }

  /** Puts the channel in plain assistant chat mode (no character) with a fresh history. */
  startChat(channelId: string): void {
    this.store.bind(channelId, CHAT_MODE_ID);
  }

  isChat(channelId: string): boolean {
    return this.store.getBinding(channelId)?.characterId === CHAT_MODE_ID;
  }

  /** Null when the channel is not bound. */
  mode(channelId: string): ChannelMode | null {
    const binding = this.store.getBinding(channelId);
    if (!binding) return null;
    if (binding.characterId === CHAT_MODE_ID) return 'chat';
    if (editedCharacterId(binding.characterId) !== undefined) return 'builder';
    return 'roleplay';
  }

  /**
   * Puts the channel in character builder mode with a fresh history: editing
   * an existing character when an id is given, otherwise creating a new one.
   */
  startBuilder(channelId: string, characterId?: string | null): { character: Character | null } {
    let character: Character | null = null;
    if (characterId) {
      character = this.loadCharacters().characters.get(characterId.toLowerCase()) ?? null;
      if (!character) throw new RoleplayError('unknown_character', `No character named "${characterId}"`);
    }
    this.store.bind(channelId, builderModeId(character?.id));
    return { character };
  }

  /**
   * Saves the latest yaml block the builder wrote. The file name comes from
   * `fileName`, else the edited character, else the character's name. A new
   * character never replaces another file unless `overwrite` is set. After a
   * save the channel keeps editing the saved file.
   */
  saveCharacter(channelId: string, fileName?: string | null, overwrite = false): SavedCharacter {
    const binding = this.requireBinding(channelId);
    const editing = editedCharacterId(binding.characterId);
    if (editing === undefined) throw new RoleplayError('not_builder', 'This channel is not in builder mode');
    if (!this.charactersDir) throw new Error('Builder mode needs the characters folder');

    const source = this.latestDraft(channelId);
    if (!source) throw new RoleplayError('nothing_to_save', 'No complete yaml block in the builder replies');

    let character: Character;
    try {
      character = parseCharacter('draft', source, 'the file');
    } catch (err) {
      throw new RoleplayError('invalid_character', err instanceof Error ? err.message : String(err));
    }

    // A Thai-only name gives no file id, so fall back to an English lorebook key such as "Elera".
    const fromKeys = character.lorebook
      .filter((e) => e.alwaysOn)
      .flatMap((e) => e.keys)
      .map(fileIdFromName)
      .find(Boolean);
    const id =
      fileName?.trim().toLowerCase().replace(/\.ya?ml$/, '') || editing || fileIdFromName(character.name) || fromKeys || '';
    if (!isValidFileId(id)) {
      throw new RoleplayError('needs_file_name', id ? `"${id}" is not a valid file name` : 'The name has no English letters');
    }
    if (id !== editing && !overwrite && findCharacterFile(this.charactersDir, id)) {
      throw new RoleplayError('file_exists', `${id}.yaml already exists`);
    }

    const { backupPath } = saveCharacterFile(this.charactersDir, id, source);
    this.store.setCharacterId(channelId, builderModeId(id));
    return { id, name: character.name, backupPath };
  }

  /**
   * Image prompt for a builder channel: the character standing alone on a
   * plain background, drawn from the Image tags of the latest draft the
   * builder wrote (no /save needed), or of the edited file when there is no
   * draft yet. No text model call is involved.
   */
  builderPortrait(channelId: string): ImagePrompt {
    const editing = editedCharacterId(this.requireBinding(channelId).characterId);
    if (editing === undefined) throw new RoleplayError('not_builder', 'This channel is not in builder mode');

    const draft = this.latestDraft(channelId);
    let character: Character | undefined;
    if (draft) {
      try {
        character = parseCharacter('draft', draft, 'the draft');
      } catch (err) {
        throw new RoleplayError('invalid_character', err instanceof Error ? err.message : String(err));
      }
    } else if (editing) {
      character = this.loadCharacters().characters.get(editing);
    }
    if (!character) throw new RoleplayError('nothing_to_draw', 'No draft or edited file to draw');

    const allTags = imageTagsByName(character);
    const tags = allTags.get(character.name.toLowerCase()) ?? [...allTags.values()][0];
    if (!tags) throw new RoleplayError('no_image_tags', `${character.name} has no "Image tags (...)" line`);
    const count = tags.split(',')[0]!.trim();
    const main = [
      /^(\d+(girl|boy|other)s?|no humans)$/i.test(count) ? count : '',
      'solo, simple background, white background, cowboy shot, standing, looking at viewer, neutral expression',
    ]
      .filter(Boolean)
      .join(', ');
    return { main, characters: [{ name: character.name, tags }] };
  }

  /** The last complete yaml block the builder wrote in this channel. */
  private latestDraft(channelId: string): string | undefined {
    return this.store
      .getMessages(channelId)
      .filter((m) => m.role === 'character')
      .map((m) => latestYamlBlock(m.content))
      .filter((block): block is string => block !== null)
      .at(-1);
  }

  /**
   * Clears history and the /note override, then stores the greeting again.
   * In chat and builder mode there is no greeting, so both fields are null.
   */
  reset(channelId: string): { character: Character | null; messageId: number | null } {
    this.requireBinding(channelId);
    this.store.clear(channelId);
    this.store.setNoteOverride(channelId, null);
    if (this.mode(channelId) !== 'roleplay') return { character: null, messageId: null };
    const character = this.boundCharacter(channelId);
    const messageId = this.store.addMessage(channelId, {
      role: 'character',
      author: character.name,
      content: character.greeting,
    });
    return { character, messageId };
  }

  /** In roleplay this replaces the Author's Note; in chat mode it adds to the system prompt. */
  setNote(channelId: string, note: string | null): void {
    this.requireBinding(channelId);
    this.store.setNoteOverride(channelId, note?.trim() || null);
  }

  /** Stores the user's message, then generates the character's reply. */
  async reply(channelId: string, author: string, content: string): Promise<GeneratedReply> {
    if (this.mode(channelId) === 'roleplay') this.boundCharacter(channelId);
    else this.requireBinding(channelId);
    this.store.addMessage(channelId, { role: 'user', author, content });
    return this.generate(channelId);
  }

  /**
   * Drops the latest character reply (if it answers a user message) and writes
   * a new one. Also works when the last generation failed and the history ends
   * with a user message.
   */
  async regen(channelId: string): Promise<GeneratedReply & { removedDiscordIds: string[] }> {
    this.requireBinding(channelId);
    const messages = this.store.getMessages(channelId);
    const last = messages.at(-1);
    let removedDiscordIds: string[] = [];
    if (last?.role === 'character') {
      if (!messages.slice(0, -1).some((m) => m.role === 'user')) {
        throw new RoleplayError('nothing_to_regen', 'Only the greeting is in the history');
      }
      this.store.deleteMessages([last.id]);
      removedDiscordIds = last.discordMessageIds;
    } else if (!last) {
      throw new RoleplayError('nothing_to_regen', 'History is empty');
    }
    const reply = await this.generate(channelId);
    return { ...reply, removedDiscordIds };
  }

  /** Removes the latest user message and the character reply after it. Never removes the greeting. */
  undo(channelId: string): { removed: StoredMessage[] } {
    this.requireBinding(channelId);
    const messages = this.store.getMessages(channelId);
    let end = messages.length;
    const removed: StoredMessage[] = [];
    if (messages[end - 1]?.role === 'character') {
      removed.push(messages[--end]!);
    }
    if (messages[end - 1]?.role === 'user') {
      removed.push(messages[--end]!);
    } else {
      throw new RoleplayError('nothing_to_undo', 'No user message to undo');
    }
    this.store.deleteMessages(removed.map((m) => m.id));
    return { removed };
  }

  /**
   * Asks the model for an image prompt of the current scene. Uses the channel's
   * context plus the image-prompt rules; nothing is written to the history.
   * Retries once when the output cannot be parsed. Each character's lorebook
   * Image tags are then locked in, so their look stays the same across images.
   */
  async writeImagePrompt(channelId: string): Promise<ImagePrompt> {
    const character = this.boundCharacter(channelId);
    const history = this.store.getMessages(channelId);
    const maxTokens = 400;
    const { prompt } = buildPrompt({
      character,
      history,
      // The chat Author's Note asks for paragraphs of story, which fights the tag format.
      authorsNote: '',
      scanDepth: this.config.lorebookScanDepth,
      noteDepth: this.config.authorsNoteDepth,
      maxPromptTokens: this.config.maxContextTokens - maxTokens,
      extraEntries: [IMAGE_PROMPT_RULES],
      prefill: IMAGE_PROMPT_PREFILL,
    });
    const attempts = 3;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const result = await this.text.complete({
        prompt,
        maxTokens,
        stop: [IMAGE_PROMPT_STOP],
        temperature: Math.min(this.config.temperature, 0.7),
        topP: this.config.topP,
      });
      const parsed = parseImagePrompt(result.text);
      if (parsed) return applyImageTags(parsed, imageTagsByName(character));
      console.warn(`Unusable image prompt (attempt ${attempt}/${attempts}):\n${result.text}`);
    }
    throw new RoleplayError('image_prompt_failed', `The model did not write a usable image prompt in ${attempts} attempts`);
  }

  /**
   * The channel's image seed. A new random one is made (and kept) on the first
   * /image of a story, or when `fresh` is true.
   */
  imageSeed(channelId: string, fresh = false): number {
    if (this.mode(channelId) !== 'builder') this.boundCharacter(channelId);
    const current = this.store.getImageSeed(channelId);
    if (current !== null && !fresh) return current;
    const seed = Math.floor(Math.random() * 4_294_967_295);
    this.store.setImageSeed(channelId, seed);
    return seed;
  }

  attachDiscordIds(messageId: number, discordIds: string[]): void {
    this.store.setDiscordMessageIds(messageId, discordIds);
  }

  private requireBinding(channelId: string) {
    const binding = this.store.getBinding(channelId);
    if (!binding) throw new RoleplayError('not_bound', 'Channel is not bound to a character');
    return binding;
  }

  private boundCharacter(channelId: string): Character {
    const binding = this.requireBinding(channelId);
    if (binding.characterId.startsWith(':')) {
      throw new RoleplayError('chat_mode', 'This channel is in /chat or /builder mode');
    }
    const character = this.loadCharacters().characters.get(binding.characterId);
    if (!character) {
      throw new RoleplayError('unknown_character', `Character file "${binding.characterId}" is missing or invalid`);
    }
    return character;
  }

  private async generate(channelId: string): Promise<GeneratedReply> {
    const mode = this.mode(channelId);
    if (mode === 'chat') {
      return this.generateChat(channelId, CHAT_SYSTEM_PROMPT, CHAT_ASSISTANT_NAME, this.config.chatMaxOutputTokens, this.config.maxContextTokens);
    }
    if (mode === 'builder') {
      return this.generateChat(
        channelId,
        builderSystemPrompt(this.editedSource(channelId)),
        BUILDER_ASSISTANT_NAME,
        this.config.builderMaxOutputTokens,
        this.config.builderMaxContextTokens,
      );
    }
    const character = this.boundCharacter(channelId);
    const binding = this.store.getBinding(channelId)!;
    const history = this.store.getMessages(channelId);

    // Most recent speakers first, so the stop-sequence limit keeps the active ones.
    const userNames = [...new Set(history.filter((m) => m.role === 'user').map((m) => m.author).reverse())];

    const { prompt } = buildPrompt({
      character,
      history,
      authorsNote: binding.noteOverride ?? character.authorsNote,
      scanDepth: this.config.lorebookScanDepth,
      noteDepth: this.config.authorsNoteDepth,
      maxPromptTokens: this.config.maxContextTokens - this.config.maxOutputTokens,
    });

    const request = {
      prompt,
      maxTokens: this.config.maxOutputTokens,
      stop: stopSequences(userNames),
      temperature: this.config.temperature,
      topP: this.config.topP,
    };

    // One retry when the model only produced lines for the user.
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.text.complete(request);
      let text = cleanReply(result.text, character.name, userNames);
      if (result.finishReason === 'length') text = trimIncomplete(text);
      if (text) {
        const messageId = this.store.addMessage(channelId, { role: 'character', author: character.name, content: text });
        return { character, text, messageId };
      }
    }
    throw new NovelAIError('empty', 'The model returned an empty reply twice');
  }

  /** The file being edited in builder mode, read fresh so saved changes show up. */
  private editedSource(channelId: string): { id: string; source: string } | null {
    const id = editedCharacterId(this.requireBinding(channelId).characterId);
    if (!id || !this.charactersDir) return null;
    const path = findCharacterFile(this.charactersDir, id);
    return path ? { id, source: readFileSync(path, 'utf8') } : null;
  }

  private async generateChat(
    channelId: string,
    systemPrompt: string,
    assistantName: string,
    maxTokens: number,
    maxContextTokens: number,
  ): Promise<GeneratedReply> {
    if (!this.chat) throw new Error('Chat mode needs a chat client');
    const binding = this.requireBinding(channelId);
    const messages = buildChatMessages(
      this.store.getMessages(channelId),
      binding.noteOverride,
      maxContextTokens - maxTokens,
      systemPrompt,
    );
    const result = await this.chat.chat({ messages, maxTokens, temperature: this.config.temperature, topP: this.config.topP });
    const text = result.finishReason === 'length' ? trimIncomplete(result.text) : result.text.trim();
    if (!text) throw new NovelAIError('empty', 'The model returned an empty chat reply');
    const messageId = this.store.addMessage(channelId, { role: 'character', author: assistantName, content: text });
    return { character: null, text, messageId };
  }
}
