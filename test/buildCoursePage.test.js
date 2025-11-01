import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCoursePage, makeSlugFromTitle, COURSE_ID_MAX_LENGTH } from '../src/index.js';

const TELEGRAM_CALLBACK_LIMIT = 64;
const MAX_HOST_SUFFIX = ':hostp' + 'z'.repeat(13);

function createLongTitle(idx) {
  const base = 'Extremely lengthy course title for testing '.repeat(2);
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
      const byteLength = Buffer.byteLength(button.callback_data, 'utf8');
      assert.ok(
        byteLength <= TELEGRAM_CALLBACK_LIMIT,
        `callback_data exceeded limit (${byteLength}): ${button.callback_data}`
      );
    }
  }
});

test('buildCoursePage enforces byte limit for Persian slugs with host suffix', () => {
  const title = 'عنوان بسیار بسیار طولانی برای آزمون با حروف فارسی';
  const id = makeSlugFromTitle(title);
  const rid = 'abcdefgh';
  const hostSuffix = MAX_HOST_SUFFIX;
  const callback = `c:${rid}:${id}${hostSuffix}`;

  let threw = false;
  try {
    buildCoursePage({
      courses: [{ id, title }],
      page: 1,
      rid,
      hostSuffix,
      pageSize: 1,
    });
  } catch (error) {
    threw = true;
    const byteLength = Buffer.byteLength(callback, 'utf8');
    assert.ok(byteLength > TELEGRAM_CALLBACK_LIMIT, `expected setup to exceed ${TELEGRAM_CALLBACK_LIMIT} bytes (${byteLength})`);
    assert.match(
      error?.message || '',
      /callback_data exceeds 64 bytes/,
      'error message should report byte limit'
    );
    assert.ok(
      error?.message?.includes(String(byteLength)),
      'error message should include computed byte length'
    );
  }

  assert.ok(threw, 'expected Persian slug with host suffix to exceed Telegram byte limit');
});
