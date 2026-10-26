# NovelAI Roleplay Discord Bot — Plan

## Decisions (2026-10-26)

| Topic | Decision |
|---|---|
| Language | Node.js + discord.js (TypeScript), slash commands |
| Host | This Windows PC |
| History storage | SQLite |
| Command permissions | Everyone in the channel |
| Secrets | `.env` (`DISCORD_TOKEN`, `NOVELAI_TOKEN`), `.env` in `.gitignore` |
| Image model | **V5 Full only** (`nai-diffusion-5-full`) — no fallback to V4.5 |

Build order: project skeleton + chat system first, then `/image`. **Status (2026-10-26): both built and tested live.**

## Image generation: V5 Full on Opus

Verified facts (sources below):
- Opus is unlimited only for V4.5 and older. Models above V4.5 have a refilling usage limit;
  past it, every image costs Anlas until the limit refills.
- Free conditions within the limit: 1 image, steps <= 28, up to Normal size
  (832×1216 / 1216×832 / 1024×1024), no base/reference image.
  Reported: 1024×1536 costs 45 Anlas.
- Usage endpoint: `GET https://image.novelai.net/user/subscription`
  (the old `api.novelai.net` host returns 400 for this).
  Response has `usage.percent`, `usage.isNegative`, `usage.timeUntilNextPercent`;
  subscription Anlas in `fixedTrainingStepsLeft`, purchased in `purchasedTrainingSteps`.
- No known endpoint that quotes a request's Anlas cost in advance.

Rules enforced in code:
1. Hard-lock: 1 image, size in {832×1216, 1216×832, 1024×1024}, steps <= 28,
   no Vibe Transfer / reference images, model fixed to V5 Full.
2. Pre-flight, inside the per-channel queue right before the generate POST:
   call `/user/subscription`. If the limit is exhausted (`isNegative`, or `percent`
   below a small safety margin), or the call fails → **refuse** and post in chat
   how long until it refills (derived from `timeUntilNextPercent`).
   Fail closed: never let a request fall through to Anlas.
3. Post-check: compare Anlas balance before/after; if it dropped, warn in chat.

Verified during implementation (2026-10-26):
- Generate: `POST https://image.novelai.net/ai/generate-image`, body
  `{ input, model: "nai-diffusion-5-full", action: "generate", parameters }` with
  `params_version: 4`; per-character prompts go in `v4_prompt.caption.char_captions`
  (`{ char_caption, centers }`). Response is a zip holding one PNG.
- A live 832×1216, 28-step image cost 0 Anlas; allowance went 100% -> 99%.
- `timeUntilNextPercent` stayed at 7888 both at 100% and at 99%, so it reads as
  seconds per 1% (~2.2 h), not a live countdown. Refill estimates use it that way.
- `429 Concurrent generation is locked` happens right after the text request that
  writes the prompt; the client waits and retries (no charge on a refused request).

Original open questions:
- Exact unit/meaning of `timeUntilNextPercent` and what `percent` value means "empty".
- Generate endpoint host/path and the V5 request body, including the per-character
  prompt fields (character prompts / `char_captions`) — check whether V5 keeps the
  V4/V4.5 format.

## Text generation (chat part — built)

Findings (2026-10-26):
- NovelAI's official scripting docs name `glm-4-6` as the current text model and
  describe it as served through an "OpenAI-like completions endpoint".
- `https://text.novelai.net/oa/v1/completions` exists (returns 401 without a token,
  unlike unknown paths which return 404). The legacy `/ai/generate` (token-id based,
  used for Kayra/Erato) also still exists.
- Not verified without a real token: the exact model list for Opus and the Opus
  context size. `npm run check-api` lists the models the token can use and runs one
  completion; model and context size are configurable in `.env`.

## Sources
- https://docs.novelai.net/en/subscription/
- https://dev.to/ilan_kim/novelai-v5-on-opus-usage-limits-the-2026-09-21-subscription-anlas-reset-and-the-apinovelainet-567l
- https://dev.to/ilan_kim/running-novelai-v5-in-comfyui-nai-diffusion-5-full-works-and-the-error-fetching-anlas-400-is-a-18gl
- https://github.com/raspie10032/ComfyUI_RS_NAI_API_Request/issues/8

## Assistant chat mode (`/chat`)

- `/chat` binds a channel to the reserved id `:chat` (no character file; ":" cannot appear in a file name, so no migration).
- Uses `https://text.novelai.net/oa/v1/chat/completions` with `glm-4-6`. Verified: `stream: false` returns an empty text, so the client always streams SSE and joins `choices[0].delta.content`.
- Replies up to `CHAT_MAX_OUTPUT_TOKENS` (1500). A live Thai answer took ~41 s and finished with `stop`.
- `/regen`, `/undo`, `/reset`, `/note` (extra system instructions) work; `/image` is refused.

## Character builder (`/builder`, `/save`)

- `/builder [character]` binds the channel to `:builder` (new) or `:builder:<id>` (edit) and chats through the same chat endpoint with a builder system prompt. When editing, the current file is re-read every turn and attached to the system prompt.
- Replies up to `BUILDER_MAX_OUTPUT_TOKENS` (3000) with a `BUILDER_MAX_CONTEXT_TOKENS` (16000) budget. Live: a full new character took ~55-85 s and ~4000 characters (2-3 Discord messages; split keeps code fences intact).
- `/save` takes the last complete ```yaml block, validates it with the character parser, and writes `characters/<id>.yaml`. Overwrites keep `<file>.bak`. A new character never replaces another file unless `overwrite:True`. File id: option > edited id > ASCII name > ASCII always-on lorebook key.
- `/image` in a builder channel draws a portrait (solo, white background, cowboy shot) from the Image tags of the latest unsaved draft, else the edited file; no text-model call. Same free-allowance guards and per-channel seed as scene images. Live: 0 Anlas spent.
- An unquoted `authors_note: [ ... ]` is YAML for a list; the parser now rejects it instead of dropping it.
