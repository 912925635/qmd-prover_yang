/** Experimental schema; deliberately separate from the official verifier protocol. */
export interface Anchor {
  source: string;
  start: number;
  end: number;
  quoted_text: string;
}

export interface ProofObligation {
  id: string;
  source_span: Anchor;
  premises: Anchor[];
  conclusion: Anchor;
  inference: string;
  internal_dependencies: string[];
}

export interface Decomposition {
  target_statement: string;
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
  timeout_ms: number;
  max_output_bytes: number;
  roles: { decomposer: RolePolicy; fidelity: RolePolicy };
}

export interface ReviewRequest {
  schema_version: 1;
  role: 'decomposer' | 'fidelity';
  instructions: string;
  context: {
    target: { id: string; kind: string; statement: string; proof: string };
    dependencies: { id: string; kind: string; statement: string }[];
    external_basis: { mode: string; content: string | null };
    checker_contract: unknown;
  };
  sources: Record<string, string>;
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
  schema_version: 1;
  phase: 'decomposition-and-faithfulness';
  target: string;
  verifier_packet_hash: string;
  review_policy_hash: string;
  review_policy: ReviewPolicy;
  source_identity: { statement_hash: string; proof_hash: string };
  applicability: 'recorded-packet-only';
  current_source_checked: false;
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
