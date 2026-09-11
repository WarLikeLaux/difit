import { resolveApiUrl } from './apiUrl';

export function resolveEventSourceUrl(path: string): string {
  return resolveApiUrl(path);
}
