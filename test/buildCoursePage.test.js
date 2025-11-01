import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { buildCoursePage, makeSlugFromTitle, COURSE_ID_MAX_LENGTH } from '../src/index.js';
import { byteLen, ensureIdMap } from '../src/utils.js';

if (!globalThis.crypto?.subtle) {
  globalThis.crypto = webcrypto;
}

const TELEGRAM_CALLBACK_LIMIT = 64;

class MemoryR2Object {
  constructor(body) {
    this.body = body;
  }
  async text() {
    return this.body;
  }
  async json() {
    return JSON.parse(this.body);
  }
}

class MemoryR2Bucket {
  constructor() {
    this.store = new Map();
  }
  async head(key) {
    return this.store.has(key) ? { key } : null;
  }
  async put(key, value, options = {}) {
    if (options?.onlyIf?.etagDoesNotMatch === '*' && this.store.has(key)) {
      return null;
    }
    const body = typeof value === 'string' ? value : JSON.stringify(value);
    this.store.set(key, body);
    return { key };
  }
  async get(key) {
    if (!this.store.has(key)) return null;
    return new MemoryR2Object(this.store.get(key));
  }
}

function createLongTitle(idx) {
  const base = 'Extremely lengthy course title for testing '.repeat(2);
  return `${base.trim()} ${idx}`;
}

test('buildCoursePage keeps callback_data within Telegram limit', async () => {
  const env = { QUESTIONS: new MemoryR2Bucket() };
  const courses = Array.from({ length: 9 }, (_, idx) => {
    const title = createLongTitle(idx + 1);
    const id = makeSlugFromTitle(title);
    assert.ok(id.length <= COURSE_ID_MAX_LENGTH, `slug should respect limit (${id.length})`);
    return { id, title };
  });

  const { keyboard } = await buildCoursePage({
    env,
    courses,
    page: 1,
    rid: 'abcdefgh',
    pageSize: 8,
  });

  assert.ok(Array.isArray(keyboard) && keyboard.length > 0, 'keyboard should not be empty');

  for (const row of keyboard) {
    for (const button of row) {
      if (!button?.callback_data) continue;
      const byteLength = byteLen(button.callback_data);
      assert.ok(
        byteLength <= TELEGRAM_CALLBACK_LIMIT,
        `callback_data exceeded limit (${byteLength}): ${button.callback_data}`
      );
    }
  }
});

test('buildCoursePage creates deterministic idmap entries for long slugs', async () => {
  const env = { QUESTIONS: new MemoryR2Bucket() };
  const title = 'عنوان بسیار بسیار طولانی برای آزمون با حروف فارسی';
  const id = makeSlugFromTitle(title);
  const rid = 'abcdefgh';
  const { keyboard } = await buildCoursePage({
    env,
    courses: [{ id, title }],
    page: 1,
    rid,
    pageSize: 1,
  });

  assert.ok(Array.isArray(keyboard) && keyboard.length === 1, 'single row expected');
  const button = keyboard[0][0];
  assert.ok(button?.callback_data, 'course button should have callback_data');
  const parts = button.callback_data.split(':');
  assert.equal(parts[0], 'c', 'callback prefix should remain c');
  assert.equal(parts[1], rid, 'room id should be preserved');
  const sid = parts[2];
  assert.ok(sid && sid.length <= 16, 'short id should be compact');
  const mapObject = await env.QUESTIONS.get(`idmap/${sid}.json`);
  assert.ok(mapObject, 'idmap entry should be stored in memory bucket');
  const parsed = await mapObject.json();
  assert.equal(parsed.key, id, 'idmap should point to original course id');
  assert.ok(byteLen(button.callback_data) <= TELEGRAM_CALLBACK_LIMIT, 'callback_data should respect Telegram limit');
});

test('ensureIdMap throws when a different key already exists for the same sid', async () => {
  const env = { QUESTIONS: new MemoryR2Bucket() };
  const sid = 'abcdef';
  const first = await ensureIdMap(env, sid, 'original-long-key');
  assert.equal(first, `idmap/${sid}.json`);

  await assert.rejects(
    () => ensureIdMap(env, sid, 'conflicting-long-key'),
    /idmap collision for abcdef/
  );
});
