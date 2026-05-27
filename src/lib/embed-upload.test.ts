import { describe, expect, it } from 'vitest'
import {
  buildKey,
  checkBearer,
  contentTypeForPath,
  isSafeRelativePath,
  SLUG_RE,
  timingSafeEqual,
  VERSION_RE,
} from './embed-upload'

describe('SLUG_RE', () => {
  it.each([
    ['cse-160-asg2', true],
    ['a', true],
    ['my-project-123', true],
    ['ABC', false],
    ['has spaces', false],
    ['has_underscore', false],
    ['', false],
    ['-leading-hyphen', false],
    ['x'.repeat(65), false],
  ])('matches %s -> %s', (input, expected) => {
    expect(SLUG_RE.test(input)).toBe(expected)
  })
})

describe('VERSION_RE', () => {
  it.each([
    ['abc1234', true],
    ['v1.2.3', true],
    ['main-2026-05-27', true],
    ['staging', true],
    ['has space', false],
    ['has/slash', false],
    ['', false],
    ['x'.repeat(41), false],
  ])('matches %s -> %s', (input, expected) => {
    expect(VERSION_RE.test(input)).toBe(expected)
  })
})

describe('isSafeRelativePath', () => {
  it.each([
    ['index.html', true],
    ['lib/cuon-matrix.js', true],
    ['assets/sky.jpg', true],
    ['', false],
    ['/abs', false],
    ['./relative', false],
    ['..', false],
    ['../escape', false],
    ['nested/../escape', false],
    ['back\\slash', false],
    ['has\u0000null', false],
    ['x'.repeat(257), false],
  ])('checks %s -> %s', (input, expected) => {
    expect(isSafeRelativePath(input)).toBe(expected)
  })
})

describe('timingSafeEqual', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
  })
  it('returns false for different strings', () => {
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
  })
  it('returns false for different-length strings', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
  })
  it('handles empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true)
  })
})

describe('checkBearer', () => {
  it('returns 503 when token unconfigured', () => {
    const r = checkBearer('Bearer x', undefined)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(503)
  })
  it('returns 401 with no header', () => {
    const r = checkBearer(null, 'secret')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(401)
  })
  it('returns 401 without Bearer prefix', () => {
    const r = checkBearer('Token secret', 'secret')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(401)
  })
  it('returns 401 on mismatch', () => {
    const r = checkBearer('Bearer wrong', 'secret')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(401)
  })
  it('returns ok on match', () => {
    const r = checkBearer('Bearer secret', 'secret')
    expect(r.ok).toBe(true)
  })
  it('tolerates trailing whitespace in header', () => {
    const r = checkBearer('Bearer secret  ', 'secret')
    expect(r.ok).toBe(true)
  })
})

describe('buildKey', () => {
  it('joins slug, version, and path', () => {
    expect(buildKey('cse-160', 'abc1234', 'asg2.html')).toBe('cse-160/abc1234/asg2.html')
  })
  it('handles nested paths', () => {
    expect(buildKey('cse-160', 'abc1234', 'lib/foo.js')).toBe('cse-160/abc1234/lib/foo.js')
  })
})

describe('contentTypeForPath', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['main.js', 'application/javascript; charset=utf-8'],
    ['app.wasm', 'application/wasm'],
    ['style.css', 'text/css; charset=utf-8'],
    ['photo.png', 'image/png'],
    ['video.mp4', 'video/mp4'],
    ['unknown', 'application/octet-stream'],
    ['UPPER.HTML', 'text/html; charset=utf-8'],
  ])('maps %s -> %s', (input, expected) => {
    expect(contentTypeForPath(input)).toBe(expected)
  })
})
