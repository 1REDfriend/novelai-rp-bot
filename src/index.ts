import {
  AttachmentBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  GuildMember,
  type GuildTextBasedChannel,
  type Message,
  MessageFlags,
  REST,
  RESTJSONErrorCodes,
  Routes,
  type SendableChannels,
  EmbedBuilder,
} from 'discord.js';
import { NovelAIChatClient } from './chat.js';
import { loadCharacters } from './characters.js';
import { type ClearableChannel, type ClearResult, clearChannel } from './clearChannel.js';
import { commandDefinitions } from './commands.js';
import { loadConfig } from './config.js';
import { HistoryStore } from './history.js';
import { type ImageOrientation, NovelAIImageClient } from './image.js';
import { formatImagePrompt } from './imagePrompt.js';
import { describeError, messages } from './messages.js';
import { NovelAITextClient } from './novelai.js';
import { KeyedQueue } from './queue.js';
import { splitForDiscord } from './reply.js';
import { RoleplayService } from './roleplay.js';

const config = loadConfig();
const store = new HistoryStore(config.databasePath);
const textClient = new NovelAITextClient({ url: config.textUrl, model: config.textModel, token: config.novelaiToken });
const chatClient = new NovelAIChatClient({ url: config.chatUrl, model: config.textModel, token: config.novelaiToken });
const service = new RoleplayService(
  config,
  store,
  textClient,
  () => loadCharacters(config.charactersDir),
  chatClient,
  config.charactersDir,
);
const imageClient = new NovelAIImageClient(config.novelaiToken);
const queue = new KeyedQueue();
/** NovelAI runs one image generation per account at a time, across all channels. */
const imageQueue = new KeyedQueue();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

/** Keeps the "typing..." indicator alive until the returned function is called. */
function startTyping(channel: SendableChannels): () => void {
  const tick = () => void channel.sendTyping().catch(() => undefined);
  tick();
  const timer = setInterval(tick, 8_000);
  return () => clearInterval(timer);
}

async function sendChunks(channel: SendableChannels, text: string): Promise<string[]> {
  const ids: string[] = [];
  for (const chunk of splitForDiscord(text)) {
    const sent = await channel.send({ content: chunk, allowedMentions: { parse: [] } });
    ids.push(sent.id);
  }
  return ids;
}

async function deleteMessages(channel: SendableChannels, ids: string[]): Promise<void> {
  if (!('messages' in channel)) return;
  for (const id of ids) {
    await channel.messages.delete(id).catch(() => undefined);
  }
}

function discordClearable(channel: GuildTextBasedChannel): ClearableChannel {
  return {
    fetchPage: async (before) => [...(await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) })).values()],
    bulkDelete: async (ids) => {
      await channel.bulkDelete(ids);
    },
    deleteOne: async (id) => {
      await channel.messages.delete(id);
    },
  };
}

async function sendableChannel(channelId: string): Promise<SendableChannels> {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isSendable()) throw new Error(`Channel ${channelId} is not a text channel the bot can send to`);
  return channel;
}

async function onMessage(message: Message): Promise<void> {
  if (message.author.bot || message.system || !message.content.trim()) return;
  if (!message.channel.isSendable()) return;
  if (!service.isBound(message.channelId)) return;

  const channel = message.channel;
  const author = message.member?.displayName ?? message.author.displayName;
  const content = message.content.trim();

  await queue.run(message.channelId, async () => {
    const stopTyping = startTyping(channel);
    try {
      const reply = await service.reply(message.channelId, author, content);
      stopTyping();
      service.attachDiscordIds(reply.messageId, await sendChunks(channel, reply.text));
    } catch (err) {
      stopTyping();
      console.error('Reply failed:', err);
      await channel.send(describeError(err)).catch(() => undefined);
    }
  });
}

async function onCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = interaction.channelId;

  if (interaction.commandName === 'characters') {
    const { characters, errors } = service.listCharacters();
    const lines = [...characters.values()].map((c) => `- \`${c.id}\` — ${c.name}`);
    let text = lines.length ? messages.characterList(lines) : messages.noCharacters;
    if (errors.length) text += messages.characterLoadErrors(errors);
    await interaction.reply({ content: text.slice(0, 2000), flags: MessageFlags.Ephemeral });
    return;
  }

  // /clear-all answers privately so its own reply is not one of the messages being deleted.
  const ephemeral = ['regen', 'undo', 'clear-all'].includes(interaction.commandName);
  await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});

  await queue.run(channelId, async () => {
    const channel = await sendableChannel(channelId);
    switch (interaction.commandName) {
      case 'start': {
        const { character, messageId } = service.start(channelId, interaction.options.getString('character', true));
        await interaction.editReply(messages.started(character.name));
        service.attachDiscordIds(messageId, await sendChunks(channel, character.greeting));
        break;
      }
      case 'chat': {
        service.startChat(channelId);
        await interaction.editReply(messages.chatStarted);
        break;
      }
      case 'builder': {
        const { character } = service.startBuilder(channelId, interaction.options.getString('character'));
        await interaction.editReply(messages.builderStarted(character?.name ?? null, character?.id ?? null));
        break;
      }
      case 'save': {
        const saved = service.saveCharacter(
          channelId,
          interaction.options.getString('file'),
          interaction.options.getBoolean('overwrite') ?? false,
        );
        await interaction.editReply(messages.builderSaved(saved.id, saved.name, saved.backupPath));
        break;
      }
      case 'reset': {
        const { character, messageId } = service.reset(channelId);
        if (!character || messageId === null) {
          await interaction.editReply(messages.chatReset);
          break;
        }
        await interaction.editReply(messages.reset(character.name));
        service.attachDiscordIds(messageId, await sendChunks(channel, character.greeting));
        break;
      }
      case 'clear-all': {
        if (!interaction.options.getBoolean('confirm', true)) {
          await interaction.editReply(messages.clearAllNotConfirmed);
          break;
        }
        if (channel.isDMBased()) throw new Error('/clear-all only works in server channels');
        await interaction.editReply(messages.clearAllWorking);
        let result: ClearResult;
        try {
          result = await clearChannel(discordClearable(channel));
        } catch (err) {
          const denied = [RESTJSONErrorCodes.MissingPermissions, RESTJSONErrorCodes.MissingAccess];
          if (err instanceof DiscordAPIError && denied.includes(err.code as RESTJSONErrorCodes)) {
            await interaction.editReply(messages.clearAllNoPermission);
            break;
          }
          throw err;
        }
        service.clearHistory(channelId);
        await interaction.editReply(messages.clearAllDone(result.deleted, result.skipped));
        break;
      }
      case 'regen': {
        await interaction.editReply(messages.regenerating);
        const stopTyping = startTyping(channel);
        try {
          const reply = await service.regen(channelId);
          stopTyping();
          await deleteMessages(channel, reply.removedDiscordIds);
          service.attachDiscordIds(reply.messageId, await sendChunks(channel, reply.text));
          await interaction.deleteReply().catch(() => undefined);
        } finally {
          stopTyping();
        }
        break;
      }
      case 'undo': {
        const { removed } = service.undo(channelId);
        const botMessages = removed.filter((m) => m.role === 'character').flatMap((m) => m.discordMessageIds);
        await deleteMessages(channel, botMessages);
        await interaction.editReply(messages.undone(removed.length));
        break;
      }
      case 'image': {
        const orientation = (interaction.options.getString('orientation') ?? 'portrait') as ImageOrientation;
        const portrait = service.mode(channelId) === 'builder';
        // The builder portrait comes straight from the draft's tags, so a request has nothing to steer there.
        const direction = portrait ? '' : (interaction.options.getString('direction') ?? '').trim();
        // Same name the chat history uses, so "me" or a nickname in the request maps to the right character line.
        const requester = interaction.member instanceof GuildMember ? interaction.member.displayName : interaction.user.displayName;
        if (!portrait) await interaction.editReply(messages.imageWritingPrompt);
        const stopTyping = startTyping(channel);
        try {
          const prompt = portrait
            ? service.builderPortrait(channelId)
            : await service.writeImagePrompt(channelId, direction, requester);
          const promptText = formatImagePrompt(prompt);
          await interaction.editReply(messages.imageGenerating);
          const seed = service.imageSeed(channelId, interaction.options.getBoolean('new_seed') ?? false);
          const image = await imageQueue.run('account', () => imageClient.generate(prompt, orientation, seed));
          stopTyping();
          const embed = new EmbedBuilder()
            .setTitle(messages.imageEmbedTitle)
            .setDescription(
              [direction && messages.imageRequest(direction), `\`\`\`\n${promptText.slice(0, 3600)}\n\`\`\``]
                .filter(Boolean)
                .join('\n'),
            )
            .setImage('attachment://scene.png')
            .setFooter({ text: messages.imageFooter(image.seed, image.percentAfter) });
          await interaction.editReply({
            content: image.anlasSpent > 0 ? messages.imageAnlasWarning(image.anlasSpent) : '',
            embeds: [embed],
            files: [new AttachmentBuilder(image.png, { name: 'scene.png' })],
          });
          if (image.anlasSpent > 0) console.warn(`Anlas balance dropped by ${image.anlasSpent} during /image`);
        } finally {
          stopTyping();
        }
        break;
      }
      case 'note': {
        const text = interaction.options.getString('text');
        service.setNote(channelId, text);
        await interaction.editReply(text?.trim() ? messages.noteSet(text.trim()) : messages.noteCleared);
        break;
      }
    }
  });
}

async function onAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const typed = interaction.options.getFocused().toLowerCase();
  const choices = [...service.listCharacters().characters.values()]
    .filter((c) => c.id.includes(typed) || c.name.toLowerCase().includes(typed))
    .slice(0, 25)
    .map((c) => ({ name: `${c.name} (${c.id})`.slice(0, 100), value: c.id }));
  await interaction.respond(choices);
}

client.on(Events.MessageCreate, (message) => {
  onMessage(message).catch((err) => console.error('Message handler failed:', err));
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    await onAutocomplete(interaction).catch((err) => console.error('Autocomplete failed:', err));
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  try {
    await onCommand(interaction);
  } catch (err) {
    console.error(`/${interaction.commandName} failed:`, err);
    const content = describeError(err);
    const reply = interaction.deferred || interaction.replied
      ? interaction.editReply(content)
      : interaction.reply({ content, flags: MessageFlags.Ephemeral });
    await reply.catch(() => undefined);
  }
});

client.once(Events.ClientReady, async (ready) => {
  const rest = new REST().setToken(config.discordToken);
  const route = config.discordGuildId
    ? Routes.applicationGuildCommands(ready.application.id, config.discordGuildId)
    : Routes.applicationCommands(ready.application.id);
  await rest.put(route, { body: commandDefinitions });
  const { characters, errors } = service.listCharacters();
  console.log(`Logged in as ${ready.user.tag}. Commands registered ${config.discordGuildId ? 'to guild' : 'globally'}.`);
  console.log(`Characters: ${[...characters.keys()].join(', ') || '(none)'}`);
  for (const error of errors) console.warn(`Character file skipped: ${error}`);
});

client.on(Events.Error, (err) => console.error('Discord client error:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

function shutdown(): void {
  console.log('Shutting down...');
  void client.destroy();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await client.login(config.discordToken);
