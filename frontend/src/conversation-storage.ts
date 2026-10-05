import { conversationId } from './conversation-id';

/** Read and persist together so switching domains never writes the previous ID. */
export function storedConversation(owner: string, domain: string, fresh = false, storage?: Pick<Storage, 'getItem' | 'setItem'>): string {
  const key = 'lumina:conversation:' + owner + ':' + domain;
  let id = conversationId();
  try {
    const target = storage ?? sessionStorage;
    const saved = fresh ? null : target.getItem(key);
    if (saved && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved)) id = saved;
    target.setItem(key, id);
  } catch { /* Storage is optional, including on restricted browser profiles. */ }
  return id;
}
