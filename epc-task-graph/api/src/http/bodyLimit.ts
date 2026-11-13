// リクエスト本文の上限。全量保存（PUT graph）が最大で、数千タスクでも数 MB に収まる想定。
export const MAX_BODY_BYTES = 20 * 1024 * 1024;

export function isBodyTooLarge(contentLength: string | null | undefined, text?: string): boolean {
  if (contentLength) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) return true;
  }
  // 文字数は UTF-8 バイト数の下限（1 文字 ≥ 1 バイト）なので、超過が確実な場合のみ打ち切る。
  return text !== undefined && text.length > MAX_BODY_BYTES;
}

export const PAYLOAD_TOO_LARGE_BODY = {
  error: { code: 'payload_too_large', message: 'データが大きすぎます（上限 20MB）' },
} as const;
