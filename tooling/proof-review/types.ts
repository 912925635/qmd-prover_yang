/** Experimental schema; deliberately separate from the official verifier protocol. */
export interface Anchor {
  source: string;
  start: number;
  end: number;
}

export interface ProofObligation {
  id: string;
  kind: 'inference' | 'context';
  source_span: Anchor;
  premises: Anchor[];
  conclusion: Anchor;
  inference: string;
  internal_dependencies: string[];
}

export interface Decomposition {
  target_statement: Anchor;
  final_obligation_id: string;
  obligations: ProofObligation[];
}

export interface FidelityIssue {
  kind: 'added_premise' | 'quantifier_shift' | 'changed_claim' | 'omission' | 'other';
  obligation_id: string | null;
  explanation: string;
  source_refs: Anchor[];
}

export interface FidelityReview {
  status: 'pass' | 'fail' | 'inconclusive';
  checked_obligation_ids: string[];
  target_preserved: boolean;
  issues: FidelityIssue[];
  explanation: string;
}

export interface RolePolicy {
  command: string[];
  model: string;
  implementation_version: string;
  /** Local adapter and other implementation files, relative to the policy file. */
  implementation_files: string[];
}

export interface ReviewPolicy {
  schema_version: 1;
  max_obligations: number;
  /** Trusted policy knobs, not model-selected exemptions. Defaults: 2 and 1. */
  min_inference_obligations?: number;
  max_span_paragraphs?: number;
  timeout_ms: number;
  max_output_bytes: number;
  roles: { decomposer: RolePolicy; fidelity: RolePolicy };
}

export interface ReviewRequest {
  schema_version: 2;
  role: 'decomposer' | 'fidelity';
  instructions: string;
  context: {
    target: { id: string; kind: string; statement_source: string; proof_source: string };
    dependencies: { id: string; kind: string; statement_source: string }[];
    external_basis: { mode: string; content_source: string | null };
    checker_contract: unknown;
  };
  sources: Record<string, string>;
  granularity_guard: { min_inference_obligations: number; max_span_paragraphs: number };
  decomposition?: Decomposition;
  output_schema: unknown;
}

export interface CallTrace {
  role: ReviewRequest['role'];
  request_hash: string;
  duration_ms: number;
  status: 'ok' | 'error';
  response?: unknown;
  error?: string;
  /** Adapter-reported usage, not an independently measured token count. */
  reported_total_tokens?: number;
}

export interface ProofReviewReport {
  schema_version: 2;
  phase: 'decomposition-and-faithfulness';
  target: string;
  verifier_packet_hash: string;
  review_policy_hash: string;
  review_policy: ReviewPolicy;
  source_identity: { statement_hash: string; proof_hash: string };
  applicability: 'recorded-packet-only';
  current_source_checked: false;
  /** Canonical corpus; anchors can be resolved without the old check record. */
  sources: Record<string, string>;
  decomposition: Decomposition | null;
  structural_issues: string[];
  fidelity: FidelityReview | null;
  stage_status: 'ready_for_proof_review' | 'blocked' | 'inconclusive';
  coverage: { assigned: number; checked: 0; uncovered: string[] };
  outcome: 'inconclusive';
  limitations: string[];
  calls: CallTrace[];
  metrics: { calls: number; duration_ms: number; reported_total_tokens?: number };
}
