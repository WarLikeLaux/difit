const REVIEW_PATH_PATTERN = /^(\/reviews\/[^/]+)/;

export function getReviewBasePath(pathname = window.location.pathname): string {
  return pathname.match(REVIEW_PATH_PATTERN)?.[1] ?? '';
}

export function resolveApiUrl(path: string): string {
  const apiUrl = import.meta.env.VITE_DIFIT_API_URL?.trim();
  if (apiUrl) {
    try {
      return new URL(path, apiUrl).toString();
    } catch {
      return path;
    }
  }

  return `${getReviewBasePath()}${path}`;
}

export function getReviewsDashboardUrl(): string | null {
  return getReviewBasePath() ? '/' : null;
}
