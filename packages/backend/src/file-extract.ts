// File extract for already-revealed debug cases. No model, no score, no route decision.
import { sha256, stableJson } from "./lib/ids.ts";

export const SCALAR_KEYS = [
  "core_material", "source_type", "independent_confirmation", "claim_support", "direction_status",
  "preference_sensitive_class", "electronics_or_device_angle", "reader_action", "new_information", "temporal_state",
] as const;

export interface ClauseDraft {
  clauseId: string;
  clauseText: string;
  anchor: string | null;
  sourceField: string | null;
  correspondence: string | null;
}

export interface ExtractDraft {
  postId: string;
  debugOnly: true;
  scored: false;
  humanVerification: "unverified";
  selectedAngle: string | null;
  usedClaim: string | null;
  primaryClauseId: string | null;
  clauses: ClauseDraft[];
  scalars: Record<string, string | boolean | null>;
  rootText: string | null;
  quoteText: string | null;
  publishedAt: string | null;
  rules17Sha256: string;
  fieldsSchema: string;
  inputPackageSha256: string;
}

const RULES17 = "45c5a6a0105268a6ecf887c8bc7611595e9626fe0a25b7ce76ca48ee64e3e43e";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function scalarFingerprint(fields: any): Record<string, string | boolean | null> {
  const direction = fields?.direction_and_use ?? {};
  const fact = fields?.fact_source ?? {};
  const input = fields?.input_completeness ?? {};
  const raw: Record<string, unknown> = {
    core_material: input.core_material ?? null,
    source_type: fact.source_type ?? null,
    independent_confirmation: fact.independent_confirmation ?? null,
    claim_support: fact.claim_support ?? null,
    direction_status: direction.direction_status ?? null,
    preference_sensitive_class: direction.preference_sensitive_class ?? null,
    electronics_or_device_angle: direction.electronics_or_device_angle ?? null,
    reader_action: direction.reader_action ?? null,
    new_information: direction.new_information ?? null,
    temporal_state: direction.temporal_state ?? null,
  };
  return Object.fromEntries(SCALAR_KEYS.map((key) => [key, raw[key] as string | boolean | null]));
}

export function clausesOf(fields: any): ClauseDraft[] {
  const rows = fields?.direction_and_use?.clauses_considered ?? [];
  return rows.map((row: any) => ({
    clauseId: String(row.clause_id ?? ""),
    clauseText: String(row.clause_text ?? ""),
    anchor: text(row.anchor),
    sourceField: text(row.source_field),
    correspondence: text(row.correspondence),
  }));
}

/** Same ten scalars do not make two readings the same record. */
export function sameRecord(left: any, right: any): { scalarsEqual: boolean; primaryEqual: boolean; identical: boolean } {
  const scalarsEqual = stableJson(scalarFingerprint(left)) === stableJson(scalarFingerprint(right));
  const primaryEqual = left?.direction_and_use?.primary_clause_id === right?.direction_and_use?.primary_clause_id;
  const clausesEqual = stableJson(clausesOf(left)) === stableJson(clausesOf(right));
  return { scalarsEqual, primaryEqual, identical: scalarsEqual && primaryEqual && clausesEqual };
}

export function draftFromDebug(input: {
  postId: string;
  fields: any;
  rootText?: string | null;
  quoteText?: string | null;
  publishedAt?: string | null;
  inputPackageSha256: string;
}): ExtractDraft {
  const fields = input.fields ?? {};
  return {
    postId: input.postId,
    debugOnly: true,
    scored: false,
    humanVerification: "unverified",
    selectedAngle: text(fields.input_completeness?.selected_angle),
    usedClaim: text(fields.fact_source?.used_claim),
    primaryClauseId: text(fields.direction_and_use?.primary_clause_id),
    clauses: clausesOf(fields),
    scalars: scalarFingerprint(fields),
    rootText: input.rootText ?? null,
    quoteText: input.quoteText ?? null,
    publishedAt: input.publishedAt ?? null,
    rules17Sha256: RULES17,
    fieldsSchema: String(fields.schema ?? ""),
    inputPackageSha256: input.inputPackageSha256,
  };
}

export function packageSha256(bytes: Buffer | string): string {
  return sha256(bytes);
}
