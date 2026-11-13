import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodePrincipal, parsePrincipal } from '../src/auth/principal';
import { MAX_BODY_BYTES, isBodyTooLarge } from '../src/http/bodyLimit';
import { retryTransient } from '../src/store/retry';
import { SCHEMA_STATEMENTS } from '../src/store/schema';

const squash = (s: string): string => s.replace(/\s+/g, '');

describe('sql/schema.sql と SCHEMA_STATEMENTS の同期', () => {
  it('同じ DDL を含む', () => {
    const file = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
    const body = file
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('--') && l.trim().toUpperCase() !== 'GO')
      .join('\n');
    expect(squash(body)).toBe(squash(SCHEMA_STATEMENTS.join('\n')));
  });
});

describe('parsePrincipal', () => {
  it('email を小文字化し、name クレームを優先する', () => {
    const h = encodePrincipal({ userId: 'u1', userDetails: 'Foo@Example.COM', name: 'Foo Bar' });
    expect(parsePrincipal(h)).toEqual({ userId: 'u1', email: 'foo@example.com', name: 'Foo Bar' });
  });

  it('name クレームが無ければ userDetails を名前にする', () => {
    const h = encodePrincipal({ userId: 'u1', userDetails: 'foo@example.com' });
    expect(parsePrincipal(h)?.name).toBe('foo@example.com');
  });

  it('欠落・不正・匿名は null', () => {
    expect(parsePrincipal(undefined)).toBeNull();
    expect(parsePrincipal('')).toBeNull();
    expect(parsePrincipal('%%%')).toBeNull();
    const anon = Buffer.from(JSON.stringify({ userId: 'u', userDetails: 'a@b.c', userRoles: ['anonymous'] })).toString('base64');
    expect(parsePrincipal(anon)).toBeNull();
    const noUser = Buffer.from(JSON.stringify({ userDetails: 'a@b.c' })).toString('base64');
    expect(parsePrincipal(noUser)).toBeNull();
  });
});

describe('retryTransient（サーバーレス再開待ち）', () => {
  const resuming = Object.assign(new Error('Database is not currently available'), {
    originalError: { info: { number: 40613 } },
  });
  const fakeClock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it('一時的エラーは成功するまで再試行する', async () => {
    let calls = 0;
    const r = await retryTransient(
      async () => {
        if (++calls < 3) throw resuming;
        return 'ok';
      },
      fakeClock(),
    );
    expect(r).toBe('ok');
    expect(calls).toBe(3);
  });

  it('一時的でないエラーは即座に投げる', async () => {
    let calls = 0;
    const bad = Object.assign(new Error('Login failed'), { number: 18456 });
    await expect(
      retryTransient(async () => {
        calls++;
        throw bad;
      }, fakeClock()),
    ).rejects.toBe(bad);
    expect(calls).toBe(1);
  });

  it('時間予算を超えたら最後のエラーを投げる', async () => {
    let calls = 0;
    await expect(
      retryTransient(
        async () => {
          calls++;
          throw resuming;
        },
        { ...fakeClock(), budgetMs: 10_000, delaysMs: [4000] },
      ),
    ).rejects.toBe(resuming);
    expect(calls).toBe(3); // 0s, 4s, 8s（次は 12s > 予算）
  });
});

describe('isBodyTooLarge', () => {
  it('Content-Length または本文長が上限を超えた時だけ true', () => {
    expect(isBodyTooLarge(null, 'x')).toBe(false);
    expect(isBodyTooLarge('1024')).toBe(false);
    expect(isBodyTooLarge(String(MAX_BODY_BYTES + 1))).toBe(true);
    expect(isBodyTooLarge(null, 'x'.repeat(MAX_BODY_BYTES + 1))).toBe(true);
  });
});
