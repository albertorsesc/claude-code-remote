/**
 * The first-hello snapshot: the ordered set of events a client receives when it cannot resume (a
 * first-ever hello, a daemon-restart guard, or a replay gap). The order is a client-facing protocol
 * contract (a client renders session_list, then pending approvals, then jobs), so it lives here as a
 * pure function that can be unit-tested, rather than assembled inline in the composition root where
 * no test can reach it. Job merging (live queue plus recent terminal jobs from the store) is delegated
 * to the already-tested mergeSnapshotJobs.
 */
import type { ServerEvent, PendingApproval, SessionInfo } from '@claude-code-remote/protocol';
import type { Job } from './ports.ts';
import { mergeSnapshotJobs } from './jobs.ts';

export function buildSnapshot(
  sessions: SessionInfo[],
  pendingApprovals: PendingApproval[],
  liveJobs: Job[],
  recentJobs: Job[],
): ServerEvent[] {
  const jobs = mergeSnapshotJobs(liveJobs, recentJobs);
  return [
    { type: 'session_list', sessions },
    ...pendingApprovals.map((approval): ServerEvent => ({ type: 'approval_pending', approval })),
    ...jobs.map((job): ServerEvent => ({ type: 'job_update', job })),
  ];
}
