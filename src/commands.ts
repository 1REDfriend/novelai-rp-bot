import { SlashCommandBuilder } from 'discord.js';
import { messages } from './messages.js';

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('start')
    .setDescription(messages.commands.start)
    .addStringOption((o) =>
      o.setName('character').setDescription(messages.commands.startCharacter).setRequired(true).setAutocomplete(true),
    ),
  new SlashCommandBuilder().setName('chat').setDescription(messages.commands.chat),
  new SlashCommandBuilder()
    .setName('builder')
    .setDescription(messages.commands.builder)
    .addStringOption((o) => o.setName('character').setDescription(messages.commands.builderCharacter).setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('save')
    .setDescription(messages.commands.save)
    .addStringOption((o) => o.setName('file').setDescription(messages.commands.saveFile).setMaxLength(40))
    .addBooleanOption((o) => o.setName('overwrite').setDescription(messages.commands.saveOverwrite)),
  new SlashCommandBuilder().setName('regen').setDescription(messages.commands.regen),
  new SlashCommandBuilder().setName('undo').setDescription(messages.commands.undo),
  new SlashCommandBuilder().setName('reset').setDescription(messages.commands.reset),
  new SlashCommandBuilder()
    .setName('note')
    .setDescription(messages.commands.note)
    .addStringOption((o) => o.setName('text').setDescription(messages.commands.noteText).setMaxLength(1000)),
  new SlashCommandBuilder().setName('characters').setDescription(messages.commands.characters),
  new SlashCommandBuilder()
    .setName('image')
    .setDescription(messages.commands.image)
    .addStringOption((o) => o.setName('direction').setDescription(messages.commands.imageDirection).setMaxLength(300))
    .addStringOption((o) =>
      o
        .setName('orientation')
        .setDescription(messages.commands.imageOrientation)
        .addChoices(
          { name: 'portrait (832x1216)', value: 'portrait' },
          { name: 'landscape (1216x832)', value: 'landscape' },
          { name: 'square (1024x1024)', value: 'square' },
        ),
    )
    .addBooleanOption((o) => o.setName('new_seed').setDescription(messages.commands.imageNewSeed)),
].map((c) => c.toJSON());
