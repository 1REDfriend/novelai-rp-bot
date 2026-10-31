import { ImageQuotaError } from './image.js';
import { NovelAIError } from './novelai.js';
import { RoleplayError } from './roleplay.js';

/** All user-facing bot text lives here so it can be edited or translated in one place. */
export const messages = {
  commands: {
    start: 'Bind this channel to a character and start a new story',
    startCharacter: 'Character file name (see /characters)',
    chat: 'Plain assistant chat with GLM-4.6 in this channel (no character)',
    builder: 'Chat with the AI to create a new character or edit one',
    builderCharacter: 'Character to edit (leave empty to create a new one)',
    save: 'Save the latest character file the builder wrote',
    saveFile: 'File name without .yaml (default: the edited file, or made from the name)',
    saveOverwrite: 'Allow replacing a different existing character file',
    regen: "Regenerate the character's latest reply",
    undo: 'Remove the latest message pair from the history',
    reset: 'Clear this channel\'s history and start the story over',
    clearAll: 'Delete every message in this channel and clear its history',
    clearAllConfirm: 'Set to True to delete everything. This cannot be undone',
    note: "Change the Author's Note for this scene (in /chat: extra instructions)",
    noteText: "New Author's Note. Leave empty to restore the character's default",
    characters: 'List available characters',
    image: 'Draw the current scene, or in /builder the character being made (NovelAI V5 Full)',
    imageDirection: 'What the picture should show, in your own words (roleplay channels only)',
    imageOrientation: 'Image shape (default: portrait)',
    imageNewSeed: 'Pick a new random seed for this channel (changes the art style)',
  },

  started: (name: string) => `This channel is now bound to **${name}**. Previous history was cleared.`,
  reset: (name: string) => `History cleared. Starting over with **${name}**.`,
  chatStarted:
    'This channel is now an **assistant chat** (GLM-4.6, no character). Previous history was cleared. Just type to ask anything. Use `/start` to go back to roleplay.',
  chatReset: 'Chat history cleared. Ask anything.',
  clearAllNotConfirmed: 'Nothing was deleted. Run `/clear-all confirm: True` to delete every message in this channel.',
  clearAllWorking: 'Deleting every message in this channel...',
  clearAllNoPermission:
    'The bot needs the **Manage Messages** and **Read Message History** permissions in this channel to delete messages.',
  clearAllDone: (deleted: number, skipped: number) =>
    `Deleted ${deleted} message${deleted === 1 ? '' : 's'} and cleared the history.` +
    (skipped ? ` ${skipped} could not be deleted.` : ''),
  builderStarted: (name: string | null, id: string | null) =>
    name && id
      ? `This channel is now a **character builder** editing **${name}** (\`${id}.yaml\`). Previous history was cleared. Tell me what to change; when the file looks right, use \`/save\`.`
      : 'This channel is now a **character builder**. Previous history was cleared. Describe the character you want (or ask me to invent one); when the file looks right, use `/save`.',
  builderSaved: (id: string, name: string, backupPath: string | null) =>
    `Saved **${name}** to \`characters/${id}.yaml\`.` +
    (backupPath ? ` The previous version was kept as \`${id}.yaml.bak\`.` : '') +
    ` Play it with \`/start ${id}\` in any channel. Keep chatting here to make more changes.`,
  undone: (count: number) => `Removed ${count} message${count === 1 ? '' : 's'} from the history.`,
  regenerating: 'Regenerating...',
  noteSet: (note: string) => `Note for this channel set to:\n> ${note}`,
  noteCleared: 'Note cleared; back to the default.',
  noCharacters: 'No characters found. Add a .yaml file to the characters folder.',
  characterList: (lines: string[]) => `**Available characters**\n${lines.join('\n')}`,
  characterLoadErrors: (errors: string[]) => `\n\n**Files with errors (skipped)**\n${errors.map((e) => `- ${e}`).join('\n')}`,
  unexpected: 'Something went wrong. Check the bot console for details.',
  imageWritingPrompt: 'Writing the image prompt...',
  imageGenerating: 'Drawing the scene with V5 Full...',
  imageEmbedTitle: 'Image prompt',
  imageRequest: (direction: string) => `**Request:** ${direction}`,
  imageFooter: (seed: number, percent: number | null) =>
    `nai-diffusion-5-full · seed ${seed}${percent === null ? '' : ` · V5 allowance ${percent}%`}`,
  imageAnlasWarning: (spent: number) =>
    `**Warning:** the Anlas balance dropped by ${spent} during this image. Stop using /image and check your NovelAI account.`,
};

/** Turns an error into a short message that is safe to show in chat. */
export function describeError(err: unknown): string {
  if (err instanceof ImageQuotaError) {
    switch (err.reason) {
      case 'low':
        return `The free V5 allowance is used up (${err.message.replace(/^V5 allowance is at /, '')} left), so no image was made and no Anlas was spent.` +
          (err.waitSeconds ? ` It should allow images again in ${formatDuration(err.waitSeconds)}.` : '');
      case 'not_opus':
        return 'Images need an active Opus subscription. No image was made.';
      case 'unverifiable':
        return 'Could not check the free V5 allowance, so no image was made (to avoid spending Anlas). Try again later.';
    }
  }
  if (err instanceof RoleplayError) {
    switch (err.kind) {
      case 'not_bound':
        return 'This channel has no character yet. Use `/start` first.';
      case 'unknown_character':
        return `${err.message}. Use \`/characters\` to see what is available.`;
      case 'nothing_to_undo':
        return 'Nothing to undo.';
      case 'nothing_to_regen':
        return 'Nothing to regenerate yet. Send a message first.';
      case 'chat_mode':
        return 'This channel is in `/chat` mode, so `/image` is not available here. Use `/start` in a channel to roleplay, or `/builder` to preview a character.';
      case 'nothing_to_draw':
        return 'Nothing to draw yet. Ask the builder to show the full character file first, then run `/image`.';
      case 'no_image_tags':
        return `${err.message.replace(/ has no .*/, '')} has no \`Image tags (name): ...\` line yet, so there is no look to draw. Ask the builder to add one.`;
      case 'not_builder':
        return '`/save` only works in a `/builder` channel.';
      case 'nothing_to_save':
        return 'There is no complete character file in this chat yet. Ask the builder to show the full file first.';
      case 'needs_file_name':
        return `Could not pick a file name (${err.message}). Run \`/save file:<name>\` with English letters, digits, - or _.`;
      case 'file_exists':
        return `\`${err.message.replace(/ already exists$/, '')}\` already belongs to another character. Use \`/save file:<other name>\`, or \`/save overwrite:True\` to replace it (the old file is kept as .bak).`;
      case 'invalid_character':
        return `The file has a problem, so nothing was saved or drawn: ${err.message}. Ask the builder to fix it, then \`/save\` again.`;
      case 'image_prompt_failed':
        return 'The AI could not write a usable image prompt (tried 3 times). Run `/image` again; if it keeps failing, send one more chat message first so the scene is clearer.';
    }
  }
  if (err instanceof NovelAIError) {
    switch (err.kind) {
      case 'auth':
        return 'NovelAI rejected the token. Check NOVELAI_TOKEN in .env and that your subscription is active.';
      case 'rate_limit':
        return 'NovelAI is rate limiting requests. Wait a moment, then use `/regen`.';
      case 'server':
        return 'NovelAI is having server problems. Try `/regen` in a little while.';
      case 'timeout':
        return 'NovelAI took too long to respond. Try `/regen`.';
      case 'network':
        return 'Could not reach NovelAI. Check the internet connection, then try `/regen`.';
      case 'empty':
        return 'The AI returned an empty reply. Try `/regen`.';
      case 'bad_request':
        return 'NovelAI rejected the request (check the bot console). Try `/regen`, or `/undo` if it keeps failing.';
    }
  }
  return messages.unexpected;
}

/** "2 h 11 min", "45 min", "under a minute". */
export function formatDuration(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 1) return 'under a minute';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
