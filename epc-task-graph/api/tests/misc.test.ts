import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodePrincipal, parsePrincipal } from '../src/auth/principal';
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
