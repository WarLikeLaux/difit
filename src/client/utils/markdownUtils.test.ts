import { describe, expect, it } from 'vitest';

import { isSafeEmbeddedResourceUrl, isSafeUrl } from './markdownUtils';

describe('markdown URL safety', () => {
  it('allows explicit links but rejects protocol-relative and backslash URLs', () => {
    expect(isSafeUrl('https://example.com/docs')).toBe(true);
    expect(isSafeUrl('/docs')).toBe(true);
    expect(isSafeUrl('//attacker.example/docs')).toBe(false);
    expect(isSafeUrl('\\\\attacker.example\\docs')).toBe(false);
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
  });

  it('allows local image resources without allowing network requests', () => {
    expect(isSafeEmbeddedResourceUrl('/api/blob/image.png')).toBe(true);
    expect(isSafeEmbeddedResourceUrl('./image.png')).toBe(true);
    expect(isSafeEmbeddedResourceUrl('blob:https://difit.local/id')).toBe(true);
    expect(isSafeEmbeddedResourceUrl('data:image/png;base64,AAAA')).toBe(true);
    expect(isSafeEmbeddedResourceUrl('https://attacker.example/pixel.png')).toBe(false);
    expect(isSafeEmbeddedResourceUrl('//attacker.example/pixel.png')).toBe(false);
    expect(isSafeEmbeddedResourceUrl('data:image/svg+xml,<svg/>')).toBe(false);
  });
});
