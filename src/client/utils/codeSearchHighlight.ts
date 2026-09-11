const HIGHLIGHT_NAME = 'diff-code-search';
const HIGHLIGHT_STYLE_ID = 'diff-code-search-highlight-style';

type HighlightRegistry = {
  delete: (name: string) => boolean;
  set: (name: string, highlight: Highlight) => void;
};

type HighlightApi = {
  highlights?: HighlightRegistry;
};

export function findTextMatches(root: HTMLElement, searchText: string): Range[] {
  const query = searchText.trim().toLowerCase();
  if (!query) return [];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let text = '';
  let currentNode = walker.nextNode();

  while (currentNode) {
    nodes.push(currentNode as Text);
    text += currentNode.textContent ?? '';
    currentNode = walker.nextNode();
  }

  const normalizedText = text.toLowerCase();
  const ranges: Range[] = [];
  let matchIndex = normalizedText.indexOf(query);

  while (matchIndex >= 0) {
    const matchEnd = matchIndex + query.length;
    let offset = 0;
    let startNode: Text | undefined;
    let endNode: Text | undefined;
    let startOffset = 0;
    let endOffset = 0;

    for (const node of nodes) {
      const nodeEnd = offset + node.length;
      if (!startNode && matchIndex < nodeEnd) {
        startNode = node;
        startOffset = matchIndex - offset;
      }
      if (matchEnd <= nodeEnd) {
        endNode = node;
        endOffset = matchEnd - offset;
        break;
      }
      offset = nodeEnd;
    }

    if (startNode && endNode) {
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      ranges.push(range);
    }

    matchIndex = normalizedText.indexOf(query, matchEnd);
  }

  return ranges;
}

export function updateCodeSearchHighlights(searchText: string): () => void {
  const css = CSS as typeof CSS & HighlightApi;
  css.highlights?.delete(HIGHLIGHT_NAME);

  if (!searchText.trim() || !css.highlights || typeof Highlight === 'undefined') {
    return () => undefined;
  }

  if (!document.getElementById(HIGHLIGHT_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = HIGHLIGHT_STYLE_ID;
    style.textContent = `::highlight(${HIGHLIGHT_NAME}) {
      color: inherit;
      background-color: rgba(255, 191, 0, 0.55);
    }`;
    document.head.appendChild(style);
  }

  const ranges = Array.from(
    document.querySelectorAll<HTMLElement>('[data-diff-code-content="true"]'),
  ).flatMap((element) => findTextMatches(element, searchText));

  if (ranges.length > 0) {
    css.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
  }

  return () => {
    css.highlights?.delete(HIGHLIGHT_NAME);
  };
}
