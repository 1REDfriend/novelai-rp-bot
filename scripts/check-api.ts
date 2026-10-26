/**
 * Smoke test for the NovelAI text API with your real token.
 * Lists the models the token can use, then runs one short completion.
 * Usage: npm run check-api
 */
import { envValue } from '../src/config.js';
import { NovelAITextClient } from '../src/novelai.js';

const token = envValue('NOVELAI_TOKEN');
if (!token) {
  console.error('NOVELAI_TOKEN is not set in .env');
  process.exit(1);
}
const url = envValue('NOVELAI_TEXT_URL') ?? 'https://text.novelai.net/oa/v1/completions';
const model = envValue('NOVELAI_TEXT_MODEL') ?? 'glm-4-6';

const modelsUrl = new URL('models', url.replace(/completions\/?$/, '')).toString();
console.log(`GET ${modelsUrl}`);
const modelsResponse = await fetch(modelsUrl, { headers: { Authorization: `Bearer ${token}` } });
console.log(`-> ${modelsResponse.status}`);
console.log((await modelsResponse.text()).slice(0, 2000));

console.log(`\nPOST ${url} (model: ${model})`);
const client = new NovelAITextClient({ url, model, token });
try {
  const { text, finishReason } = await client.complete({
    prompt: '[ Language: Thai dialogue ]\nTraveler: Hello! Is this the potion shop?\nAria:',
    maxTokens: 60,
    stop: ['\nTraveler:'],
    temperature: 1,
    topP: 0.95,
  });
  console.log(`-> OK (finish_reason: ${finishReason}). Completion:`);
  console.log(text);
} catch (err) {
  console.error('-> Failed:', err);
  process.exit(1);
}
