import test from 'node:test';
import assert from 'node:assert/strict';

import { CallbackMapDO } from '../src/callback/callback-map-do.js';
import { CALLBACK_TOKEN_TTL_SECONDS } from '../src/callback/token-service.js';

class MockStorage {
  constructor() {
    this.map = new Map();
  }
  async put(key, value) {
    this.map.set(key, value);
  }
  async get(key) {
    return this.map.get(key);
  }
  async delete(key) {
    this.map.delete(key);
  }
}

class MockState {
  constructor() {
    this.storage = new MockStorage();
  }
}

test('CallbackMapDO stores and expires callback payloads', async () => {
  const state = new MockState();
  const env = {};
  const callbackDO = new CallbackMapDO(state, env);
  const baseTime = Date.now();
  let now = baseTime;
  callbackDO.now = () => now;

  const key = 'cb:sampletoken';
  const payload = { type: 'example', value: 42 };

  const putResponse = await callbackDO.fetch(
    new Request('https://callback/put', {
      method: 'POST',
      body: JSON.stringify({ key, payload, ttlSeconds: 5 }),
      headers: { 'content-type': 'application/json' },
    })
  );
  const putBody = await putResponse.json();
  assert.ok(putBody.ok, 'put should succeed');

  const getEarly = await callbackDO.fetch(
    new Request('https://callback/get', {
      method: 'POST',
      body: JSON.stringify({ key }),
      headers: { 'content-type': 'application/json' },
    })
  );
  const getEarlyBody = await getEarly.json();
  assert.ok(getEarlyBody.ok, 'get before expiry should succeed');
  assert.deepEqual(getEarlyBody.payload, payload);

  now = baseTime + (CALLBACK_TOKEN_TTL_SECONDS + 5) * 1000;
  const getExpired = await callbackDO.fetch(
    new Request('https://callback/get', {
      method: 'POST',
      body: JSON.stringify({ key }),
      headers: { 'content-type': 'application/json' },
    })
  );
  const getExpiredBody = await getExpired.json();
  assert.strictEqual(getExpiredBody.ok, false, 'expired entry should not be ok');
  assert.strictEqual(getExpiredBody.error, 'expired');
});
