// Shapes sent by the Control Centre (see api/StateService.java and the scenario classes).

export type Health = 'UP' | 'DOWN' | 'unreachable' | 'n/a';

export interface ServiceState {
  ref: string | null;
  commit: string | null;
  status: 'STOPPED' | 'STARTING' | 'UP' | 'FAILED';
  failure: string | null;
  port: number;
  health?: Health;
  pid?: number | null;
}

export interface LedgerRow {
  id: number;
  payment: string;
  merchant: string;
  amount: number | null;
  settledUtc: string;
}

export interface LedgerSummary {
  columns: string[];
  rows: number;
  booked: number;
  zero: number;
  last: LedgerRow[];
  error?: string;
}

export interface Recon {
  ref: string;
  entries: number | null;
  total: number | null;
  mismatches: number | null;
  error: string | null;
  at: string;
}

export interface IncidentResult {
  booked: number;
  sent: number;
  missing: number;
  zeroRows: number;
  dlt: number;
  ledgerHealth: string;
  backlogTotal: number;
  reproduced: boolean;
}

export interface Snapshot {
  infra: { status: 'STARTING' | 'UP' | 'FAILED' | 'STOPPED'; failure: string | null; postgres: string; kafka: string };
  busy: string | null;
  services: Record<string, ServiceState>;
  ledger?: LedgerSummary;
  kafka?: { published: number; lag: number; dlt: number; formats: Record<string, number> };
  traffic: { sent: number; total: number };
  recon: Recon | null;
  incident: { next: number; status: string; result: IncidentResult | null };
}

export interface LogLine {
  t: number;
  level: 'info' | 'ok' | 'warn' | 'fail' | 'say' | 'caption' | 'svc';
  text: string;
  service?: string;
}

export interface StepEvent {
  scenario: 'incident';
  index: number;
  total: number;
  id: string;
  time: string;
  title: string;
  caption: string;
  say: string;
  status: 'running' | 'done' | 'failed';
  result?: IncidentResult;
}

export interface Observed {
  offset: number;
  format: 'v1' | 'v2' | 'both' | 'unknown' | 'unreadable';
  merchantId?: string;
  amount?: number;
  amountMinor?: number;
  raw: string;
}

export interface StageRow {
  test: string;
  from: string;
  to: string;
  index: number;
  stage: string;
  ledgerRef: string;
  settlementRef: string;
  rows: number;
  expectedRows: number;
  zero: number;
  dlt: number;
  lag: number;
  recon: string;
  ok: boolean;
  problems: string[];
}

export interface RollbackResult {
  from: string;
  to: string;
  result: 'running' | 'PASS' | 'FAIL';
  firstProblem: string | null;
  reasons: string[];
  stages: StageRow[];
}

export interface TestResult {
  service: string;
  status: 'running' | 'passed' | 'failed';
  ok?: boolean;
  summary?: string;
}

export interface WireEvent {
  t: number;
  type: string;
  data: any;
}

export interface Refs {
  refs: string[];
  services: string[];
  incidentSteps: { id: string; time: string; title: string; caption: string; say: string }[];
  stages: string[];
  cases: { from: string; to: string; expected: 'PASS' | 'FAIL' }[];
}
