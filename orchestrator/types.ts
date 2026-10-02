import type { AgentRuntime } from './agents/types.js';
export type Mode = 'supervised' | 'unsupervised';
export type Role = 'implementer' | 'reviewer';
export type Phase = 'queued' | 'planning' | 'awaiting_approval' | 'implementing' | 'reviewing' | 'ready_to_merge' | 'paused' | 'blocked' | 'done' | 'closed';
export type WorkPhase = 'planning' | 'implementing' | 'reviewing';
export type AgentStatus = 'idle' | 'starting' | 'working' | 'settled' | 'prompting' | 'exited';
export interface AgentRecord {
  sessionId: string;
  model?: string;
  status: AgentStatus;
  settlement?: string;
}
export interface Dispatch {
  id: string;
  role: Role;
  phase: WorkPhase;
  attempts: number;
  startedAt?: string;
  reportPath: string;
  feedback?: string;
}
export interface Run {
  version: 1;
  issue: number;
  repo: string;
  mode: Mode;
  phase: Phase;
  worktree?: string;
  provisioning?: boolean;
  branch?: string;
  baseBranch?: string;
  skeletonSha?: string;
  approvedSha?: string;
  implementationStarted?: boolean;
  approval?: { sha: string; actor: string; at: string; source: 'cli' | 'github' | 'dashboard' | 'automatic' };
  reviewedSha?: string;
  reviewTargetSha?: string;
  pr?: number;
  prUrl?: string;
  agents: Record<Role, AgentRecord>;
  dispatch?: Dispatch;
  resumePhase?: Phase;
  feedback?: string;
  seenFeedback: string[];
  pendingMessages?: Array<{ id: string; marker: string; role: Role; text: string }>;
  reviewRounds: number;
  failures: number;
  retryAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export interface Report {
  phaseToken: string;
  kind: 'skeleton_ready' | 'implementation_ready' | 'review_passed' | 'changes_requested' | 'needs_input';
  summary: string;
  findings?: string[];
}
export interface Feedback {
  id: string;
  author: string;
  body: string;
  submittedAt: string;
  commitSha?: string;
}
export interface PullRequestInfo {
  number: number;
  url: string;
  headSha: string;
  head: string;
  base: string;
  draft: boolean;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  checks: 'passed' | 'pending' | 'failed' | 'none';
  feedback: Feedback[];
}
export interface TaskInfo {
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  completed: boolean;
}
export interface ReadyEntry { number: number; state: string; worktree?: string | null; branch?: string; }
export interface ExecutionCore {
  config: { repo: string; owner: string; checkout: string; agents: { runtime?: AgentRuntime; planner_model?: string; implementer_model?: string; reviewer_model?: string } };
  ready(all?: boolean): Promise<ReadyEntry[]>;
  snapshot(): Promise<{ tasks: Array<{ number: number }> }>;
  createWorktree(issue: number): Promise<{ path: string; branch: string; base_branch: string; brief: string }>;
  recoverWorktree?(issue: number): Promise<{ path: string; branch: string; base_branch: string; brief: string } | null>;
  inspectTask(issue: number): Promise<TaskInfo>;
  inspectPullRequest(issue: number): Promise<PullRequestInfo | null>;
  publishPullRequest(number: number): Promise<void>;
  draftPullRequest?(number: number): Promise<void>;
}
