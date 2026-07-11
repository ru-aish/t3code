"use client";

import { LoaderIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useAntigravityAccounts } from "../../hooks/useAntigravityAccounts";
import { ensureLocalApi } from "../../localApi";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { RedactedSensitiveText } from "./RedactedSensitiveText";

function formatAccountLabel(input: {
  readonly label: string;
  readonly email?: string;
  readonly isActive: boolean;
}): string {
  const base = input.email?.trim() || input.label;
  return input.isActive ? `${base} (active)` : base;
}

export function AntigravityAccountSection(props: { readonly enabled: boolean }) {
  const accounts = useAntigravityAccounts(props.enabled);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveLabel, setSaveLabel] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);

  const shouldPromptSave = useMemo(() => {
    const detection = accounts.detection;
    return Boolean(
      detection?.authenticated &&
      !detection.isKnown &&
      !detection.isDismissed &&
      detection.fingerprint !== "unknown",
    );
  }, [accounts.detection]);

  useEffect(() => {
    if (!props.enabled || !shouldPromptSave) {
      return;
    }
    setSaveLabel(accounts.detection?.email?.trim() ?? "");
    setSaveDialogOpen(true);
  }, [accounts.detection?.email, props.enabled, shouldPromptSave]);

  const activeAccountId = accounts.registry?.activeAccountId;
  const selectedAccountId =
    accounts.detection?.matchedAccountId ?? activeAccountId ?? accounts.registry?.accounts[0]?.id;

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await accounts.saveAccount(saveLabel);
      setSaveDialogOpen(false);
      toastManager.add({
        type: "success",
        title: "Antigravity account saved",
        description: "You can switch between saved accounts from provider settings.",
      });
      await ensureLocalApi().server.refreshProviders();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save Antigravity account.";
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not save Antigravity account",
          description: message,
        }),
      );
    } finally {
      setIsSaving(false);
    }
  }, [accounts, saveLabel]);

  const handleDismiss = useCallback(async () => {
    try {
      await accounts.dismissDetectedAccount();
      setSaveDialogOpen(false);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to dismiss Antigravity account prompt.";
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not dismiss prompt",
          description: message,
        }),
      );
    }
  }, [accounts]);

  const handleSwitch = useCallback(
    async (accountId: string | null) => {
      if (!accountId || accountId === selectedAccountId) {
        return;
      }
      setIsSwitching(true);
      try {
        await accounts.switchAccount(accountId);
        toastManager.add({
          type: "success",
          title: "Antigravity account switched",
          description: "Restart Antigravity if the active session does not update immediately.",
        });
        await ensureLocalApi().server.refreshProviders();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to switch Antigravity account.";
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not switch Antigravity account",
            description: message,
          }),
        );
      } finally {
        setIsSwitching(false);
      }
    },
    [accounts, selectedAccountId],
  );

  const handleRemove = useCallback(
    async (accountId: string) => {
      setIsRemoving(true);
      try {
        await accounts.removeAccount(accountId);
        toastManager.add({
          type: "success",
          title: "Saved Antigravity account removed",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to remove Antigravity account.";
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not remove Antigravity account",
            description: message,
          }),
        );
      } finally {
        setIsRemoving(false);
      }
    },
    [accounts],
  );

  if (!props.enabled) {
    return null;
  }

  const accountItems = accounts.registry?.accounts ?? [];
  const currentEmail = accounts.detection?.email;

  return (
    <>
      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-xs font-medium text-foreground">Antigravity accounts</p>
            <p className="text-xs text-muted-foreground">
              Save Antigravity credentials from <code className="text-foreground">~/.gemini</code>{" "}
              and switch between them here. T3 stores auth snapshots in its own data directory.
            </p>
          </div>

          {accounts.isLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <LoaderIcon className="size-3.5 animate-spin" />
              Loading saved accounts...
            </div>
          ) : null}

          {accounts.error ? <p className="text-xs text-destructive">{accounts.error}</p> : null}

          {currentEmail ? (
            <p className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
              <span>Detected session:</span>
              <RedactedSensitiveText
                value={currentEmail}
                ariaLabel="Toggle detected Antigravity email visibility"
                revealTooltip="Click to reveal email"
                hideTooltip="Click to hide email"
                className="text-foreground"
              />
            </p>
          ) : null}

          {accountItems.length > 0 ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select
                value={selectedAccountId ?? null}
                onValueChange={(value) => void handleSwitch(value)}
                disabled={isSwitching}
              >
                <SelectTrigger className="w-full sm:max-w-xs">
                  <SelectValue placeholder="Select a saved account" />
                </SelectTrigger>
                <SelectPopup>
                  {accountItems.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {formatAccountLabel({
                        label: account.label,
                        ...(account.email ? { email: account.email } : {}),
                        isActive: account.id === activeAccountId,
                      })}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>

              {selectedAccountId ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  disabled={isRemoving}
                  onClick={() => void handleRemove(selectedAccountId)}
                >
                  <Trash2Icon className="size-3.5" />
                  Remove
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No saved Antigravity accounts yet.</p>
          )}

          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isSaving || !accounts.detection?.authenticated}
              onClick={() => {
                setSaveLabel(accounts.detection?.email?.trim() ?? "");
                setSaveDialogOpen(true);
              }}
            >
              <PlusIcon className="size-3.5" />
              Save current credentials
            </Button>
          </div>
        </div>
      </div>

      <AlertDialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Save this Antigravity account?</AlertDialogTitle>
            <AlertDialogDescription>
              T3 detected Antigravity credentials that are not in your saved account list. Save them
              so you can switch back to this account later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="px-6 pb-2">
            <label htmlFor="antigravity-account-label" className="block">
              <span className="text-xs font-medium text-foreground">Account label</span>
              <DraftInput
                id="antigravity-account-label"
                className="mt-1.5"
                value={saveLabel}
                onCommit={setSaveLabel}
                placeholder={accounts.detection?.email?.trim() || "Antigravity account"}
                spellCheck={false}
              />
            </label>
          </div>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={isSaving} />}>
              Not now
            </AlertDialogClose>
            <Button
              type="button"
              variant="ghost"
              disabled={isSaving}
              onClick={() => void handleDismiss()}
            >
              Don&apos;t ask again
            </Button>
            <Button type="button" disabled={isSaving} onClick={() => void handleSave()}>
              {isSaving ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
              Save account
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
