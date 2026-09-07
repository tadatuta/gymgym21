import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GoogleGenAI } from '@google/genai';
const { generateRecommendation } = await import('../dist/ai.js');
const { config } = await import('../dist/config.js');

const input = {
  type: 'general', profile: { timeZone: 'Europe/Moscow' }, workouts: [],
  workoutTypes: [{ id: 's', name: 'Bodyweight', category: 'strength' }, { id: 't', name: 'Plank', category: 'time' }],
  logs: [{ id: '1', workoutTypeId: 's', weight: 0, reps: 12, date: '2026-09-01T23:00:00Z' }, { id: '2', workoutTypeId: 't', duration: 2, durationSeconds: 30, date: '2026-09-01T23:00:00Z' }],
};

test('AI uses configured model, zero-weight strength, seconds and owner day', async () => {
  const previous = config.AI_MODEL;
  try {
    config.AI_MODEL = 'synthetic-model';
    let params;
    const result = await generateRecommendation(input, undefined, { models: { generateContent: async value => { params = value; return { text: 'ok' }; } } });
    assert.equal(result, 'ok');
    assert.equal(params.model, 'synthetic-model');
    const prompt = params.contents[0].parts[0].text;
    assert.match(prompt, /2026-09-02: Bodyweight \(0kg x 12\)/);
    assert.match(prompt, /Plank \(150 seconds\)/);
  } finally { config.AI_MODEL = previous; }
});

test('installed real Google SDK aborts its fetch transport, without contacting Google', async () => {
  const original = globalThis.fetch;
  const client = new GoogleGenAI({ apiKey: 'synthetic-test-only' });
  const controller = new AbortController();
  let transportSignal;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async (_url, init) => {
    transportSignal = init.signal;
    started();
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('synthetic transport cancelled')), { once: true }));
  };
  try {
    const operation = generateRecommendation(input, controller.signal, client);
    const rejected = assert.rejects(operation, /synthetic caller abort/);
    await ready;
    controller.abort(new Error('synthetic caller abort'));
    await rejected;
    assert.equal(transportSignal.aborted, true);
  } finally { globalThis.fetch = original; }
});

test('pre-aborted AI does not call transport', async () => {
  const controller = new AbortController();
  controller.abort(new Error('already gone'));
  await assert.rejects(generateRecommendation(input, controller.signal, { models: { generateContent() { assert.fail('must not start'); } } }), /already gone/);
});
