import assert from "node:assert/strict";
import test from "node:test";
import { buildNoteFile } from "./frontmatter";
import {
  contentMatchesStoredHash,
  decidePullAction,
  hashNoteForSync,
  noteFingerprint,
  notesSemanticallyEqual,
  remoteIsNewer,
} from "./syncState";

function wikiNote(over: Record<string, unknown> = {}, body = "Hello world.\n"): string {
  return buildNoteFile(
    {
      backdrop_type: "wiki",
      backdrop_id: "11111111-1111-1111-1111-111111111111",
      backdrop_world: "westhollow",
      backdrop_slug: "hello",
      title: "Hello",
      category: "general",
      status: "published",
      summary: "",
      backdrop_updated_at: "2026-08-10T01:00:00.000Z",
      backdrop_synced_at: "2026-08-14T04:00:00.000Z",
      ...over,
    },
    body
  );
}

test("fingerprint ignores timestamps, CRLF, trailing space, empty arrays", () => {
  const a = wikiNote({ characters: [], parent_article_id: "" }, "Body\r\nline 2  \r\n");
  const b = wikiNote(
    {
      backdrop_synced_at: "2026-08-16T00:00:00.000Z",
      backdrop_updated_at: "2026-08-16T00:00:00.000Z",
      discord_sync_enabled: true,
    },
    "Body\nline 2\n"
  );
  assert.equal(noteFingerprint(a), noteFingerprint(b));
  assert.equal(hashNoteForSync(a), hashNoteForSync(b));
});

test("legacy full-file hash still matches after newline normalize", () => {
  const lf = wikiNote();
  const crlf = lf.replace(/\n/g, "\r\n");
  const stored = hashNoteForSync(lf);
  assert.equal(contentMatchesStoredHash(crlf, stored), true);
});

test("body edit changes fingerprint", () => {
  const a = wikiNote({}, "One\n");
  const b = wikiNote({}, "Two\n");
  assert.equal(notesSemanticallyEqual(a, b), false);
});

test("remoteIsNewer uses 1.5s skew", () => {
  assert.equal(remoteIsNewer("2026-08-14T04:00:00.000Z", "2026-08-14T04:00:01.000Z"), false);
  assert.equal(remoteIsNewer("2026-08-14T04:00:00.000Z", "2026-08-14T04:00:02.000Z"), true);
});

test("clean local + remote newer → overwrite", () => {
  const local = wikiNote();
  const remote = wikiNote({ backdrop_updated_at: "2026-08-16T01:00:00.000Z" }, "Server edit\n");
  const d = decidePullAction({
    localContent: local,
    storedHash: hashNoteForSync(local),
    localSyncedAt: "2026-08-14T04:00:00.000Z",
    remoteUpdatedAt: "2026-08-16T01:00:00.000Z",
    remoteContent: remote,
  });
  assert.equal(d.action, "overwrite");
});

test("clean local + remote not newer + same content → skip-unchanged", () => {
  const local = wikiNote();
  const d = decidePullAction({
    localContent: local,
    storedHash: hashNoteForSync(local),
    localSyncedAt: "2026-08-14T04:00:00.000Z",
    remoteUpdatedAt: "2026-08-10T01:00:00.000Z",
    remoteContent: local,
  });
  assert.equal(d.action, "skip-unchanged");
});

test("mtime-style false dirty: hash matches, same content, even if remote stamp is newer → stamp not conflict", () => {
  const local = wikiNote();
  const remote = wikiNote({
    backdrop_updated_at: "2026-08-16T01:00:00.000Z",
    backdrop_synced_at: "2026-08-16T01:00:00.000Z",
  });
  const d = decidePullAction({
    localContent: local,
    storedHash: hashNoteForSync(local),
    localSyncedAt: "2026-08-14T04:00:00.000Z",
    remoteUpdatedAt: "2026-08-16T01:00:00.000Z",
    remoteContent: remote,
  });
  assert.equal(d.action, "stamp");
});

test("local body edit + remote unchanged → skip-dirty, not conflict", () => {
  const base = wikiNote();
  const local = wikiNote({}, "My local draft\n");
  const d = decidePullAction({
    localContent: local,
    storedHash: hashNoteForSync(base),
    localSyncedAt: "2026-08-14T04:00:00.000Z",
    remoteUpdatedAt: "2026-08-10T01:00:00.000Z",
    remoteContent: base,
  });
  assert.equal(d.action, "skip-dirty");
});

test("local body edit + remote newer + different content → conflict", () => {
  const base = wikiNote();
  const local = wikiNote({}, "My local draft\n");
  const remote = wikiNote({ backdrop_updated_at: "2026-08-16T01:00:00.000Z" }, "Server edit\n");
  const d = decidePullAction({
    localContent: local,
    storedHash: hashNoteForSync(base),
    localSyncedAt: "2026-08-14T04:00:00.000Z",
    remoteUpdatedAt: "2026-08-16T01:00:00.000Z",
    remoteContent: remote,
  });
  assert.equal(d.action, "conflict");
});

test("stale/missing hash but local equals remote → not a conflict", () => {
  const local = wikiNote();
  const d = decidePullAction({
    localContent: local,
    storedHash: undefined,
    localSyncedAt: "2026-08-14T04:00:00.000Z",
    remoteUpdatedAt: "2026-08-16T01:00:00.000Z",
    remoteContent: local,
  });
  assert.equal(d.action, "stamp");
});

test("CRLF local with matching hash is treated as clean overwrite when remote body differs", () => {
  const localLf = wikiNote();
  const localCrlf = localLf.replace(/\n/g, "\r\n");
  const remote = wikiNote({}, "New remote body\n");
  const d = decidePullAction({
    localContent: localCrlf,
    storedHash: hashNoteForSync(localLf),
    localSyncedAt: "2026-08-14T04:00:00.000Z",
    remoteUpdatedAt: "2026-08-16T01:00:00.000Z",
    remoteContent: remote,
  });
  assert.equal(d.action, "overwrite");
});
