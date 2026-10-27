# NovelAI Roleplay Bot — AI Character Chat for Discord

**English** | [ภาษาไทย](README.th.md)

A self-hosted **Discord AI roleplay bot** powered by the **NovelAI API**. Bring your own characters to your server, chat with them in any language (Thai included), build new characters by talking to an AI, and draw the current scene as an anime-style picture with **NovelAI Diffusion V5**, all inside the free allowance of a NovelAI Opus plan.

Think of it as a private **Character.AI alternative** that lives in your own Discord server: your characters, your lorebooks, your chat history, on your own machine.

## Features

- **Character roleplay in any channel.** Bind a channel to a character with `/start` and just talk. Each channel keeps its own story, and multiple people can join the same scene.
- **Memory, lorebook and Author's Note.** NovelAI-style context building: permanent memory at the top, lorebook entries that appear when their keywords come up, and an Author's Note near the end to steer tone and length.
- **AI character builder.** `/builder` turns a channel into a workshop. Describe the character you want (or ask the AI to invent everything), refine it in conversation, preview its look with `/image`, then `/save` it as a ready-to-play file. Existing characters can be edited the same way, with an automatic backup.
- **Scene illustrations with consistent characters.** `/image` asks the text model to describe the latest scene as Danbooru tags, then draws it with NovelAI Diffusion V5 Full. Each character's look is locked from their lorebook tags, and every channel keeps one seed, so characters stay recognisable from picture to picture.
- **Never spends Anlas by accident.** Image settings are hard-locked to the free tier (1 image, ≤ 28 steps, normal sizes, no reference images). The bot checks your remaining allowance before every picture, refuses when it is low, and warns you if your Anlas balance ever drops.
- **Assistant chat.** `/chat` makes a channel a plain GLM-4.6 assistant, with no character attached.
- **Prompt helper character.** The bundled `tagsmith` character turns an image idea into ready-to-paste NovelAI prompt boxes (main prompt, per-character prompts, undesired content) plus suggested settings.
- **Story controls.** `/regen` rewrites the last reply, `/undo` takes back your last turn, `/reset` restarts from the greeting, and `/note` changes the Author's Note for the current scene.
- **Persistent history.** Chats are stored in SQLite, so stories survive restarts. Character files are plain YAML and reload without restarting the bot.
- **Thai-friendly.** Characters can speak Thai; token budgets and message splitting are tuned for Thai text.

## Requirements

- **Node.js 22.13 or newer** (the bot uses Node's built-in SQLite, nothing else to install)
- An active **NovelAI subscription**. `/image` needs the **Opus** plan.
- A Discord server where you can invite bots

## 1. Create the Discord bot

1. Open https://discord.com/developers/applications and click **New Application**.
2. On the **Bot** tab, click **Reset Token** and copy it. This is your `DISCORD_TOKEN`.
3. Still on the **Bot** tab, under **Privileged Gateway Intents**, turn on **Message Content Intent**. Without it the bot cannot read messages and characters will never answer.
4. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot` and `applications.commands`
   - Bot permissions: `View Channels`, `Send Messages`, `Read Message History`, `Embed Links`, `Attach Files`
5. Open the generated link in your browser and pick the server to add the bot to.

**Tip:** put your server's ID in `DISCORD_GUILD_ID` so slash commands appear instantly. Left empty, Discord can take up to an hour. To copy the ID, turn on **User Settings → Advanced → Developer Mode**, then right-click the server name and choose **Copy Server ID**.

## 2. Get a NovelAI token

1. Log in at https://novelai.net
2. Open **User Settings → Account** and click **Get Persistent API Token**.
3. Copy the token (it starts with `pst-`). This is your `NOVELAI_TOKEN`.

The token gives full access to your account. Never share it or commit it (`.env` is already git-ignored).

## 3. Install and run

```bash
npm install
```

Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`, `NOVELAI_TOKEN` and, optionally, `DISCORD_GUILD_ID`. Every other line that still says `your-...` or is empty falls back to the defaults listed under [Configuration](#configuration).

```bash
cp .env.example .env
```

Before the first run, check that the token works and the model name is right:

```bash
npm run check-api
```

The script lists the models your token can use and runs one short test generation. If the text model in the list is not `glm-4-6`, set `NOVELAI_TEXT_MODEL` in `.env` to the name you see.

Then start the bot:

```bash
npm run dev
```

`Logged in as ...` means it is ready. Press `Ctrl+C` to stop. For a faster start, build first with `npm run build`, then run `npm start`.

## Commands

| Command | What it does |
|---|---|
| `/start <character>` | Bind this channel to a character, clear its history and post the greeting |
| *(any message)* | The character replies (only in bound channels) |
| `/regen` | Delete the character's last reply and write a new one |
| `/undo` | Remove your last message and the character's reply from the history |
| `/reset` | Clear this channel's history and start again from the greeting |
| `/note <text>` | Temporarily replace the scene's Author's Note. `/note` with no text restores the default |
| `/chat` | Turn this channel into a plain AI assistant chat with no character |
| `/builder [character]` | Turn this channel into a character builder, for a new character or an existing one |
| `/save [file] [overwrite]` | Save the latest character file the builder wrote |
| `/characters` | List the available characters |
| `/image [direction] [orientation] [new_seed]` | Draw the latest scene (in a builder channel: the character being built). `direction` says what the picture should show, in your own words. Portrait by default; `new_seed: True` picks a new art style seed |

Characters see your server display name. When several people post at once, the bot answers one message at a time, in order.

## Build characters by chatting: `/builder`

No need to write YAML by hand.

1. Run `/builder` in an empty channel. To edit an existing character, pick it in the `character` option, e.g. `/builder character:aria`.
2. Describe the character you want. The builder asks a few questions at a time. Too lazy to answer? Say "invent the rest and show me the file".
3. The builder shows the complete file in a code block. Ask for changes as many times as you like.
4. Happy with it? Run `/save`. The file is validated first; if anything is wrong, nothing is saved and the bot tells you what to fix.
5. Go to another channel and `/start <file name>`. No restart needed.

Good to know:

- The file name comes from the character's English name. For a name in Thai only, the English lorebook key is used, or choose one yourself with `/save file:<name>`.
- A new character never replaces another file unless you add `/save overwrite:True`.
- Before overwriting, the old file is kept as `<name>.yaml.bak` in the `characters` folder. Rename it back to undo.
- After `/save`, the channel keeps editing that file. Keep chatting and `/save` again.
- Memory and lorebook are written in English because GLM follows English notes better; the greeting uses your story's language.
- For Thai characters, the builder fixes one self-pronoun that fits the character (e.g. ข้า, หนู, ดิฉัน or her own name for a woman; ผม or ข้า for a man) and how they address you, and writes it into both memory and the Author's Note. It avoids ฉัน, since that is usually what you call yourself. Ask for a different pronoun any time.
- Want to see the character? `/image` draws them standing alone on a plain background from the `Image tags` in the latest draft, no `/save` needed. Change the tags and draw again; the channel keeps one seed so you can see exactly what the tags changed.

## Prompt helper: `tagsmith`

`tagsmith` doesn't roleplay. Run `/start tagsmith`, describe a picture in Thai or English, and it replies with boxes to paste into NovelAI's image generator on the website:

- **Main prompt**: number of people, place, lighting, camera angle, art style
- **Character 1, 2, ...**: each character's look, outfit and pose, with `source#` / `target#` action tags when characters interact (e.g. `source#hug`)
- **Character N undesired**: things to keep off that character (`-` means none)
- **Undesired content**: things to keep out of this picture. For general quality issues, pick the **Heavy** preset in the website's Undesired Content box
- **Settings**: recommended steps, guidance and sampler

Use `/regen` for another take.

## Scene pictures: `/image`

In a roleplay channel, `/image` works in three steps:

1. The text model reads the latest part of the story and writes the scene as English tags, split into the scene (`Main`) and each character. This description is not saved to the chat history, so characters never start imitating it.
2. If the model gets the format wrong, it gets one retry; if it fails again, the bot says so in the chat.
3. The picture is drawn with V5 Full and posted together with the prompt used, so you can take it into NovelAI and keep editing.

Want a particular shot? Say it in `direction`, in Thai or English, e.g. `/image direction: Aria carries Rowan on her back, seen from behind, sunset`. The model follows your words first and fills in the rest (place, outfits, looks) from the story. The request applies to that one picture only and is not saved to the chat history. It is shown above the prompt in the reply.

### Keeping characters consistent

- **Looks are locked from the lorebook.** The line `Image tags (<name>): ...` is copied into every picture exactly. The model only writes what changes in the scene: pose, expression, where they face, what they hold. Outfits and hair change only when the story clearly says so.
- **Tag the whole outfit.** Hair length and style, hair colour, eye colour, top, bottom, shoes and accessories. Anything left out is re-guessed for every picture: skip the bottom and a skirt may turn into jeans.
- **Add your own look too**, or "you" will look different every time. Add an `always_on: true` lorebook entry with a line `Image tags (<your Discord display name>): ...`. See the commented example in `characters/aria.yaml`.
- **One seed per story.** Every channel reuses the same seed, so the art style stays steady. `/image new_seed: True` picks a new one and keeps it; `/start` resets it.

Small differences can still happen. Exact consistency needs Character Reference or Vibe Transfer, which cost Anlas, so the bot doesn't use them.

### Free allowance only (no Anlas spent)

- One image at a time, sizes 832×1216, 1216×832 or 1024×1024 only, 28 steps, no reference images or Vibe Transfer. These limits are in the code; no command can raise them.
- V5 Full only, never a different model.
- On Opus, V5 is free within an allowance that refills over time. Before each picture the bot checks it. Below 2 %, or if the check fails, the bot refuses and tells you how long until you can draw again.
- After each picture, the bot compares your Anlas balance before and after and warns in the chat if it dropped. The image footer shows how much allowance is left.

## Writing characters by hand

Copy `characters/aria.yaml` to a new file, e.g. `characters/ren.yaml`, and edit it. The file name without `.yaml` is what you use in `/start ren`. Changes apply from the next message; no restart needed.

Fields:

- `name`: the character's name, used as the speaker name
- `memory`: core facts about the story, always placed at the top of the context
- `lorebook`: extra entries, each with
  - `keys`: words that trigger the entry when they appear in the last few messages (see `LOREBOOK_SCAN_DEPTH`)
  - `text`: the content to insert
  - `always_on`: `true` to include it every time
  - a character entry should include an `Image tags (<name>): ...` line of English Danbooru tags for pictures
  - a place entry can include a `Scene tags (<place>): ...` line of background tags (no people, time or weather), so `/image` draws that place the same way every time. Make the starting place `always_on: true`
- `authors_note`: a short instruction inserted near the end of the context to control the reply style (in double quotes)
- `greeting`: the opening message

A file with mistakes is skipped; the reason shows in `/characters` and in the bot's console.

## Configuration

All settings live in `.env`.

| Setting | Default | Meaning |
|---|---|---|
| `MAX_OUTPUT_TOKENS` | 500 | Max reply length. Thai uses roughly one token per character. A reply that hits the limit gets up to 120 more tokens to finish its sentence; if it still is not done, it is trimmed back to its last complete sentence |
| `MAX_CONTEXT_TOKENS` | 8000 | Total context size. The oldest history is dropped first; memory, lorebook and Author's Note are never dropped |
| `TEMPERATURE` / `TOP_P` | 0.7 / 0.95 | How varied the replies are |
| `LOREBOOK_SCAN_DEPTH` | 4 | How many recent messages are scanned for lorebook keys |
| `AUTHORS_NOTE_DEPTH` | 1 | How many messages before the end of the history the Author's Note goes |
| `CHAT_MAX_OUTPUT_TOKENS` | 1500 | Max reply length in `/chat` channels |
| `BUILDER_MAX_OUTPUT_TOKENS` | 3000 | Max reply length in `/builder` channels; must fit a full character file |
| `BUILDER_MAX_CONTEXT_TOKENS` | 16000 | Context size in `/builder` channels (the edited file plus the conversation) |
| `STORY_DIRECTIVE` | built-in rules | Story rules added after every roleplay Author's Note, for all characters: characters take initiative, carry through what you start, and do not repeat lines. `{{char}}` becomes the character's name. Set `off` to turn it off |
| `NOVELAI_CHAT_URL` | `https://text.novelai.net/oa/v1/chat/completions` | Endpoint for `/chat` and `/builder`; normally left alone |
| `DATABASE_PATH` | `data/bot.db` | Where chat history is stored |

Token counts are estimated (no real tokenizer) with a generous margin for Thai. If NovelAI reports that the context is too long, lower `MAX_CONTEXT_TOKENS`.

## Development

```bash
npm test
npm run typecheck
```

Built with TypeScript, [discord.js](https://discord.js.org) and Node's built-in SQLite.

## Disclaimer

This is an unofficial project and is not affiliated with or endorsed by NovelAI or Discord. You are responsible for following NovelAI's and Discord's terms of service and your server's rules, including for any characters you create or share.

## Support

If this bot brought your characters to life on your server, you can [buy me a coffee](https://buymeacoffee.com/tongtongkok).

<a href="https://buymeacoffee.com/tongtongkok"><img width="200" height="200" alt="Buy Me a Coffee QR code" src="https://github.com/user-attachments/assets/4034910a-9019-498d-a3e7-85d96b789e5e" /></a>

## License

Free for **personal and other noncommercial use** under the [PolyForm Noncommercial License 1.0.0](LICENSE). You can run it, change it and share it for non-commercial purposes.

**Commercial use** (companies, paid bots or services, enterprise deployments) needs a separate license. Please [contact me through GitHub](https://github.com/1REDfriend) first.

<sub>Keywords: discord ai roleplay bot, ai character chat, character ai alternative, self-hosted ai companion, novelai discord bot, novelai api, glm-4.6 roleplay, ai lorebook, anime ai image generator, novelai diffusion v5, sillytavern alternative for discord, thai ai chatbot</sub>
