export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: string[],
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const unauthorized = (): HttpError => new HttpError(401, 'unauthorized', 'ログインが必要です');
export const forbidden = (): HttpError => new HttpError(403, 'forbidden', 'この操作を行う権限がありません');
export const notFound = (what = 'リソース'): HttpError => new HttpError(404, 'not_found', `${what}が見つかりません`);
export const badRequest = (message: string): HttpError => new HttpError(400, 'bad_request', message);
export const invalid = (message: string, details?: string[]): HttpError =>
  new HttpError(422, 'validation_failed', message, details);

// ストレージ構成不備（接続文字列なし等）。データを黙って失わないよう 500 で明示的に失敗させる。
export class StoreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreConfigError';
  }
}

// 同時作成などで主キー重複になった場合（SQL 2627/2601）。
export class DuplicateKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateKeyError';
  }
}
