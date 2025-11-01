import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCoursePage, makeSlugFromTitle, COURSE_ID_MAX_LENGTH } from '../src/index.js';

const TELEGRAM_CALLBACK_LIMIT = 64;

function createLongTitle(idx) {
  const base = 'Extremely lengthy course title for testing '.repeat(2);
  return `${base.trim()} ${idx}`;
}

function createMockRegistrar() {
  let counter = 0;
  const assignments = [];
  const registrar = async ({ prefix, payload, contextKey }) => {
    const token = `token${counter++}`;
    const callback_data = `${prefix}:${token}`;
    assignments.push({ callback_data, payload, contextKey });
    return callback_data;
  };
  return { registrar, assignments };
}

test('buildCoursePage keeps callback_data within Telegram limit', async () => {
  const courses = Array.from({ length: 9 }, (_, idx) => {
    const title = createLongTitle(idx + 1);
    const id = makeSlugFromTitle(title);
    assert.ok(id.length <= COURSE_ID_MAX_LENGTH, `slug should respect limit (${id.length})`);
    return { id, title };
  });

  const { registrar, assignments } = createMockRegistrar();

  const { keyboard } = await buildCoursePage({
    courses,
    page: 1,
    rid: 'abcdefgh',
    chatId: -100123,
    tokenRegistrar: registrar,
    pageSize: 8,
  });

  assert.ok(Array.isArray(keyboard) && keyboard.length > 0, 'keyboard should not be empty');

  for (const row of keyboard) {
    for (const button of row) {
      if (!button?.callback_data) continue;
      const byteLength = Buffer.byteLength(button.callback_data, 'utf8');
      assert.ok(
        byteLength <= TELEGRAM_CALLBACK_LIMIT,
        `callback_data exceeded limit (${byteLength}): ${button.callback_data}`
      );
    }
  }

  assert.ok(assignments.length > 0, 'registrar should be called for each button');
  const firstCourse = assignments.find((entry) => entry.payload?.type === 'course-select');
  assert.ok(firstCourse, 'course-select payload should be registered');
  assert.strictEqual(firstCourse.payload.rid, 'abcdefgh');
  assert.strictEqual(firstCourse.payload.chatId, -100123);
});

test('buildCoursePage handles Persian slugs without exceeding callback limit', async () => {
  const title = 'عنوان بسیار بسیار طولانی برای آزمون با حروف فارسی';
  const id = makeSlugFromTitle(title);
  const rid = 'abcdefgh';
  const { registrar, assignments } = createMockRegistrar();

  const { keyboard } = await buildCoursePage({
    courses: [{ id, title }],
    page: 1,
    rid,
    chatId: -42,
    tokenRegistrar: registrar,
    pageSize: 1,
  });

  assert.ok(Array.isArray(keyboard) && keyboard.length === 1, 'keyboard should contain one row');
  const button = keyboard[0][0];
  assert.ok(button?.callback_data, 'button should include callback_data');
  const byteLength = Buffer.byteLength(button.callback_data, 'utf8');
  assert.ok(byteLength <= TELEGRAM_CALLBACK_LIMIT, 'callback_data should respect Telegram byte limit');
  assert.ok(assignments.some((entry) => entry.payload?.type === 'course-select'));
});
