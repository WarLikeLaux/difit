import { execFile, spawn } from 'child_process';
import { readFile, realpath, stat } from 'fs/promises';
import { join, resolve, sep } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const MAX_SEARCH_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 200;
const SEARCH_TIMEOUT_MS = 5000;

interface ProjectSearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface ProjectSearchResult {
  matches: ProjectSearchMatch[];
  truncated: boolean;
}

interface ProjectIgnore {
  paths: Set<string>;
  directoryPathspecs: string[];
}

async function readProjectIgnore(repositoryPath: string): Promise<ProjectIgnore> {
  const ignoreFile = join(repositoryPath, '.difitignore');
  let rules: string;
  try {
    rules = await readFile(ignoreFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { paths: new Set(), directoryPathspecs: [] };
    }
    throw error;
  }

  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--cached', '--others', '--ignored', `--exclude-from=${ignoreFile}`, '-z'],
    { cwd: repositoryPath, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 },
  );
  const paths = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout;
  const lines = rules.split(/\r?\n/).filter((rule) => rule && !rule.startsWith('#'));
  const directoryPathspecs: string[] = [];
  if (!lines.some((rule) => rule.startsWith('!'))) {
    for (const rule of lines) {
      if (!rule.endsWith('/') || ['\\', '*', '?', '[', ']'].some((char) => rule.includes(char)))
        continue;
      const directory = rule.replace(/^\//, '').replace(/\/$/, '');
      if (!directory) continue;
      const pattern = directory.includes('/') ? directory : `**/${directory}`;
      directoryPathspecs.push(`:(exclude,glob)${pattern}/**`);
    }
  }
  return {
    paths: new Set(paths.split('\0').filter(Boolean)),
    directoryPathspecs,
  };
}

export async function listProjectFiles(repositoryPath: string): Promise<string[]> {
  const ignored = await readProjectIgnore(repositoryPath);
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: repositoryPath, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 },
  );
  const paths = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout;
  const root = await realpath(repositoryPath);
  const candidates = [
    ...new Set(paths.split('\0').filter((path) => path && !ignored.paths.has(path))),
  ];
  const files: string[] = [];
  for (let index = 0; index < candidates.length; index += 100) {
    const batch = await Promise.all(
      candidates.slice(index, index + 100).map(async (path) => {
        try {
          const resolved = resolve(root, path);
          if (!resolved.startsWith(`${root}${sep}`)) return null;
          const actualPath = await realpath(resolved);
          if (!actualPath.startsWith(`${root}${sep}`)) return null;
          return (await stat(resolved)).isFile() ? path : null;
        } catch {
          return null;
        }
      }),
    );
    files.push(...batch.filter((path): path is string => path !== null));
  }
  return files.sort((a, b) => a.localeCompare(b));
}

export async function searchProjectCode(
  repositoryPath: string,
  query: string,
): Promise<ProjectSearchResult> {
  const pattern = query.trim();
  if (!pattern || pattern.length > 200 || /[\r\n\0]/.test(pattern)) {
    throw new Error('Search query must be 1–200 characters on one line');
  }
  const ignored = await readProjectIgnore(repositoryPath);

  return new Promise<ProjectSearchResult>((resolveResult, reject) => {
    const child = spawn(
      'git',
      [
        'grep',
        '--untracked',
        '--exclude-standard',
        '-n',
        '-I',
        '-F',
        '-i',
        '-z',
        '-m',
        '5',
        '-e',
        pattern,
        '--',
        '.',
        ...ignored.directoryPathspecs,
      ],
      { cwd: repositoryPath, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let truncated = false;
    let stderr = '';
    const timeout = setTimeout(() => {
      truncated = true;
      child.kill();
    }, SEARCH_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      const remaining = MAX_SEARCH_OUTPUT_BYTES - outputBytes;
      if (remaining > 0) {
        chunks.push(chunk.subarray(0, remaining));
        outputBytes += Math.min(chunk.length, remaining);
      }
      if (chunk.length > remaining) {
        truncated = true;
        child.kill();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(0, 1000);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (!truncated && code !== 0 && code !== 1) {
        reject(new Error(stderr || 'Project search failed'));
        return;
      }

      const output = Buffer.concat(chunks).toString('utf8');
      const matches: ProjectSearchMatch[] = [];
      let position = 0;
      while (matches.length < MAX_SEARCH_RESULTS) {
        const pathEnd = output.indexOf('\0', position);
        if (pathEnd < 0) break;
        const lineEnd = output.indexOf('\0', pathEnd + 1);
        if (lineEnd < 0) break;
        const textEnd = output.indexOf('\n', lineEnd + 1);
        if (textEnd < 0) break;
        const line = Number(output.slice(pathEnd + 1, lineEnd));
        const path = output.slice(position, pathEnd);
        if (Number.isInteger(line) && line > 0 && !ignored.paths.has(path)) {
          matches.push({
            path,
            line,
            text: output
              .slice(lineEnd + 1, textEnd)
              .replace(/\r$/, '')
              .slice(0, 500),
          });
        }
        position = textEnd + 1;
      }
      resolveResult({
        matches,
        truncated: truncated || (matches.length === MAX_SEARCH_RESULTS && position < output.length),
      });
    });
  });
}
