import { memo } from "react";
import { BotIcon } from "lucide-react";
import { cn } from "~/lib/utils";

/** A compact marker for the local ChatGPT Desktop target, not an API provider. */
export const ChatGPTAgentTargetBadge = memo(function ChatGPTAgentTargetBadge(props: {
  compact: boolean;
}) {
  return (
    <span
      data-chatgpt-agent-target="true"
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/8 px-2 py-1 text-xs text-sky-700 dark:text-sky-200",
        props.compact && "px-1.5",
      )}
    >
      <BotIcon className="size-3.5" aria-hidden="true" />
      <span className="font-medium">ChatGPT Agent</span>
      {!props.compact ? (
        <span className="text-sky-700/70 dark:text-sky-200/70">Desktop</span>
      ) : null}
    </span>
  );
});
