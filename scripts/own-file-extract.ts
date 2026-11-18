// Read already-revealed debug files. No model and no score.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { draftFromDebug, packageSha256, sameRecord } from "@aihot/backend/file-extract";

const root = process.argv[2];
if (!root) throw new Error("usage: node scripts/own-file-extract.ts <SCORING_IMPLEMENTATION_INPUTS dir>");
const ids = ["2117095432526700766", "2118428355058102650", "2120299157411790929", "2120452474305904776", "2121277055513862172"];
const zipNote = "05dc4ad6d9ca36a94a4af9a90930417d542edfe8e627ba627091336fbb1c624a";
const items = ids.map((id) => {
  const dir = path.join(root, "revealed_debug_only", id);
  const fields = JSON.parse(readFileSync(path.join(dir, "extract_file/fields.json"), "utf8"));
  const record = JSON.parse(readFileSync(path.join(dir, "input/records_" + id + ".json"), "utf8"));
  const objects = readFileSync(path.join(dir, "input/objects_" + id + ".json"));
  const rootText = record.root_text ?? record.root?.full_text ?? null;
  const quoteText = record.quote?.text ?? record.quote?.full_text ?? null;
  const publishedAt = record.published_at ?? record.created_at ?? null;
  return draftFromDebug({
    postId: id, fields, rootText, quoteText, publishedAt, inputPackageSha256: packageSha256(objects),
  });
});
const auto = JSON.parse(readFileSync(path.join(root, "revealed_debug_only/2120452474305904776/extract_file/fields.json"), "utf8"));
const collision = JSON.parse(readFileSync(path.join(root, "KNOWN_SCALAR_COLLISION_212045.json"), "utf8"));
const assistant = structuredClone(auto);
assistant.direction_and_use.primary_clause_id = collision.assistant_reference_clauses[0];
const compared = sameRecord(auto, assistant);
if (compared.identical) throw new Error("212045 was flattened");
const missing50 = JSON.parse(readFileSync(path.join(root, "MISSING_50_EVIDENCE.json"), "utf8"));
const report = {
  input_zip_sha256: zipNote,
  debug_only: true,
  scored: false,
  new_holdout: false,
  assistant_labels_are_not_gold: true,
  fifty_completion_receipt: missing50.complete_50_original_or_completion_receipt_found,
  collision_212045: { ...compared, does_not_resolve_which_label_is_right: collision.does_not_resolve_which_label_is_right },
  items,
};
writeFileSync("docs/own-pipeline/FILE_EXTRACT_DEBUG_v1.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ items: items.length, identical: compared.identical, scalarsEqual: compared.scalarsEqual, primaryEqual: compared.primaryEqual }));
