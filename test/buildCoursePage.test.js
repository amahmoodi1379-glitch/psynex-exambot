import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCoursePage, makeSlugFromTitle, COURSE_ID_MAX_LENGTH } from '../src/index.js';

const TELEGRAM_CALLBACK_LIMIT = 64;
const MAX_HOST_SUFFIX = ':hp' + 'z'.repeat(13);
const encoder = new TextEncoder();
const byteLength = (value) => encoder.encode(String(value ?? '')).length;

function createLongTitle(idx) {
  const base = 'عنوان بسیار بسیار طولانی برای آزمون '.repeat(4);
  return `${base.trim()} ${idx}`;
}

test('buildCoursePage keeps callback_data within Telegram limit', () => {
  const courses = Array.from({ length: 9 }, (_, idx) => {
    const title = createLongTitle(idx + 1);
    const id = makeSlugFromTitle(title);
    const idBytes = byteLength(id);
    assert.ok(idBytes <= COURSE_ID_MAX_LENGTH, `slug should respect limit (${idBytes})`);
    return { id, title };
  });

  const { keyboard } = buildCoursePage({
    courses,
    page: 1,
    rid: 'abcdefgh',
    hostSuffix: MAX_HOST_SUFFIX,
    pageSize: 8,
  });

  assert.ok(Array.isArray(keyboard) && keyboard.length > 0, 'keyboard should not be empty');

  for (const row of keyboard) {
    for (const button of row) {
      if (!button?.callback_data) continue;
      const length = byteLength(button.callback_data);
      assert.ok(
        length <= TELEGRAM_CALLBACK_LIMIT,
        `callback_data exceeded limit (${length}): ${button.callback_data}`
      );
    }
  }
});

test('buildCoursePage keeps Persian private callbacks within Telegram byte limit', () => {
  const persianTitle = 'درس بسیار طولانی و پیشرفتهٔ آمادگی کنکور رشتهٔ ریاضی فیزیک';
  const persianId = makeSlugFromTitle(persianTitle);
  const persianIdBytes = byteLength(persianId);
  assert.ok(
    persianIdBytes <= COURSE_ID_MAX_LENGTH,
    `Persian slug should respect byte limit (${persianIdBytes})`
  );

  const extraCourses = Array.from({ length: 4 }, (_, idx) => {
    const title = `Course ${idx + 1}`;
    const id = makeSlugFromTitle(title);
    assert.ok(byteLength(id) <= COURSE_ID_MAX_LENGTH, 'extra slug exceeds limit');
    return { id, title };
  });

  const courses = [{ id: persianId, title: persianTitle }, ...extraCourses];

  const { keyboard } = buildCoursePage({
    courses,
    page: 1,
    rid: 'abcdefgh',
    hostSuffix: MAX_HOST_SUFFIX,
    pageSize: 2,
  });

  assert.ok(Array.isArray(keyboard) && keyboard.length > 0, 'keyboard should not be empty');

  for (const row of keyboard) {
    for (const button of row) {
      if (!button?.callback_data) continue;
      const length = byteLength(button.callback_data);
      assert.ok(
        length <= TELEGRAM_CALLBACK_LIMIT,
        `callback_data exceeded limit (${length}): ${button.callback_data}`
      );
    }
  }
});
