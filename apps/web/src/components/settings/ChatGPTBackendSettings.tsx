import type {
  ChatGPTBackendAction,
  ChatGPTBackendOverallStatus,
  ChatGPTBackendServiceId,
  ChatGPTBackendServiceState,
  ChatGPTBackendServiceStatus,
  ChatGPTBackendStatus,
} from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  PlayIcon,
  RefreshCwIcon,
  RotateCwIcon,
  ServerIcon,
  SquareIcon,
} from "lucide-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

function overallBadgeProps(status: ChatGPTBackendOverallStatus): {
  label: string;
  variant: "success" | "warning" | "error" | "secondary";
} {
  switch (status) {
    case "ready":
      return { label: "Ready", variant: "success" };
    case "degraded":
      return { label: "Degraded", variant: "warning" };
    case "stopped":
      return { label: "Stopped", variant: "secondary" };
    case "unavailable":
      return { label: "Unavailable", variant: "error" };
  }
}

function serviceBadgeProps(state: ChatGPTBackendServiceState): {
  label: string;
  variant: "success" | "warning" | "error" | "secondary" | "info";
} {
  switch (state) {
    case "running":
      return { label: "Running", variant: "success" };
    case "starting":
      return { label: "Starting", variant: "info" };
    case "stopped":
      return { label: "Stopped", variant: "secondary" };
    case "failed":
      return { label: "Failed", variant: "error" };
    case "unavailable":
      return { label: "Unavailable", variant: "warning" };
  }
}

function ChatGPTBackendServiceRow({
  service,
  busyKey,
  onControl,
}: {
  service: ChatGPTBackendServiceStatus;
  busyKey: string | null;
  onControl: (action: ChatGPTBackendAction, serviceId: ChatGPTBackendServiceId) => void;
}) {
  const badge = serviceBadgeProps(service.state);
  const isBusy = busyKey !== null;
  const isRunning = service.state === "running" || service.state === "starting";

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/80 bg-card/40 p-3.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{service.label}</span>
          <Badge variant={badge.variant} size="sm">
            {badge.label}
          </Badge>
          {service.healthy !== null ? (
            <Badge variant={service.healthy ? "success" : "warning"} size="sm">
              {service.healthy ? "Healthy" : "Unreachable"}
            </Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">{service.description}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground/85 font-mono">
          <span>{service.unitName}</span>
          {service.activeState ? (
            <span>
              {service.activeState}
              {service.subState ? ` (${service.subState})` : ""}
            </span>
          ) : null}
          {service.endpoint ? <span>{service.endpoint}</span> : null}
        </div>
        {service.detail ? (
          <p className="text-xs text-warning-foreground/90">{service.detail}</p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <Button
          size="xs"
          variant="outline"
          disabled={!service.canControl || isBusy || isRunning}
          onClick={() => onControl("start", service.id)}
        >
          <PlayIcon className="size-3" />
          Start
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={!service.canControl || isBusy}
          onClick={() => onControl("restart", service.id)}
        >
          <RotateCwIcon className="size-3" />
          Restart
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={!service.canControl || isBusy || !isRunning}
          onClick={() => onControl("stop", service.id)}
        >
          <SquareIcon className="size-3" />
          Stop
        </Button>
      </div>
    </div>
  );
}

export function ChatGPTBackendSettingsPanel() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  useRelativeTimeTick();

  const getBackendStatus = useAtomCommand(serverEnvironment.getChatGPTBackendStatus);
  const controlBackend = useAtomCommand(serverEnvironment.controlChatGPTBackend);

  const [status, setStatus] = useState<ChatGPTBackendStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchStatus = useCallback(
    async (silent = false) => {
      if (!environmentId) return;
      if (!silent) setLoading(true);
      setLoadError(null);
      try {
        const result = await getBackendStatus({ environmentId, input: {} });
        if (result._tag === "Success") {
          setStatus(result.value);
        } else if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          const message = failure instanceof Error ? failure.message : String(failure);
          setLoadError(message);
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [environmentId, getBackendStatus],
  );

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const handleControl = useCallback(
    async (action: ChatGPTBackendAction, serviceId?: ChatGPTBackendServiceId) => {
      if (!environmentId) return;
      const key = `${action}:${serviceId ?? "all"}`;
      setBusyKey(key);
      setLoadError(null);
      try {
        const result = await controlBackend({
          environmentId,
          input: serviceId ? { action, serviceId } : { action },
        });
        if (result._tag === "Success") {
          setStatus(result.value);
          if (result.value.error) {
            toastManager.add({
              type: "error",
              title: "ChatGPT backend action reported errors",
              description: result.value.error,
            });
          } else {
            toastManager.add({
              type: "success",
              title: serviceId
                ? `Completed ${action} for ${serviceId}`
                : `Completed ${action} for ChatGPT backend`,
            });
          }
        } else if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          const message = failure instanceof Error ? failure.message : String(failure);
          setLoadError(message);
          toastManager.add({
            type: "error",
            title: "ChatGPT backend action failed",
            description: message,
          });
        }
      } finally {
        setBusyKey(null);
      }
    },
    [controlBackend, environmentId],
  );

  const overall = status ? overallBadgeProps(status.overallStatus) : null;
  const checkedLabel = status?.checkedAt
    ? formatRelativeTimeLabel(status.checkedAt)
    : null;
  const canControlAny = status?.services.some((service) => service.canControl) ?? false;

  return (
    <SettingsPageContainer>
      <SettingsSection title="ChatGPT Backend">
        <p className="mb-3 text-xs text-muted-foreground">
          Manage the local ChatGPT desktop daemon, T3 Terminal MCP server, and Cloudflare tunnel
          required for T3 Code to communicate with ChatGPT.
        </p>
        <div className="space-y-4">
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card/50 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <ServerIcon className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">Backend Stack Status</span>
                {overall ? (
                  <Badge variant={overall.variant}>{overall.label}</Badge>
                ) : loading ? (
                  <Badge variant="secondary">Checking...</Badge>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {checkedLabel
                  ? `Last checked ${checkedLabel}`
                  : "Check live systemd unit and endpoint health."}
                {status ? ` · Platform: ${status.platform}` : ""}
              </p>
              {loadError ? <p className="text-xs text-destructive">{loadError}</p> : null}
              {status?.error ? (
                <p className="text-xs text-destructive">{status.error}</p>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={loading || busyKey !== null || !environmentId}
                onClick={() => void fetchStatus()}
              >
                <RefreshCwIcon className={loading ? "size-3 animate-spin" : "size-3"} />
                Refresh
              </Button>
              <Button
                size="xs"
                variant="default"
                disabled={!canControlAny || busyKey !== null}
                onClick={() => void handleControl("ensure")}
              >
                <PlayIcon className="size-3" />
                Start all
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={!canControlAny || busyKey !== null}
                onClick={() => void handleControl("restart")}
              >
                <RotateCwIcon className="size-3" />
                Restart all
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={!canControlAny || busyKey !== null}
                onClick={() => void handleControl("stop")}
              >
                <SquareIcon className="size-3" />
                Stop all
              </Button>
            </div>
          </div>

          <SettingsRow
            {...searchableSetting("chatgpt-backend-autostart")}
            title="Auto-start ChatGPT backends"
            description="Automatically start the ChatGPT desktop daemon, T3 Terminal MCP server, and Cloudflare tunnel when T3 Code launches."
            serverScoped
            settingKeys={["chatgptBackendAutoStart"]}
            control={
              <Switch
                aria-label="Auto-start ChatGPT backends"
                checked={settings.chatgptBackendAutoStart}
                onCheckedChange={(checked) => {
                  updateSettings({ chatgptBackendAutoStart: Boolean(checked) });
                  if (checked) {
                    void fetchStatus(true);
                  }
                }}
              />
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection title="Backend Services">
        <p className="mb-3 text-xs text-muted-foreground">
          Inspect and control each systemd user unit in the ChatGPT communication stack.
        </p>
        <div className="space-y-2.5">
          {status?.services.map((service) => (
            <ChatGPTBackendServiceRow
              key={service.id}
              service={service}
              busyKey={busyKey}
              onControl={(action, serviceId) => void handleControl(action, serviceId)}
            />
          )) ?? (
            <p className="text-sm text-muted-foreground">
              {loading ? "Loading backend service status..." : "No service status available."}
            </p>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="Configured Endpoints">
        <p className="mb-3 text-xs text-muted-foreground">
          Active endpoints used by the ChatGPT provider instance.
        </p>
        <div className="space-y-2 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2">
            <span>ChatGPT Renderer (CDP)</span>
            <code className="font-mono text-foreground">
              {status?.cdpEndpoint ?? "http://127.0.0.1:9234"}
            </code>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2">
            <span>T3 Terminal MCP Control</span>
            <code className="font-mono text-foreground">
              {status?.terminalEndpoint ?? "http://127.0.0.1:8022"}
            </code>
          </div>
          <p className="pt-1">
            To edit endpoints or token paths, open{" "}
            <Link to="/settings/providers" className="text-foreground underline underline-offset-2">
              Providers settings
            </Link>
            .
          </p>
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
