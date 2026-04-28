/**
 * @fileoverview End-to-end pipeline test: fallback parser → validate → registry.
 * Proves the full card flow works without a DOM.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import { registerCard, getCard } from '../src/canvas/registry.ts';
import { validateCard } from '../src/canvas/validate.ts';
import { parseCardsFromText, extractImageBlocks } from '../src/canvas/fallback.ts';

import imageCard from '../src/canvas/cards/image.ts';
import youtubeCard from '../src/canvas/cards/youtube.ts';
import spotifyCard from '../src/canvas/cards/spotify.ts';
import linksCard from '../src/canvas/cards/links.ts';
import markdownCard from '../src/canvas/cards/markdown.ts';
import loadingCard from '../src/canvas/cards/loading.ts';

before(() => {
  [imageCard, youtubeCard, spotifyCard, linksCard, markdownCard, loadingCard]
    .forEach(m => { try { registerCard(m); } catch {} }); // ignore duplicate warnings
});

describe('full pipeline: parse → validate', () => {
  it('YouTube URL parses and validates', () => {
    const cards = parseCardsFromText('Watch https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(cards.length, 1);
    const result = validateCard(cards[0]);
    assert.equal(result.ok, true);
    assert.equal(result.card.kind, 'youtube');
    assert.equal(result.card.payload.video_id, 'dQw4w9WgXcQ');
  });

  it('Spotify URL parses and validates', () => {
    const cards = parseCardsFromText('Listen: https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC');
    assert.equal(cards.length, 1);
    const result = validateCard(cards[0]);
    assert.equal(result.ok, true);
    assert.equal(result.card.kind, 'spotify');
  });

  it('markdown image parses and validates', () => {
    const cards = parseCardsFromText('Look: ![cat](https://example.com/cat.jpg)');
    assert.equal(cards.length, 1);
    const result = validateCard(cards[0]);
    assert.equal(result.ok, true);
    assert.equal(result.card.kind, 'image');
    assert.equal(result.card.payload.url, 'https://example.com/cat.jpg');
  });

  it('generic URLs parse into valid links card', () => {
    const cards = parseCardsFromText('See https://bbc.com and https://nytimes.com');
    assert.equal(cards.length, 1);
    const result = validateCard(cards[0]);
    assert.equal(result.ok, true);
    assert.equal(result.card.kind, 'links');
    assert.equal(result.card.payload.links.length, 2);
  });

  it('mixed content parses into multiple validated cards', () => {
    const text = '![photo](https://example.com/a.jpg) and watch https://youtu.be/abc123abc1 also https://bbc.com';
    const cards = parseCardsFromText(text);
    assert.equal(cards.length, 3); // image + youtube + links
    for (const card of cards) {
      const result = validateCard(card);
      assert.equal(result.ok, true, `${card.kind} should validate`);
    }
  });

  it('agent image blocks validate through the pipeline', () => {
    const content = [
      { type: 'text', text: 'Here you go' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
    ];
    const cards = extractImageBlocks(content);
    assert.equal(cards.length, 1);
    const result = validateCard(cards[0]);
    assert.equal(result.ok, true);
    assert.ok(result.card.payload.url.startsWith('data:image/png;base64,'));
  });

  it('hand-crafted agent canvas.show payload validates', () => {
    // Sample payload an external CLI tool would emit
    const card = {
      v: 1,
      kind: 'markdown',
      payload: { text: '# Shopping List\n\n- Milk\n- Bread\n- Cheese' },
      meta: { title: 'Shopping List', source: 'agent' },
    };
    const result = validateCard(card);
    assert.equal(result.ok, true);
  });

  it('rejects malformed agent payloads', () => {
    const card = { v: 1, kind: 'image', payload: { caption: 'no url!' } };
    const result = validateCard(card);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('url')));
  });

  it('rejects unknown kinds gracefully', () => {
    const card = { v: 1, kind: 'hologram', payload: { data: '...' } };
    const result = validateCard(card);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes('unknown')));
  });
});
