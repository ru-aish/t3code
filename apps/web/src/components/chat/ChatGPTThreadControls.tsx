import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ArrowUpRightIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { useThreadProjection } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { OpenAI } from "../Icons";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

export function ChatGPTThreadControls(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const projection = useThreadProjection(
    scopeThreadRef(props.environmentId, props.threadId),
  )?.projection;
  const providerThread = projection?.providerThreads.find(
    (thread) => thread.id === projection.thread.activeProviderThreadId,
  );
  const refresh = useAtomCommand(serverEnvironment.refreshChatGPTThread, { reportFailure: false });
  const canRefresh = useAtomValue(
    serverEnvironment.refreshChatGPTThread.permissionAtom(props.environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  if (providerThread?.driver !== "chatgpt") return null;
  const id = providerThread.nativeThreadRef?.nativeId;
  const url = id && /^[a-f0-9-]{36}$/i.test(id) ? `https://chatgpt.com/c/${id}` : null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-chatgpt-heading"
      title="ChatGPT"
      showHeading={false}
    >
      <div className={THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS}>
        {url ? (
          <ThreadDetailsControl
            part="primary"
            render={<a href={url} target="_blank" rel="noopener noreferrer" />}
            aria-label="Open conversation in ChatGPT"
            title="Open conversation in ChatGPT"
          >
            <OpenAI className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            ChatGPT
            <ArrowUpRightIcon className="size-3.5 text-muted-foreground" />
          </ThreadDetailsControl>
        ) : (
          <ThreadDetailsControl part="primary" disabled>
            <OpenAI className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            ChatGPT
          </ThreadDetailsControl>
        )}
        <span className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
        <ThreadDetailsControl
          part="secondary"
          disabled={busy || !canRefresh || !url}
          aria-label="Refresh ChatGPT conversation"
          title="Reread this conversation from ChatGPT"
          onClick={async () => {
            if (busy) return;
            setBusy(true);
            setStatus(null);
            try {
              const result = await refresh({
                environmentId: props.environmentId,
                input: { threadId: props.threadId },
              });
              setStatus(
                result._tag === "Success"
                  ? "Conversation refreshed"
                  : "Could not refresh. Please retry.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <RefreshCwIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        </ThreadDetailsControl>
      </div>
      {status || busy ? (
        <p role="status" className="px-2.5 pb-1 text-xs text-muted-foreground">
          {busy ? "Refreshing conversation…" : status}
        </p>
      ) : null}
    </ThreadDetailsSection>
  );
}
