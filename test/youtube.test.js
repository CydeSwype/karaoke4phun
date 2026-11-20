import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVideoId } from '../server/youtube.js';

test('parses the common YouTube link shapes', () => {
  const id = 'dQw4w9WgXcQ';
  for (const url of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://m.youtube.com/watch?v=${id}&t=30s`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}?si=abc`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}`,
    id,
  ]) {
    assert.equal(parseVideoId(url), id, url);
  }
});

test('plain search text is not treated as a video id', () => {
  assert.equal(parseVideoId('hotel california'), null);
  assert.equal(parseVideoId('Desperadoes'), null);
  assert.equal(parseVideoId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
});
