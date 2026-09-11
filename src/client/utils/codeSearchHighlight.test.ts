import { describe, expect, it } from 'vitest';

import { findTextMatches } from './codeSearchHighlight';

describe('findTextMatches', () => {
  it('finds case-insensitive matches spanning syntax token elements', () => {
    const root = document.createElement('span');
    root.innerHTML = '<span>Config</span><span>/Stafler.php</span>';

    const ranges = findTextMatches(root, 'config/stafler');

    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.toString()).toBe('Config/Stafler');
  });

  it('finds every non-overlapping match', () => {
    const root = document.createElement('span');
    root.textContent = 'needle and NEEDLE';

    expect(findTextMatches(root, 'needle').map((range) => range.toString())).toEqual([
      'needle',
      'NEEDLE',
    ]);
  });
});
