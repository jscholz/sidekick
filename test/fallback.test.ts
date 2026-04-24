import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCardsFromText, extractImageBlocks } from '../src/canvas/fallback.ts';

describe('parseCardsFromText', () => {
  it('extracts markdown images', () => {
    const cards = parseCardsFromText('Here: ![A cat](https://example.com/cat.png) enjoy');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].kind, 'image');
    assert.equal(cards[0].payload.url, 'https://example.com/cat.png');
    assert.equal(cards[0].payload.caption, 'A cat');
  });

  it('extracts YouTube URLs', () => {
    const cards = parseCardsFromText('Watch this: https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].kind, 'youtube');
    assert.equal(cards[0].payload.video_id, 'dQw4w9WgXcQ');
  });

  it('extracts youtu.be short URLs', () => {
    const cards = parseCardsFromText('Check https://youtu.be/dQw4w9WgXcQ');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].kind, 'youtube');
  });

  it('extracts Spotify URLs', () => {
    const cards = parseCardsFromText('Listen: https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].kind, 'spotify');
    assert.equal(cards[0].payload.resource_type, 'track');
    assert.ok(cards[0].payload.embed_url.includes('/embed/track/'));
  });

  it('groups generic URLs into one links card', () => {
    const cards = parseCardsFromText('See https://bbc.com and https://cnn.com for news.');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].kind, 'links');
    assert.equal(cards[0].payload.links.length, 2);
  });

  it('classifies YouTube before generic links (no duplicates)', () => {
    const cards = parseCardsFromText(
      'Here is a video: https://www.youtube.com/watch?v=dQw4w9WgXcQ and also https://bbc.com'
    );
    assert.equal(cards.length, 2);
    assert.equal(cards[0].kind, 'youtube');
    assert.equal(cards[1].kind, 'links');
    assert.equal(cards[1].payload.links.length, 1);
  });

  it('deduplicates same URL', () => {
    const cards = parseCardsFromText(
      'https://bbc.com mentioned twice https://bbc.com'
    );
    assert.equal(cards.length, 1);
    assert.equal(cards[0].payload.links.length, 1);
  });

  it('returns empty for text with no URLs', () => {
    const cards = parseCardsFromText('Just a plain message with no links.');
    assert.equal(cards.length, 0);
  });

  it('strips trailing punctuation from URLs', () => {
    const cards = parseCardsFromText('See https://bbc.com.');
    assert.equal(cards[0].payload.links[0].url, 'https://bbc.com/');
  });

  it('strips angle brackets from URLs like <url>', () => {
    const cards = parseCardsFromText('Link: <https://www.nytimes.com/2026/article.html>');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].payload.links[0].url, 'https://www.nytimes.com/2026/article.html');
  });

  it('handles markdown link syntax [text](url)', () => {
    const cards = parseCardsFromText('Read [this article](https://bbc.com/news) for details.');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].kind, 'links');
    assert.equal(cards[0].payload.links[0].url, 'https://bbc.com/news');
  });

  it('all cards have v:1 and meta.source=fallback', () => {
    const cards = parseCardsFromText('![img](https://x.com/i.png) https://youtube.com/watch?v=abc123abc1');
    for (const c of cards) {
      assert.equal(c.v, 1);
      assert.equal(c.meta.source, 'fallback');
    }
  });
});

describe('extractImageBlocks', () => {
  it('extracts Anthropic-style base64 images', () => {
    const content = [{
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBOR...' },
    }];
    const cards = extractImageBlocks(content);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].kind, 'image');
    assert.ok(cards[0].payload.url.startsWith('data:image/png;base64,'));
  });

  it('extracts URL-based images', () => {
    const content = [{ type: 'image', url: 'https://example.com/pic.jpg' }];
    const cards = extractImageBlocks(content);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].payload.url, 'https://example.com/pic.jpg');
  });

  it('skips non-image blocks', () => {
    const content = [
      { type: 'text', text: 'hello' },
      { type: 'image', url: 'https://example.com/pic.jpg' },
    ];
    const cards = extractImageBlocks(content);
    assert.equal(cards.length, 1);
  });

  it('returns empty for no images', () => {
    const cards = extractImageBlocks([{ type: 'text', text: 'hi' }]);
    assert.equal(cards.length, 0);
  });

  it('handles null/undefined content', () => {
    assert.equal(extractImageBlocks(null).length, 0);
    assert.equal(extractImageBlocks(undefined).length, 0);
  });
});
