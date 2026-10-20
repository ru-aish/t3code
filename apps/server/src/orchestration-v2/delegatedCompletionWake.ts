export function delegatedCompletionWakeDetail(taskIds: ReadonlyArray<string>): string {
  // The full cohort stays in durable metadata; provider-facing text must remain bounded.
  const visible = taskIds.slice(0, 3).map((id) => (id.length > 80 ? id.slice(0, 77) + "..." : id));
  const taskList = visible.join(", ");
  const remaining = taskIds.length - visible.length;
  const suffix = remaining > 0 ? " (and " + remaining + " more)" : "";
  return taskIds.length === 1
    ? "Delegated task " +
        taskList +
        " reached a terminal state. Use task_status with its full taskId to read the result."
    : "Delegated tasks " +
        taskList +
        suffix +
        " reached terminal states. Use task_status or t3_thread_read activity to discover the full task IDs and read their results.";
}
