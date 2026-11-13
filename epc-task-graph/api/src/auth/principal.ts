// SWA が付与する x-ms-client-principal（base64 JSON）を解釈する。
// マネージド Functions は SWA 経由でしか呼べないため、本番ではこのヘッダーを信頼してよい。
export interface Principal {
  userId: string;
  email: string; // 小文字化済み（メンバー照合キー）
  name: string;
}

export const PRINCIPAL_HEADER = 'x-ms-client-principal';

const NAME_CLAIMS = new Set(['name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name']);

export function parsePrincipal(header: string | null | undefined): Principal | null {
  if (!header) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.userId !== 'string' || !p.userId) return null;
  if (typeof p.userDetails !== 'string' || !p.userDetails.trim()) return null;
  // ロールが明示されていて authenticated を含まない場合は未ログイン扱い（anonymous のみ等）。
  if (Array.isArray(p.userRoles) && p.userRoles.length > 0 && !p.userRoles.includes('authenticated')) return null;

  const email = p.userDetails.trim().toLowerCase();
  let name = p.userDetails.trim();
  if (Array.isArray(p.claims)) {
    for (const c of p.claims) {
      if (c && typeof c === 'object') {
        const { typ, val } = c as { typ?: unknown; val?: unknown };
        if (typeof typ === 'string' && NAME_CLAIMS.has(typ) && typeof val === 'string' && val.trim()) {
          name = val.trim();
          break;
        }
      }
    }
  }
  return { userId: p.userId, email, name };
}

// テスト・開発サーバー用: Principal からヘッダー値を作る。
export function encodePrincipal(p: { userId: string; userDetails: string; name?: string }): string {
  const body = {
    identityProvider: 'aad',
    userId: p.userId,
    userDetails: p.userDetails,
    userRoles: ['anonymous', 'authenticated'],
    claims: p.name ? [{ typ: 'name', val: p.name }] : [],
  };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
}
