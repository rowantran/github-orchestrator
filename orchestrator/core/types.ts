import type { AgentRuntime } from '../agents/types.js';
export type { AgentRuntime };
export interface Agents { runtime?: AgentRuntime; planner_model?: string; implementer_model?: string; reviewer_model?: string }
export interface OrchestrationConfig { max_concurrency?: number; poll_interval_ms?: number; agent_timeout_ms?: number; max_attempts?: number; max_review_rounds?: number }
export interface Config {
  repo: string; owner: string; project_url: string; checkout: string; base_branch: string;
  vault: string | null; agents: Agents; orchestration?: OrchestrationConfig;
}
export interface IssueRef { repo: string; number: number }
export type StateReason = 'COMPLETED' | 'NOT_PLANNED' | 'REOPENED' | 'DUPLICATE';
export interface PullRequest {
  number: number; url: string; repo: string; state: 'OPEN' | 'CLOSED' | 'MERGED';
  draft: boolean; base: string; head: string; merge_commit: string | null;
}
export interface Issue {
  reference: IssueRef; title: string; body: string; state: 'OPEN' | 'CLOSED'; state_reason: StateReason | null;
  assignees: string[]; project_ids: string[]; blockers: IssueRef[]; pull_requests: PullRequest[];
}
export interface LinkedPullRequest { url: string; state: PullRequest['state']; draft: boolean; head: string; base: string }
export type WorkState = { state: 'blocked' | 'in_progress' | 'done' } |
  { state: 'ready'; stack_on: number[] } | { state: 'ready_for_review'; pull_request: LinkedPullRequest } |
  { state: 'closed'; reason: StateReason | null };
export type Blocker = WorkState & { number: number; repo: string; url: string; title: string; branch: string | null; worktree: string | null; pull_requests: LinkedPullRequest[] };
export type Entry = WorkState & { number: number; title: string; url: string; branch: string; worktree: string | null; blockers: Blocker[]; body: string };
export type Task = Entry & { workstreams: string[]; pull_requests: LinkedPullRequest[] };
export interface Snapshot { [key: string]: unknown; repo: string; project_url: string; workstreams: string[]; tasks: Task[] }
export interface Created { issue: number; branch: string; base: string; base_commit: string; base_branch: string; path: string; brief: string }
export interface CreateTaskOptions { title: string; body: string; blockedBy?: (string | number)[]; workstreams?: string[]; note?: string }
export type TaskInspection = import('../types.js').TaskInfo;
export interface HumanComment { id: number; url: string; author: string | null; body: string; created_at: string; updated_at: string }
export interface ReviewComment { id: number; url: string; path: string; line: number | null; outdated: boolean; in_reply_to: number | null; body: string }
export interface SubmittedReview { id: number; url: string; author: string | null; state: string; submitted_at: string; body: string; comments: ReviewComment[] }
export type PullRequestInspection = import('../types.js').PullRequestInfo;
export interface Project { id: string; url: string; title: string }
export interface DoctorResult { ok: boolean; project: Project; checks: string[]; warnings: string[] }
