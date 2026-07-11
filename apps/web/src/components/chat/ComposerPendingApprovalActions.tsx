import {
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import { memo } from "react";
import { Button } from "../ui/button";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  provider?: ProviderDriverKind | undefined;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  provider,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  // Antigravity gates only support allow/reject (no session-scoped grant via this API),
  // so mirror its two-option prompt instead of the generic four-option set.
  if (provider === "antigravity") {
    return (
      <>
        <Button
          size="sm"
          variant="destructive-outline"
          disabled={isResponding}
          onClick={() => void onRespondToApproval(requestId, "decline")}
        >
          Reject
        </Button>
        <Button
          size="sm"
          variant="default"
          disabled={isResponding}
          onClick={() => void onRespondToApproval(requestId, "accept")}
        >
          Allow
        </Button>
      </>
    );
  }
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "cancel")}
      >
        Cancel turn
      </Button>
      <Button
        size="sm"
        variant="destructive-outline"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "decline")}
      >
        Decline
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "acceptForSession")}
      >
        Always allow this session
      </Button>
      <Button
        size="sm"
        variant="default"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "accept")}
      >
        Approve once
      </Button>
    </>
  );
});
