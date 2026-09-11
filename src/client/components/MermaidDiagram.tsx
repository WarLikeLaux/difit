import { useEffect, useId, useRef, useState } from 'react';
import DOMPurify from 'dompurify';

import { getResolvedTheme, type ResolvedTheme } from '../utils/appearanceTheme';

type MermaidDiagramProps = {
  chart: string;
};

type MermaidModule = typeof import('mermaid');

let mermaidModulePromise: Promise<MermaidModule> | null = null;

const loadMermaid = () => {
  mermaidModulePromise ??= import('mermaid');
  return mermaidModulePromise;
};

const getMermaidTheme = (theme: ResolvedTheme) => (theme === 'light' ? 'default' : 'dark');

const LOCAL_SVG_URI_PATTERN =
  /^(?:#|\/(?!\/)|\.\.?\/|data:image\/(?:png|jpeg|gif|webp|avif);base64,)/i;

export function MermaidDiagram({ chart }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const diagramId = useId().replace(/:/g, '-');
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => getResolvedTheme());
  const [error, setError] = useState<string | null>(null);
  const mermaidTheme = getMermaidTheme(resolvedTheme);

  useEffect(() => {
    const root = document.documentElement;
    const updateTheme = () => {
      const nextTheme = getResolvedTheme();
      setResolvedTheme((currentTheme) => (currentTheme === nextTheme ? currentTheme : nextTheme));
    };

    updateTheme();

    const observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.attributeName === 'data-theme')) {
        updateTheme();
      }
    });

    observer.observe(root, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    let isCancelled = false;
    const container = containerRef.current;

    const renderDiagram = async () => {
      if (!container) return;

      container.innerHTML = '';
      setError(null);

      try {
        const { default: mermaid } = await loadMermaid();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: mermaidTheme,
        });

        const { svg, bindFunctions } = await mermaid.render(`mermaid-diagram-${diagramId}`, chart);
        const sanitizedSvg = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
          FORBID_TAGS: ['script', 'iframe', 'object', 'embed'],
          ALLOWED_URI_REGEXP: LOCAL_SVG_URI_PATTERN,
          RETURN_TRUSTED_TYPE: false,
        });

        if (isCancelled) return;

        container.innerHTML = sanitizedSvg;
        bindFunctions?.(container);
      } catch (error) {
        if (isCancelled) return;

        container.innerHTML = '';

        setError(error instanceof Error ? error.message : 'Failed to render Mermaid diagram');
      }
    };

    void renderDiagram();

    return () => {
      isCancelled = true;
      if (container) {
        container.innerHTML = '';
      }
    };
  }, [chart, diagramId, mermaidTheme]);

  if (error) {
    return (
      <div className="space-y-2">
        <div className="text-sm text-github-danger" title={error}>
          Unable to render Mermaid diagram.
        </div>
        <pre className="markdown-preview-code whitespace-pre-wrap border border-github-border bg-github-bg-secondary p-3 overflow-x-auto text-sm font-mono text-github-text-primary">
          {chart}
        </pre>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      aria-label="Mermaid diagram"
      className="mermaid-diagram overflow-x-auto rounded border border-github-border bg-github-bg-secondary p-3"
    />
  );
}
