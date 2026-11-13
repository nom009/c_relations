// ローカル開発・E2E 用サーバー（Functions を使わず同じハンドラをそのまま公開）。データはメモリのみ。
import { createServer } from 'node:http';
import { PRINCIPAL_HEADER, encodePrincipal } from '../src/auth/principal';
import { handle } from '../src/http/router';
import { MemoryStore } from '../src/store/memoryStore';

const port = Number(process.env.PORT) || 7071;
const store = new MemoryStore();
const devEmail = process.env.DEV_USER_EMAIL?.trim();

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const raw = Buffer.concat(chunks).toString('utf8');
      const send = (status: number, body?: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body === undefined ? undefined : JSON.stringify(body));
      };
      let body: unknown;
      if (raw.trim()) {
        try {
          body = JSON.parse(raw) as unknown;
        } catch {
          send(400, { error: { code: 'bad_request', message: 'JSON の形式が不正です' } });
          return;
        }
      }
      const header = req.headers[PRINCIPAL_HEADER];
      let principalHeader = Array.isArray(header) ? header[0] : header;
      if (!principalHeader && devEmail) principalHeader = encodePrincipal({ userId: `dev-${devEmail}`, userDetails: devEmail });
      const query: Record<string, string | undefined> = {};
      url.searchParams.forEach((v, k) => {
        query[k] = v;
      });
      const out = await handle(
        { method: req.method ?? 'GET', path: url.pathname, query, body, principalHeader },
        () => store,
      );
      send(out.status, out.body);
    })();
  });
});

server.listen(port, () => {
  console.log(`api dev server listening on ${port}`);
});
