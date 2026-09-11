import { ExternalLink } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import { buildGitLabDiffLineUrl } from '../utils/gitlabLinks';

interface OpenInGitLabButtonProps {
  reviewUrl: string;
  filePath: string;
  lineFragment: string;
}

export const OpenInGitLabButton: React.FC<OpenInGitLabButtonProps> = React.memo(
  ({ reviewUrl, filePath, lineFragment }) => {
    const [href, setHref] = useState<string>();

    useEffect(() => {
      let active = true;
      void buildGitLabDiffLineUrl(reviewUrl, filePath, lineFragment).then((url) => {
        if (active) setHref(url);
      });

      return () => {
        active = false;
      };
    }, [filePath, lineFragment, reviewUrl]);

    if (!href) return null;

    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="absolute -right-10 top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded border border-github-border bg-github-bg-tertiary text-github-text-secondary transition-all duration-150 hover:scale-110 hover:bg-github-bg-primary hover:text-github-text-primary"
        data-open-in-gitlab-button="true"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        title="Open line in GitLab"
        aria-label="Open line in GitLab"
      >
        <ExternalLink className="h-4 w-4 opacity-80" />
      </a>
    );
  },
);

OpenInGitLabButton.displayName = 'OpenInGitLabButton';
