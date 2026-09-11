import type { DiffCommentMessage, DiffCommentThread } from '../../types/diff';

function isUserAuthor(author: string | undefined): boolean {
  return author?.trim().toLowerCase() === 'user';
}

export function findNewExternalMessages(
  currentThreads: DiffCommentThread[],
  nextThreads: DiffCommentThread[],
): DiffCommentMessage[] {
  const knownMessageIds = new Set(
    currentThreads.flatMap((thread) => thread.messages.map((message) => message.id)),
  );

  return nextThreads.flatMap((thread) =>
    thread.messages.filter(
      (message) => !knownMessageIds.has(message.id) && !isUserAuthor(message.author),
    ),
  );
}

export function showExternalMessageNotification(messages: DiffCommentMessage[]): void {
  if (
    messages.length === 0 ||
    typeof Notification === 'undefined' ||
    Notification.permission !== 'granted'
  ) {
    return;
  }

  const latestMessage = messages.at(-1);
  if (!latestMessage) return;

  const title =
    messages.length === 1 ? 'New agent reply in difit' : `${messages.length} new replies in difit`;
  const notification = new Notification(title, {
    body: latestMessage.body,
    tag: `difit-comment-${latestMessage.id}`,
  });
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}
