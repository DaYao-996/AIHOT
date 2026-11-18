import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, test } from 'node:test';
import { config } from '@aihot/backend/config';
import { sql, closeDb } from '@aihot/backend/db';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { collectSource } from '@aihot/backend/sources/collect';
import { previewSource } from '@aihot/backend/admin/sources';

const T = tag();
let version = 1;
let broken = false;
let redirectNew = false;
const requests: Array<{ path: string; etag?: string; modified?: string }> = [];
const modified = 'Mon, 28 Sep 2026 10:00:00 GMT';
const server = http.createServer((req, res) => {
  const path = req.url ?? '/';
  requests.push({ path, etag: req.headers['if-none-match'], modified: req.headers['if-modified-since'] });
  if (path === '/redirect') { res.writeHead(302, { location: redirectNew ? '/new.xml' : '/old.xml' }); res.end(); return; }
  if (path === '/atom-updated.xml') {
    res.writeHead(200, { 'content-type': 'application/atom+xml' });
    res.end(`<feed xmlns="http://www.w3.org/2005/Atom"><id>urn:test</id><title>Feed</title><updated>2026-10-01T00:00:00Z</updated><entry><id>urn:only-updated-${T}</id><title>Only updated</title><updated>2026-11-02T03:04:05Z</updated><link href="https://example.org/only-updated-${T}"/></entry></feed>`);
    return;
  }
  const etag = path === '/modified.xml' ? undefined : path === '/feed.xml' ? `"v${version}"` : '"shared"';
  if ((etag && req.headers['if-none-match'] === etag) || (!etag && req.headers['if-modified-since'] === modified)) {
    res.writeHead(304, { ...(etag ? { etag } : {}), 'last-modified': modified }); res.end(); return;
  }
  const entries = Array.from({ length: path === '/feed.xml' ? 40 : 1 }, (_, i) =>
    `<item><title>Entry ${i} ${path === '/feed.xml' && i === 0 ? version : path} ${T}</title><link>https://example.org/rss-conditional-${T}/${path.replaceAll('/', '')}/${i}</link><pubDate>${new Date(Date.now() - 1000 * i).toUTCString()}</pubDate></item>`).join('');
  res.writeHead(200, { 'content-type': 'application/rss+xml', ...(etag ? { etag } : {}), 'last-modified': modified });
  res.end(broken ? '<not-feed/>' : `<rss version="2.0"><channel><title>Feed</title>${entries}</channel></rss>`);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await stopBoss(); await closeDb(); });
async function source(id: string, path: string, initialized = true) {
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,cursor,next_fetch_at)
    VALUES (${id},'RSS conditional test','rss',${sql.json({ feedUrl: base + path })},'T1','editorial',${initialized ? sql.json({ initializedAt: new Date().toISOString() }) : null},'2100-01-01')`;
}
const cursor = async (id: string) => (await sql`SELECT cursor FROM sources WHERE id=${id}`)[0]!.cursor;

test('RSS first backfill, ordinary window, 304, revision and config edits preserve collection behavior', async () => {
  const id = `rss-conditional-${T}`;
  await source(id, '/feed.xml', false);
  assert.equal((await collectSource(id)).created, 30);
  assert.equal((await cursor(id)).rss, undefined, 'the first backfill cap must not freeze the ordinary window');
  assert.equal((await collectSource(id)).created, 10);
  assert.equal((await cursor(id)).rss.etag, '"v1"');
  const third = await collectSource(id);
  assert.deepEqual([third.status, third.found, third.created, third.revised], ['ok', 0, 0, 0]);
  assert.equal(requests.at(-1)!.etag, '"v1"');
  const [run] = await sql`SELECT detail FROM fetch_runs WHERE source_id=${id} ORDER BY id DESC LIMIT 1`;
  assert.deepEqual({ notModified: run!.detail.notModified, httpStatus: run!.detail.httpStatus }, { notModified: true, httpStatus: 304 });
  const [healthy] = await sql`SELECT health,fail_count FROM sources WHERE id=${id}`;
  assert.deepEqual({ ...healthy }, { health: 'ok', fail_count: 0 });
  version = 2;
  assert.equal((await collectSource(id)).revised, 1, 'a changed feed is parsed and stored normally');
  await sql`UPDATE sources SET config=config || '{"summaryIsBody":true}'::jsonb WHERE id=${id}`;
  assert.equal((await collectSource(id)).status, 'ok');
  assert.equal(requests.at(-1)!.etag, undefined, 'config edits must reprocess unchanged bytes');
  await collectSource(id, { force: true });
  assert.equal(requests.at(-1)!.etag, undefined, 'manual recollection bypasses validation');
  const [saved] = await sql`SELECT id,kind,config,cursor FROM sources WHERE id=${id}`;
  assert.equal((await previewSource(saved as never)).count, 40, 'preview still returns items for an unchanged feed');
  assert.equal(requests.at(-1)!.etag, undefined);
  const beforeFailure = await cursor(id);
  version = 3; broken = true;
  assert.equal((await collectSource(id)).status, 'failed');
  assert.deepEqual(await cursor(id), beforeFailure, 'failed parsing never advances the success validator');
  broken = false;
  assert.equal((await collectSource(id)).revised, 1);
  assert.equal(requests.at(-1)!.etag, '"v2"');
});

test('Last-Modified works without ETag and changing redirect targets cannot accept an unrelated 304', async () => {
  const lm = `rss-modified-${T}`;
  await source(lm, '/modified.xml');
  assert.equal((await collectSource(lm)).created, 1);
  assert.equal((await collectSource(lm)).found, 0);
  assert.equal(requests.at(-1)!.modified, modified);
  const redirect = `rss-redirect-${T}`;
  await source(redirect, '/redirect');
  assert.equal((await collectSource(redirect)).created, 1);
  redirectNew = true;
  assert.equal((await collectSource(redirect)).created, 1, 'new destination is fetched without old destination validators');
  assert.equal(requests.at(-1)!.path, '/new.xml');
  assert.equal(requests.at(-1)!.etag, undefined);
});

test('a collected listing keeps its response bytes bound to the parsed output', async () => {
  const id = `rss-bytes-${T}`;
  const before = requests.length;
  await source(id, '/bytes.xml');
  assert.equal((await collectSource(id)).created, 1);
  assert.equal(requests.length - before, 1);
  const [run] = await sql<{ sha: string; n: number; raw_sha: string; requests: number; parsed: string }[]>`
    SELECT encode(sha256(response), 'hex') AS sha, octet_length(response)::int AS n,
      detail->'response'->>'rawSha256' AS raw_sha, (detail->'response'->>'requests')::int AS requests,
      detail->'response'->>'parsedSha256' AS parsed
    FROM fetch_runs WHERE source_id = ${id} ORDER BY id DESC LIMIT 1`;
  assert.equal(run!.sha, run!.raw_sha);
  assert.equal(run!.requests, 1);
  assert.ok(run!.parsed);
  assert.ok(run!.n > 0);
});

test('Atom updated is stored as the feed field and not as the publication time', async () => {
  const id = `atom-updated-${T}`;
  const before = requests.length;
  await source(id, '/atom-updated.xml');
  assert.equal((await collectSource(id)).created, 1);
  assert.equal(requests.length - before, 1);
  const [row] = await sql<{ published_at: Date | null; publication_time: string | null; source_updated_at: Date | null; raw: { timeSource: string; updated: string; publicationPrecision: string } }[]>`
    SELECT published_at, publication_time, source_updated_at, raw FROM articles WHERE source_id = ${id}`;
  assert.equal(row!.published_at, null);
  assert.equal(row!.publication_time, null);
  assert.equal(row!.source_updated_at?.toISOString(), '2026-11-02T03:04:05.000Z');
  assert.equal(row!.raw.timeSource, 'atom:updated');
  assert.equal(row!.raw.updated, '2026-11-02T03:04:05Z');
  assert.equal(row!.raw.publicationPrecision, 'unknown');
});
