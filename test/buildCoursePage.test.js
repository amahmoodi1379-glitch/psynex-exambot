import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCoursePage, makeSlugFromTitle, COURSE_ID_MAX_LENGTH } from '../src/index.js';

const TELEGRAM_CALLBACK_LIMIT = 64;
const MAX_HOST_SUFFIX = ':hostp' + 'z'.repeat(13);
const encoder = new TextEncoder();

function createLongTitle(idx) {
  const base = 'عنوان بسیار بسیار طولانی برای آزمون '.repeat(4);
  return `${base.trim()} ${idx}`;
}

test('buildCoursePage keeps callback_data within Telegram limit', () => {
  const courses = Array.from({ length: 9 }, (_, idx) => {
    const title = createLongTitle(idx + 1);
    const id = makeSlugFromTitle(title);
    assert.ok(id.length <= COURSE_ID_MAX_LENGTH, `slug should respect limit (${id.length})`);
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
      const bytes = encoder.encode(button.callback_data).length;
      assert.ok(
        bytes <= TELEGRAM_CALLBACK_LIMIT,
        `callback_data exceeded limit (${bytes} bytes): ${button.callback_data}`
      );
    }
  }
});

test('buildCoursePage compacts oversized UTF-8 callbacks with Persian ids', () => {
  const persianCourseId = 'درس-طولانی-خصوصی-آزمون-۱۲۳۴۵۶۷';
  assert.ok(
    persianCourseId.length <= COURSE_ID_MAX_LENGTH,
    `persian id should respect max length (${persianCourseId.length})`
  );
  const courses = Array.from({ length: 9 }, (_, idx) => {
    if (idx < 8) {
      return { id: `course-${idx + 1}`, title: `Course ${idx + 1}` };
    }
    return { id: persianCourseId, title: 'درس فارسی ویژه' };
  });

  const page = 2;
  const { keyboard } = buildCoursePage({
    courses,
    page,
    rid: 'abcdefgh',
    hostSuffix: MAX_HOST_SUFFIX,
    pageSize: 8,
  });

  const original = `c:abcdefgh:${persianCourseId}${MAX_HOST_SUFFIX}`;
  assert.ok(
    encoder.encode(original).length > TELEGRAM_CALLBACK_LIMIT,
    'original callback should exceed Telegram byte limit'
  );

  const button = keyboard.flat().find((btn) => btn?.text === 'درس فارسی ویژه');
  assert.ok(button, 'expected Persian course button');

  const bytes = encoder.encode(button.callback_data).length;
  assert.ok(bytes <= TELEGRAM_CALLBACK_LIMIT, `callback_data exceeded limit (${bytes} bytes)`);

  const parts = button.callback_data.split(':');
  assert.equal(parts[0], 'c', 'course callback prefix');
  assert.equal(parts[1], 'abcdefgh', 'room id should remain intact');

  const token = parts[2];
  assert.notEqual(token, persianCourseId, 'should use compact key instead of full id');
  assert.ok(token.startsWith('i'), 'compact key should use expected prefix');

  const decodedIndex = Number.parseInt(token.slice(1), 36);
  assert.equal(decodedIndex, 8, 'compact key should map to global course index');
  assert.equal(courses[decodedIndex].id, persianCourseId, 'decoded course id should match original');
});
