// A request is a row before the network call returns. A crash leaves phase=started.
// Success and failure update that same row. Bytes that were never stored stay unverified.
import { randomUUID } from "node:crypto";
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";

export async function openRequest(sourceId: string | null, url: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO own_request_attempts (id, source_id, url, phase) VALUES (${id}, ${sourceId}, ${url}, 'started')`;
  return id;
}

export async function finishRequest(id: string, result: { status: number | null; bytes?: Buffer; truncated?: boolean; error?: string }): Promise<void> {
  const failed = result.error !== undefined || (result.status !== null && result.status >= 400);
  const bytes = result.bytes ?? null;
  await sql`UPDATE own_request_attempts
    SET phase = ${failed ? "failed" : "succeeded"}, http_status = ${result.status},
        response = ${bytes}, response_sha256 = ${bytes ? sha256(bytes) : null},
        error = ${result.error ? result.error.slice(0, 500) : null}, finished_at = now(),
        note = ${result.truncated ? "response truncated" : null}
    WHERE id = ${id} AND phase = 'started'`;
}

/** A request that happened and whose bytes were not kept. This does not fetch. */
export async function noteUnverifiedRequest(url: string, note: string, sourceId: string | null = null): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO own_request_attempts (id, source_id, url, phase, note, finished_at)
    VALUES (${id}, ${sourceId}, ${url}, 'unverified', ${note}, now())`;
  return id;
}
