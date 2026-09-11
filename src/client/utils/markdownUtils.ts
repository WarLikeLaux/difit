import React from 'react';

import { getFileExtension } from '../../utils/fileUtils';

const MARKDOWN_EXTENSIONS = ['md', 'markdown'];

export function isMarkdownFile(filename: string): boolean {
  if (!filename) return false;

  const extension = getFileExtension(filename);
  return extension ? MARKDOWN_EXTENSIONS.includes(extension) : false;
}

export const isSafeUrl = (url: string) => {
  const value = url.trim();
  if (!value || value.startsWith('//') || value.includes('\\')) return false;
  return /^(https?:|mailto:|#|\.\/|\.\.\/|\/)/i.test(value);
};

export const isSafeEmbeddedResourceUrl = (url: string) => {
  const value = url.trim();
  if (!value || value.startsWith('//') || value.includes('\\')) return false;
  return (
    /^(\.\/|\.\.\/|\/)/.test(value) ||
    /^blob:/i.test(value) ||
    /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(value)
  );
};

export const isElementWithCodeProps = (
  node: React.ReactNode,
): node is React.ReactElement<{
  className?: string;
  children?: React.ReactNode;
}> => React.isValidElement(node);

const isElementWithChildren = (
  node: React.ReactNode,
): node is React.ReactElement<{ children?: React.ReactNode }> => React.isValidElement(node);

export const extractMarkdownText = (node: React.ReactNode): string => {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractMarkdownText).join('');
  }
  if (isElementWithChildren(node)) {
    return extractMarkdownText(node.props.children);
  }
  return '';
};
