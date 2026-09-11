type CommentAuthorLike = {
  author?: string;
};

export function getUniqueCommentAuthors(comments: CommentAuthorLike[]): string[] {
  const authors = new Set<string>();

  comments.forEach((comment) => {
    authors.add(comment.author?.trim() || 'Agent');
  });

  return [...authors];
}

export function hasMultipleCommentAuthors(comments: CommentAuthorLike[]): boolean {
  return getUniqueCommentAuthors(comments).length >= 2;
}
