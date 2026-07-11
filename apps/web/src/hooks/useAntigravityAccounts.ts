import {
  AntigravityAccountId,
  type AntigravityAccountDetection,
  type AntigravityAccountsRegistry,
} from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { ensureLocalApi } from "~/localApi";

export interface AntigravityAccountsState {
  readonly registry: AntigravityAccountsRegistry | null;
  readonly detection: AntigravityAccountDetection | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
  readonly saveAccount: (label?: string) => Promise<void>;
  readonly switchAccount: (accountId: string) => Promise<void>;
  readonly removeAccount: (accountId: string) => Promise<void>;
  readonly dismissDetectedAccount: () => Promise<void>;
}

export function useAntigravityAccounts(enabled: boolean): AntigravityAccountsState {
  const [registry, setRegistry] = useState<AntigravityAccountsRegistry | null>(null);
  const [detection, setDetection] = useState<AntigravityAccountDetection | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) {
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const result = await ensureLocalApi().antigravity.listAccounts();
      setRegistry(result.registry);
      setDetection(result.detection);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Failed to load Antigravity accounts.";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setRegistry(null);
      setDetection(null);
      setError(null);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  const saveAccount = useCallback(async (label?: string) => {
    const next = await ensureLocalApi().antigravity.saveAccount({
      ...(label?.trim() ? { label: label.trim() } : {}),
    });
    setRegistry(next);
    const refreshed = await ensureLocalApi().antigravity.listAccounts();
    setDetection(refreshed.detection);
  }, []);

  const switchAccount = useCallback(async (accountId: string) => {
    const next = await ensureLocalApi().antigravity.switchAccount({
      accountId: AntigravityAccountId.make(accountId),
    });
    setRegistry(next);
    const refreshed = await ensureLocalApi().antigravity.listAccounts();
    setDetection(refreshed.detection);
  }, []);

  const removeAccount = useCallback(async (accountId: string) => {
    const next = await ensureLocalApi().antigravity.removeAccount({
      accountId: AntigravityAccountId.make(accountId),
    });
    setRegistry(next);
    const refreshed = await ensureLocalApi().antigravity.listAccounts();
    setDetection(refreshed.detection);
  }, []);

  const dismissDetectedAccount = useCallback(async () => {
    if (!detection?.fingerprint) {
      return;
    }
    const next = await ensureLocalApi().antigravity.dismissDetectedAccount({
      fingerprint: detection.fingerprint,
    });
    setRegistry(next);
    setDetection({
      ...detection,
      isDismissed: true,
    });
  }, [detection]);

  return {
    registry,
    detection,
    isLoading,
    error,
    refresh,
    saveAccount,
    switchAccount,
    removeAccount,
    dismissDetectedAccount,
  };
}
