import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// We test the registry + validate logic without a DOM.
// Card modules that call document.createElement are fine to import —
// we only call validate(), which is pure logic.

import { registerCard, getCard } from '../src/cards/registry.ts';
import { validateCard } from '../src/cards/validate.ts';
import imageCard from '../src/cards/kinds/image.ts';
import youtubeCard from '../src/cards/kinds/youtube.ts';
import spotifyCard from '../src/cards/kinds/spotify.ts';
import linksCard from '../src/cards/kinds/links.ts';
import markdownCard from '../src/cards/kinds/markdown.ts';
import loadingCard from '../src/cards/kinds/loading.ts';

// Register all cards
[imageCard, youtubeCard, spotifyCard, linksCard, markdownCard, loadingCard]
  .forEach(registerCard);

describe('envelope validation', () => {
  it('rejects non-objects', () => {
    assert.equal(validateCard(null).ok, false);
    assert.equal(validateCard('hello').ok, false);
    assert.equal(validateCard(42).ok, false);
  });

  it('rejects missing version', () => {
    const r = validateCard({ kind: 'image', payload: { url: 'x' } });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('version')));
  });

  it('rejects wrong version', () => {
    const r = validateCard({ v: 2, kind: 'image', payload: { url: 'x' } });
    assert.equal(r.ok, false);
  });

  it('rejects missing kind', () => {
    const r = validateCard({ v: 1, payload: {} });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('kind')));
  });

  it('rejects unknown kind', () => {
    const r = validateCard({ v: 1, kind: 'hologram', payload: {} });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('unknown')));
  });

  it('rejects missing payload', () => {
    const r = validateCard({ v: 1, kind: 'image' });
    assert.equal(r.ok, false);
  });
});

describe('image card validation', () => {
  it('accepts a valid image card', () => {
    const r = validateCard({
      v: 1, kind: 'image',
      payload: { url: 'https://example.com/cat.png', caption: 'A cat' },
    });
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
  });

  it('rejects image without url', () => {
    const r = validateCard({ v: 1, kind: 'image', payload: { caption: 'no url' } });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('url')));
  });
});

describe('youtube card validation', () => {
  it('accepts valid youtube card', () => {
    const r = validateCard({
      v: 1, kind: 'youtube',
      payload: { video_id: 'dQw4w9WgXcQ', url: 'https://youtube.com/watch?v=dQw4w9WgXcQ' },
    });
    assert.equal(r.ok, true);
  });

  it('rejects bad video_id', () => {
    const r = validateCard({
      v: 1, kind: 'youtube',
      payload: { video_id: 'ab', url: 'https://youtube.com/watch?v=ab' },
    });
    assert.equal(r.ok, false);
  });
});

describe('links card validation', () => {
  it('accepts valid links', () => {
    const r = validateCard({
      v: 1, kind: 'links',
      payload: { links: [{ url: 'https://bbc.com' }] },
    });
    assert.equal(r.ok, true);
  });

  it('rejects empty links array', () => {
    const r = validateCard({ v: 1, kind: 'links', payload: { links: [] } });
    assert.equal(r.ok, false);
  });
});

describe('markdown card validation', () => {
  it('accepts valid markdown', () => {
    const r = validateCard({
      v: 1, kind: 'markdown',
      payload: { text: '# Hello world' },
    });
    assert.equal(r.ok, true);
  });

  it('rejects empty text', () => {
    const r = validateCard({ v: 1, kind: 'markdown', payload: { text: '  ' } });
    assert.equal(r.ok, false);
  });
});

describe('loading card validation', () => {
  it('accepts empty payload', () => {
    const r = validateCard({ v: 1, kind: 'loading', payload: {} });
    assert.equal(r.ok, true);
  });
});
