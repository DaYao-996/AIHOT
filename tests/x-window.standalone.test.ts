// Offline replay of the X window contract. The fake provider never opens a socket.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import {
  accountWindowQuery,
  readXSearch,
  retainedByReplyFilter,
  type XPageFetcher,
} from "../packages/backend/src/sources/x.ts";
import type { SdTweet } from "../packages/backend/src/providers/socialdata.ts";
import fixture from "./fixtures/x-window-counterexamples.json" with { type: "json" };

const BASE = "from:example_user since_time:1 until_time:2 -filter:retweets";
const KNOWN = "50";

function tweet(id: string): SdTweet {
  return { id_str: id, tweet_created_at: "2026-11-02T00:00:00.000Z", full_text: id, user: { name: "N", screen_name: "example_user" } };
}

function scripted(pages: Record<string, { tweets: SdTweet[]; nextCursor: string | null; receiptId: number }>): { fetchPage: XPageFetcher; calls: Array<{ query: string; cursor: string | null }> } {
  const calls: Array<{ query: string; cursor: string | null }> = [];
  const fetchPage: XPageFetcher = async (query, cursor) => {
    calls.push({ query, cursor });
    const hit = pages[`${query}|${cursor ?? ""}`];
    if (!hit) throw new Error(`no scripted page for ${query} cursor ${cursor}`);
    return hit;
  };
  return { fetchPage, calls };
}

test("a first page with a cursor is not coverage, and the cursor can be continued later within a budget", async () => {
  const page1 = scripted({
    [`${BASE}|`]: { tweets: [tweet("100"), tweet("90")], nextCursor: "c2", receiptId: 11 },
  });
  const first = await readXSearch(BASE, { lastId: null, backlog: [], subject: "window" }, page1.fetchPage);
  assert.equal(page1.calls.length, 1);
  assert.equal(first.pages, 1);
  assert.equal(first.stopReason, "first_page_bound");
  assert.equal(first.coverage, "unproven");
  assert.equal(first.truncated, true);
  assert.equal(first.tweets.some((t) => t.id_str === KNOWN), false);
  assert.equal(first.backlog.at(-1)?.next, "c2");
  assert.equal("complete" in first, false);

  const continued = scripted({
    [`${BASE} since_id:100|`]: { tweets: [], nextCursor: null, receiptId: 12 },
    [`${BASE}|c2`]: { tweets: [tweet(KNOWN)], nextCursor: null, receiptId: 13 },
  });
  const second = await readXSearch(BASE, { lastId: first.lastId, backlog: first.backlog, subject: "window" }, continued.fetchPage);
  assert.equal(second.tweets.some((t) => t.id_str === KNOWN), true);
  assert.equal(second.coverage, "unproven");
  assert.ok(continued.calls.length <= 11);
  const replay = await readXSearch(BASE, { lastId: first.lastId, backlog: first.backlog, subject: "window" }, continued.fetchPage);
  assert.deepEqual(replay.receiptIds, second.receiptIds);
  assert.deepEqual(replay.tweets.map((t) => t.id_str), second.tweets.map((t) => t.id_str));
});

test("an empty page or a missing cursor does not prove the known in-window id was read", async () => {
  const empty = scripted({ [`${BASE}|`]: { tweets: [], nextCursor: null, receiptId: 21 } });
  const missed = await readXSearch(BASE, { lastId: null, backlog: [], subject: "window" }, empty.fetchPage);
  assert.equal(empty.calls.length, 1);
  assert.equal(missed.stopReason, "empty_page");
  assert.equal(missed.coverage, "unproven");
  assert.equal(missed.tweets.some((t) => t.id_str === KNOWN), false);

  const dead = scripted({ [`${BASE}|`]: { tweets: [tweet("100")], nextCursor: null, receiptId: 22 } });
  const stopped = await readXSearch(BASE, { lastId: null, backlog: [], subject: "window" }, dead.fetchPage);
  assert.equal(stopped.stopReason, "no_cursor");
  assert.equal(stopped.coverage, "unproven");
  assert.equal(stopped.tweets.some((t) => t.id_str === KNOWN), false);
});

test("page budget stays capped and a later run can continue the saved cursor", async () => {
  let n = 0;
  const fetchPage: XPageFetcher = async (_query, cursor) => {
    n += 1;
    const id = String(1000 - n);
    return { tweets: [tweet(id)], nextCursor: `p${n}`, receiptId: 100 + n };
  };
  const limited = await readXSearch(BASE, { lastId: "1", backlog: [], subject: "window" }, fetchPage);
  assert.equal(limited.pages, 10);
  assert.equal(limited.backlogPages, 10);
  assert.equal(limited.stopReason, "page_budget");
  assert.equal(limited.coverage, "budget_limited");
  assert.equal(limited.backlog.length > 0, true);
  assert.equal(n, 20);
});

test("NFT_Chen's empty second page is not coverage, and the 22 missed ids stay missing until a bounded split", async () => {
  const nft = fixture.nft_chen;
  assert.equal(nft.page1_ids.length, 20);
  assert.equal(nft.missed_ids.length, 22);
  assert.equal(nft.historical_exhausted_claim, true);
  assert.equal(nft.missed_ids.every((id) => !nft.page1_ids.includes(id)), true);
  const query = nft.query;
  const pages: Record<string, { tweets: SdTweet[]; nextCursor: string | null; receiptId: number }> = {
    [`${query}|`]: { tweets: nft.page1_ids.map(tweet), nextCursor: "p2", receiptId: 1 },
    [`${query}|p2`]: { tweets: [], nextCursor: null, receiptId: 2 },
    [`${query} since_id:${nft.page1_ids[0]}|`]: { tweets: [], nextCursor: null, receiptId: 3 },
  };
  const seen = scripted(pages);
  const first = await readXSearch(query, { lastId: null, backlog: [], subject: "nft" }, seen.fetchPage);
  assert.equal(first.stopReason, "first_page_bound");
  assert.equal(first.coverage, "unproven");
  assert.equal(first.pages, 1);
  assert.equal(nft.missed_ids.every((id) => !first.tweets.some((t) => t.id_str === id)), true);
  const second = await readXSearch(query, { lastId: first.lastId, backlog: first.backlog, subject: "nft" }, seen.fetchPage);
  assert.equal(second.coverage, "unproven");
  assert.equal(nft.missed_ids.every((id) => !second.tweets.some((t) => t.id_str === id)), true);
  assert.equal(second.receiptIds.includes(2), true);
  const recovered = new Set<string>();
  for (const [index, page] of nft.split_pages.entries()) {
    const slice = `${query} slice:${index}`;
    const one = scripted({ [`${slice}|`]: { tweets: page.ids.map(tweet), nextCursor: null, receiptId: 10 + index } });
    const read = await readXSearch(slice, { lastId: null, backlog: [], subject: "nft-slice" }, one.fetchPage);
    assert.equal(read.coverage, "unproven");
    assert.equal(one.calls.length, 1);
    for (const id of page.ids) recovered.add(id);
  }
  assert.deepEqual([...recovered].sort(), [...nft.missed_ids].sort());
});

test("SemiAnalysis empty wide window is not proof of no posts", async () => {
  const semi = fixture.semianalysis;
  const wide = scripted({ [`${semi.wide_query}|`]: { tweets: [], nextCursor: null, receiptId: 31 } });
  const empty = await readXSearch(semi.wide_query, { lastId: null, backlog: [], subject: "semi" }, wide.fetchPage);
  assert.equal(empty.stopReason, "empty_page");
  assert.equal(empty.coverage, "unproven");
  assert.equal(empty.tweets.length, 0);
  assert.equal(wide.calls.length, 1);
  const daily = scripted({
    [`${semi.daily_query}|`]: { tweets: semi.daily_ids.map(tweet), nextCursor: semi.daily_next_cursor_present ? "day2" : null, receiptId: 32 },
  });
  const slice = await readXSearch(semi.daily_query, { lastId: null, backlog: [], subject: "semi-day" }, daily.fetchPage);
  assert.deepEqual(slice.tweets.map((t) => t.id_str), semi.daily_ids);
  assert.equal(slice.coverage, "unproven");
  assert.equal(slice.stopReason, semi.daily_next_cursor_present ? "first_page_bound" : "no_cursor");
});

test("committed counterexample fixture still matches the migration input when it is present", () => {
  const root = process.env.SOURCE_MIGRATION_INPUTS;
  if (!root || !existsSync(`${root}/evidence/original_window/NFT_Chen_receipt.json`)) return;
  const receipt = JSON.parse(readFileSync(`${root}/evidence/original_window/NFT_Chen_receipt.json`, "utf8"));
  assert.deepEqual(receipt.pages[0].tweet_ids, fixture.nft_chen.page1_ids);
  assert.equal(receipt.exhausted, true);
  const missed = JSON.parse(readFileSync(`${root}/evidence/MISSED22_TO_EXPORTED_RAW.json`, "utf8"));
  const ids = missed.selected_raw.flatMap((page: { recovered_target_ids: string[] }) => page.recovered_target_ids);
  assert.deepEqual(ids, fixture.nft_chen.missed_ids);
});

test("roots, self-threads and non-reply quotes are not removed together", () => {
  const bare = "from:example_user -filter:replies";
  const safe = accountWindowQuery("example_user");
  const root = { author: "example_user", replyToAuthor: null };
  const selfThread = { author: "example_user", replyToAuthor: "example_user" };
  const otherReply = { author: "example_user", replyToAuthor: "someone_else" };
  const quote = { author: "example_user", replyToAuthor: null };
  assert.equal(retainedByReplyFilter(bare, root), true);
  assert.equal(retainedByReplyFilter(bare, quote), true);
  assert.equal(retainedByReplyFilter(bare, selfThread), false);
  assert.equal(retainedByReplyFilter(bare, otherReply), false);
  assert.equal(retainedByReplyFilter(safe, root), true);
  assert.equal(retainedByReplyFilter(safe, quote), true);
  assert.equal(retainedByReplyFilter(safe, selfThread), true);
  assert.equal(retainedByReplyFilter(safe, otherReply), false);
  assert.match(safe, /filter:self_threads/);
  assert.doesNotMatch(safe, /-filter:quote|-filter:nativeretweets/);
});
