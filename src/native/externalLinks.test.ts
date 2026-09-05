import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { externalLinkTarget } from './externalLinks.ts';

const CAP = 'capacitor://localhost';

describe('externalLinkTarget (Capacitor shell)', () => {
  it('routes http(s) links off our origin to the native browser', () => {
    assert.equal(externalLinkTarget('https://example.com/a?b=1', CAP), 'https://example.com/a?b=1');
    assert.equal(externalLinkTarget('http://news.site/x', CAP), 'http://news.site/x');
  });
  it('leaves same-origin, hash, and non-http links to the web view', () => {
    assert.equal(externalLinkTarget('capacitor://localhost/?msg=abc', CAP), null);
    assert.equal(externalLinkTarget('?msg=abc', CAP), null);
    assert.equal(externalLinkTarget('#top', CAP), null);
    assert.equal(externalLinkTarget('mailto:a@b.c', CAP), null);
    assert.equal(externalLinkTarget('tel:+441234', CAP), null);
    assert.equal(externalLinkTarget('', CAP), null);
    assert.equal(externalLinkTarget(null, CAP), null);
  });
  it('in a normal browser origin, links back to the app stay internal', () => {
    assert.equal(externalLinkTarget('https://parley.example/?msg=1', 'https://parley.example'), null);
    assert.equal(externalLinkTarget('https://other.example/', 'https://parley.example'), 'https://other.example/');
  });
});
