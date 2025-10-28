import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCoursePage,
  makeSlugFromTitle,
  COURSE_ID_MAX_LENGTH,
  normalizeCourseId,
  sanitizeShortCourseId,
  COURSE_ID_COMPACT_MAX_LENGTH,
} from '../src/index.js';

const TELEGRAM_CALLBACK_LIMIT = 64;
const MAX_HOST_SUFFIX = ':hostp' + 'z'.repeat(13);

function createLongTitle(idx) {
  const base = 'عنوان بسیار بسیار طولانی برای آزمون '.repeat(4);
  return `${base.trim()} ${idx}`;
}

test('buildCoursePage keeps callback_data within Telegram limit', () => {
  const courses = Array.from({ length: 9 }, (_, idx) => {
    const title = createLongTitle(idx + 1);
    const id = makeSlugFromTitle(title);
    const idSize = Buffer.byteLength(id, 'utf8');
    assert.ok(idSize <= COURSE_ID_MAX_LENGTH, `slug should respect limit (${idSize})`);
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
      const size = Buffer.byteLength(button.callback_data, 'utf8');
      assert.ok(
        size <= TELEGRAM_CALLBACK_LIMIT,
        `callback_data exceeded limit (${size}): ${button.callback_data}`
      );
    }
  }
});

test('buildCoursePage sanitizes multibyte course ids', () => {
  const rawId = '   دورهٔ ویژه/خاص 🚀 فارسی   ';
  const title = 'دوره فارسی';
  const courses = [{ id: rawId, title }];

  const { keyboard } = buildCoursePage({ courses, page: 1, rid: 'room1', hostSuffix: '' });

  const button = keyboard?.[0]?.[0];
  assert.ok(button?.callback_data, 'callback_data should exist');

  const parts = button.callback_data.split(':');
  const sanitizedId = parts[2];
  const expectedId = normalizeCourseId(rawId);

  assert.equal(sanitizedId, expectedId, 'course id should be normalized');
  assert.match(sanitizedId, /^[a-z0-9_-]+$/);
  assert.ok(Buffer.byteLength(sanitizedId, 'utf8') <= COURSE_ID_MAX_LENGTH);
});

test('makeSlugFromTitle creates safe slug for multibyte title', () => {
  const title = '   آزمون نهایی ویژه — ۱۲۳   ';
  const slug = makeSlugFromTitle(title);

  assert.match(slug, /^[a-z0-9_-]+$/);
  assert.ok(Buffer.byteLength(slug, 'utf8') <= COURSE_ID_MAX_LENGTH);
  assert.ok(slug.includes('-'), 'slug should include separator');
});

test('sanitizeShortCourseId generates compact id within limit', () => {
  const rawTitle = '   Advanced Physics Crash Course — Final 2024   ';
  const sanitized = sanitizeShortCourseId(rawTitle);

  assert.ok(sanitized, 'sanitized id should not be empty for ASCII-rich titles');
  assert.match(sanitized, /^[a-z0-9_-]+$/);
  assert.ok(
    Buffer.byteLength(sanitized, 'utf8') <= COURSE_ID_COMPACT_MAX_LENGTH,
    'sanitized id must respect compact limit'
  );
});

test('sanitizeShortCourseId trims overly long identifiers', () => {
  const longTitle = 'Mathematics Advanced Preparation Course For University Entrance Exams 2024';
  const sanitized = sanitizeShortCourseId(longTitle);

  assert.ok(sanitized);
  assert.ok(Buffer.byteLength(sanitized, 'utf8') <= COURSE_ID_COMPACT_MAX_LENGTH);
});
