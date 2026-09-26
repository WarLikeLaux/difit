import { Highlight } from 'prism-react-renderer';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useHighlightedCode } from '../hooks/useHighlightedCode';
import { resolveApiUrl } from '../utils/apiUrl';
import { getPrismLanguageFromFilename } from '../utils/languageDetection';
import Prism from '../utils/prism';
import { getSyntaxTheme } from '../utils/syntaxThemes';

import { CodePreviewModal } from './CodePreviewModal';
import type { AppearanceSettings } from './SettingsModal';

interface ProjectFilePreviewProps {
  path: string;
  line?: number;
  syntaxTheme?: AppearanceSettings['syntaxTheme'];
  onClose: () => void;
}

const MAX_PREVIEW_CHARS = 500_000;

export function ProjectFilePreview({
  path,
  line,
  syntaxTheme = 'vsDark',
  onClose,
}: ProjectFilePreviewProps) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const language = getPrismLanguageFromFilename(path);
  const { actualLang } = useHighlightedCode(content ?? '', language);
  const theme = useMemo(() => getSyntaxTheme(syntaxTheme), [syntaxTheme]);

  useEffect(() => {
    const controller = new AbortController();
    setContent(null);
    setError(null);
    void fetch(resolveApiUrl(`/api/blob/${encodeURIComponent(path)}?ref=working`), {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not open this file from the current checkout');
        const text = await response.text();
        if (text.includes('\0')) throw new Error('Binary files cannot be previewed as code');
        if (text.length > MAX_PREVIEW_CHARS) throw new Error('This file is too large to preview');
        if (!controller.signal.aborted) setContent(text);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'Could not open this file');
        }
      });
    return () => controller.abort();
  }, [path]);

  const lines = useMemo(() => {
    if (content === null) return [];
    const result = content.split('\n');
    if (result.length > 1 && result[result.length - 1] === '') result.pop();
    return result;
  }, [content]);

  useEffect(() => {
    if (content === null || !line) return;
    const frame = requestAnimationFrame(() => {
      targetRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [content, line]);

  return (
    <CodePreviewModal
      filePath={line ? `${path}:${line}` : path}
      targetPosition={null}
      isLoading={content === null && error === null}
      onClose={onClose}
    >
      {error ? (
        <p role="alert" className="p-4 text-sm text-github-danger">
          {error}
        </p>
      ) : (
        content !== null && (
          <Highlight code={lines.join('\n')} language={actualLang} theme={theme} prism={Prism}>
            {({ tokens, getLineProps, getTokenProps }) => (
              <div className="min-w-max py-2 font-mono text-xs leading-5 text-github-text-primary">
                {tokens.map((tokensInLine, index) => {
                  const number = index + 1;
                  const lineProps = getLineProps({ line: tokensInLine });
                  return (
                    <div
                      {...lineProps}
                      key={number}
                      ref={number === line ? targetRef : undefined}
                      className={`flex min-h-5 ${number === line ? 'bg-github-accent/15' : ''}`}
                    >
                      <span className="sticky left-0 w-14 shrink-0 border-r border-github-border bg-github-bg-primary pr-3 text-right text-github-text-muted select-none">
                        {number}
                      </span>
                      <span className="whitespace-pre px-4">
                        {tokensInLine.map((token, tokenIndex) => (
                          <span key={tokenIndex} {...getTokenProps({ token })} />
                        ))}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </Highlight>
        )
      )}
    </CodePreviewModal>
  );
}
