import assert from "node:assert/strict";
import { test } from "node:test";
import { draftFromDebug, sameRecord } from "../packages/backend/src/file-extract.ts";

const shared = {
  input_completeness: { core_material: "in_post", selected_angle: "角度甲" },
  fact_source: { used_claim: "窄主张", source_type: "participant_first_hand", independent_confirmation: "unconfirmed", claim_support: "supported_as_stated_by_source" },
  direction_and_use: {
    direction_status: "evidenced", preference_sensitive_class: "none", electronics_or_device_angle: "false",
    reader_action: "explicit", new_information: "substantive", temporal_state: "current",
    primary_clause_id: "ai_tool_hands_on",
    clauses_considered: [{ clause_id: "ai_tool_hands_on", clause_text: "AI 工具上手实测", anchor: "根帖原句", source_field: "root", correspondence: "上手" }],
  },
  schema: "fanfan-value-fields-v46",
};

test("ten equal scalars do not make two clause readings the same record", () => {
  const other = structuredClone(shared);
  other.direction_and_use.primary_clause_id = "useful_software_or_hardware_tools";
  other.direction_and_use.clauses_considered = [{
    clause_id: "useful_software_or_hardware_tools",
    clause_text: "电子产品、好用的软硬件工具（含跟 AI 无关的，例如 iOS 系统工具）",
    anchor: "另一处原句", source_field: "root", correspondence: "好用软件",
  }];
  const compared = sameRecord(shared, other);
  assert.equal(compared.scalarsEqual, true);
  assert.equal(compared.primaryEqual, false);
  assert.equal(compared.identical, false);
  const draft = draftFromDebug({ postId: "2120452474305904776", fields: shared, rootText: "根帖", quoteText: null, publishedAt: "2026-11-01", inputPackageSha256: "abc" });
  assert.equal(draft.scored, false);
  assert.equal(draft.fieldSource, "fixed_debug_input");
  assert.equal(draft.structuralSource, "record_file");
  assert.equal(draft.humanVerification, "unverified");
  assert.equal(draft.usedClaim, "窄主张");
  assert.equal(draft.primaryClauseId, "ai_tool_hands_on");
  assert.equal("automatic_route" in draft, false);
});
