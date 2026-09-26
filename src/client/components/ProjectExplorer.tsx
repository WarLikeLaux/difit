import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { resolveApiUrl } from '../utils/apiUrl';

interface ProjectSearchMatch {
  path: string;
  line: number;
  text: string;
}

interface ProjectTreeNode {
  name: string;
  path: string;
  children: Map<string, ProjectTreeNode>;
  file: boolean;
}

interface ProjectExplorerProps {
  onOpenFile: (path: string, line?: number) => void;
  onFileSelected?: () => void;
  focusRequest?: number;
}

function buildTree(paths: string[]): ProjectTreeNode {
  const root: ProjectTreeNode = { name: '', path: '', children: new Map(), file: false };
  for (const path of paths) {
    let node = root;
    const segments = path.split('/');
    for (const [index, name] of segments.entries()) {
      const childPath = node.path ? `${node.path}/${name}` : name;
      let child = node.children.get(name);
      if (!child) {
        child = {
          name,
          path: childPath,
          children: new Map(),
          file: index === segments.length - 1,
        };
        node.children.set(name, child);
      }
      node = child;
    }
  }
  return root;
}

function sortedChildren(node: ProjectTreeNode): ProjectTreeNode[] {
  return [...node.children.values()].sort(
    (left, right) => Number(left.file) - Number(right.file) || left.name.localeCompare(right.name),
  );
}

export function ProjectExplorer({
  onOpenFile,
  onFileSelected,
  focusRequest = 0,
}: ProjectExplorerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [fileQuery, setFileQuery] = useState('');
  const [codeQuery, setCodeQuery] = useState('');
  const [matches, setMatches] = useState<ProjectSearchMatch[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildTree(files), [files]);
  const filteredFiles = useMemo(
    () => files.filter((path) => path.toLowerCase().includes(fileQuery.trim().toLowerCase())),
    [fileQuery, files],
  );

  useEffect(() => {
    if (focusRequest > 0) {
      fileInputRef.current?.focus();
      fileInputRef.current?.select();
    }
  }, [focusRequest]);

  useEffect(() => {
    const controller = new AbortController();
    setFilesLoading(true);
    setFilesError(null);
    void fetch(resolveApiUrl('/api/project/files'), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load project files');
        const data = (await response.json()) as { files: string[] };
        if (!controller.signal.aborted) setFiles(data.files);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setFilesError(error instanceof Error ? error.message : 'Could not load project files');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setFilesLoading(false);
      });
    return () => controller.abort();
  }, [refreshKey]);

  useEffect(() => {
    const query = codeQuery.trim();
    if (!query) {
      setMatches([]);
      setSearchError(null);
      setSearchLoading(false);
      setTruncated(false);
      return;
    }
    const controller = new AbortController();
    setSearchLoading(true);
    setSearchError(null);
    const timer = setTimeout(() => {
      void fetch(resolveApiUrl(`/api/project/search?q=${encodeURIComponent(query)}`), {
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error('Could not search project code');
          const data = (await response.json()) as {
            matches: ProjectSearchMatch[];
            truncated: boolean;
          };
          if (!controller.signal.aborted) {
            setMatches(data.matches);
            setTruncated(data.truncated);
          }
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            setSearchError(
              error instanceof Error ? error.message : 'Could not search project code',
            );
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearchLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [codeQuery]);

  const selectFile = (path: string, line?: number) => {
    onOpenFile(path, line);
    onFileSelected?.();
  };

  const renderNode = (node: ProjectTreeNode, depth: number): ReactNode => {
    if (node.file) {
      return (
        <button
          key={node.path}
          type="button"
          onClick={() => selectFile(node.path)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-github-text-primary hover:bg-github-bg-tertiary focus-visible:outline-2 focus-visible:outline-github-accent"
          style={{ paddingLeft: `${12 + depth * 16}px` }}
          title={node.path}
        >
          <FileText size={14} className="shrink-0 text-github-text-muted" />
          <span className="truncate">{node.name}</span>
        </button>
      );
    }
    const isExpanded = expanded.has(node.path);
    return (
      <div key={node.path}>
        <button
          type="button"
          onClick={() =>
            setExpanded((current) => {
              const next = new Set(current);
              if (next.has(node.path)) next.delete(node.path);
              else next.add(node.path);
              return next;
            })
          }
          aria-expanded={isExpanded}
          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-github-text-primary hover:bg-github-bg-tertiary focus-visible:outline-2 focus-visible:outline-github-accent"
          style={{ paddingLeft: `${12 + depth * 16}px` }}
          title={node.path}
        >
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />}
          <span className="truncate">{node.name}</span>
        </button>
        {isExpanded && sortedChildren(node).map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-github-border bg-github-bg-tertiary px-4 py-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h3 className="m-0 text-sm font-semibold text-github-text-primary">Project files</h3>
            <p className="m-0 text-xs text-github-text-muted">Current checkout</p>
          </div>
          <button
            type="button"
            onClick={() => setRefreshKey((key) => key + 1)}
            aria-label="Refresh project files"
            title="Refresh project files"
            className="rounded p-1 text-github-text-secondary hover:bg-github-bg-primary hover:text-github-text-primary"
          >
            <RefreshCw size={15} />
          </button>
        </div>
        <div className="space-y-2">
          <label className="relative block">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-github-text-muted"
            />
            <span className="sr-only">Find project file</span>
            <input
              ref={fileInputRef}
              type="search"
              value={fileQuery}
              onChange={(event) => setFileQuery(event.target.value)}
              placeholder="Find project file..."
              className="w-full rounded-md border border-github-border bg-github-bg-primary py-2 pl-9 pr-3 text-sm text-github-text-primary placeholder-github-text-muted focus:border-github-accent focus:outline-none"
            />
          </label>
          <label className="relative block">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-github-text-muted"
            />
            <span className="sr-only">Search project code</span>
            <input
              type="search"
              value={codeQuery}
              onChange={(event) => setCodeQuery(event.target.value)}
              maxLength={200}
              placeholder="Search project code..."
              className="w-full rounded-md border border-github-border bg-github-bg-primary py-2 pl-9 pr-3 text-sm text-github-text-primary placeholder-github-text-muted focus:border-github-accent focus:outline-none"
            />
          </label>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {filesLoading && <p className="px-4 text-xs text-github-text-secondary">Loading files…</p>}
        {filesError && (
          <p role="alert" className="px-4 text-xs text-github-danger">
            {filesError}
          </p>
        )}
        {!filesLoading && !filesError && codeQuery.trim() && (
          <>
            {searchLoading && <p className="px-4 text-xs text-github-text-secondary">Searching…</p>}
            {searchError && (
              <p role="alert" className="px-4 text-xs text-github-danger">
                {searchError}
              </p>
            )}
            {!searchLoading && !searchError && (
              <>
                <p className="px-4 pb-2 text-xs text-github-text-muted">
                  {matches.length} {truncated ? 'results shown, refine your search' : 'results'}
                </p>
                {matches.map((match) => (
                  <button
                    key={`${match.path}:${match.line}`}
                    type="button"
                    onClick={() => selectFile(match.path, match.line)}
                    className="w-full border-b border-github-border/60 px-4 py-2 text-left hover:bg-github-bg-tertiary focus-visible:outline-2 focus-visible:outline-github-accent"
                  >
                    <span
                      className="block truncate font-mono text-xs text-github-text-primary"
                      title={match.path}
                    >
                      {match.path}:{match.line}
                    </span>
                    <span className="block truncate font-mono text-xs text-github-text-secondary">
                      {match.text.trim()}
                    </span>
                  </button>
                ))}
              </>
            )}
          </>
        )}
        {!filesLoading && !filesError && !codeQuery.trim() && fileQuery.trim() && (
          <>
            <p className="px-4 pb-2 text-xs text-github-text-muted">
              {filteredFiles.length} files{' '}
              {filteredFiles.length > 300 ? 'found, showing first 300' : 'found'}
            </p>
            {filteredFiles.slice(0, 300).map((path) => (
              <button
                key={path}
                type="button"
                onClick={() => selectFile(path)}
                className="flex w-full items-center gap-2 px-4 py-1.5 text-left font-mono text-xs text-github-text-primary hover:bg-github-bg-tertiary focus-visible:outline-2 focus-visible:outline-github-accent"
                title={path}
              >
                <FileText size={14} className="shrink-0 text-github-text-muted" />
                <span className="truncate">{path}</span>
              </button>
            ))}
          </>
        )}
        {!filesLoading &&
          !filesError &&
          !codeQuery.trim() &&
          !fileQuery.trim() &&
          (files.length ? (
            sortedChildren(tree).map((node) => renderNode(node, 0))
          ) : (
            <p className="px-4 text-xs text-github-text-secondary">No project files found.</p>
          ))}
      </div>
    </div>
  );
}
