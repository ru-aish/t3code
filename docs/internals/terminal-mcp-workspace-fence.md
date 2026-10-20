# Detached Terminal MCP jobs and worktree mutation

T3's in-process `withWorkspaceLease` only coordinates T3 effects. Terminal MCP can continue a supervised job after its request or T3 thread finishes, so a checkpoint restore or storage-cleanup worktree removal must also coordinate with **process launch**, not merely query currently running PIDs.

## Shared protocol (v1)

T3 reads the Terminal MCP durable supervisor's on-disk job ledger. Set `T3_WORKSPACE_DURABLE_JOBS_DIR` in T3 to the same directory as Terminal MCP's `MCP_T3_DURABLE_JOBS_DIR`. If T3 has `T3_TERMINAL_DB`, its default is that database's sibling `durable-jobs`; otherwise the extra fence is not enabled. The job root is outside worktrees and private to the local user.

The Terminal MCP producer **must** be updated separately:

1. Before publishing `workspace-fence-version` with content `1\n`, route **all** workspace-writing subprocess starts through its supervised ledger, including ordinary starts that can detach. No untracked writer may bypass this contract.
2. Acquire the _atomic directory_ `<durable-jobs>/workspace-mutation.lock` before beginning any launch reservation. Hold it until the supervisor has durably written `jobs/<job-id>/request.json` (whose `cwd` is canonical) or until an abort is known not to have launched a process. No clock-based stale-lock recovery: if a caller crashes with the lock, fail closed until an operator can verify and remove it.
3. Keep `request.json` and write `result.json` only after the entire original process group has been reaped/verified. Non-verifiable termination must not be represented as `group_verified: true`. A child that daemonizes into an independent process group or writes outside the declared cwd breaks this contract; such workloads require a separate isolated worktree or a stronger supervisor.

T3 acquires the same lock for the **whole** rollback or cleanup, examines all reserved jobs, and refuses mutation if any overlapping working directory has an unfinished, missing, corrupt, or unverified exit receipt. A lock, missing protocol marker, or unreadable ledger always fails closed _when the integration is configured_.

This is intentionally one global gate per local supervisor instead of a new distributed lease subsystem. It establishes an ordering: either the job reservation completes first and blocks rollback, or the rollback completes first and the job starts afterward. T3-only changes do not establish this ordering: do not enable file restoration/cleanup in an environment with detached Terminal MCP writers until the producer-side protocol is deployed and both processes reference the same directory.
