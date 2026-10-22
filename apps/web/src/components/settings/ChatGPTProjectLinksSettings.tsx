import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProjectId,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { readEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function ChatGPTProjectLinkRow(props: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  title: string;
  projectIds: readonly ProjectId[];
  settings: ServerSettings;
}) {
  const list = useAtomCommand(serverEnvironment.listProviderCloudProjects, { reportFailure: false });
  const save = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [projects, setProjects] = useState<ReadonlyArray<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const canWrite = readEnvironmentScope(props.environmentId, AuthSettingsWriteScope);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    void list({ environmentId: props.environmentId, input: { instanceId: props.instanceId } }).then(
      (result) => {
        if (cancelled) return;
        setLoading(false);
        if (result._tag === "Success") setProjects(result.value.projects);
        else setError(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [list, props.environmentId, props.instanceId]);

  const links = props.projectIds.map(
    (projectId) =>
      props.settings.projectSettingsOverrides[projectId]?.chatgptProjects?.[props.instanceId] ??
      null,
  );
  const mixed = links.some((link) => link !== links[0]);
  const selected = mixed ? null : (links[0] ?? "unlinked");
  const known = projects.some((project) => project.id === selected);

  const update = (value: string | null) => {
    if (!value || saving || !canWrite || loading || error) return;
    const projectSettingsOverrides: Record<
      ProjectId,
      ServerSettings["projectSettingsOverrides"][ProjectId]
    > = {};
    for (const projectId of props.projectIds) {
      const current = props.settings.projectSettingsOverrides[projectId] ?? {};
      const chatgptProjects = { ...current.chatgptProjects };
      if (value === "unlinked") delete chatgptProjects[props.instanceId];
      else chatgptProjects[props.instanceId] = value;
      projectSettingsOverrides[projectId] = {
        ...current,
        chatgptProjects,
      };
    }
    setSaving(true);
    void save({
      environmentId: props.environmentId,
      input: { patch: { projectSettingsOverrides } },
    }).then((result) => {
      setSaving(false);
      if (result._tag !== "Success")
        toastManager.add({
          type: "error",
          title: "ChatGPT project link not saved",
          description: "Check settings permissions and retry.",
        });
    });
  };

  return (
    <SettingsRow
      title={props.title}
      description={
        error
          ? "Could not load ChatGPT projects. Reopen Settings to retry."
          : "New ChatGPT conversations in this T3 project use the linked project by default."
      }
      control={
        <Select
          value={selected}
          onValueChange={update}
          disabled={!canWrite || loading || saving || error}
        >
          <SelectTrigger size="sm" aria-label={`Linked ChatGPT project for ${props.title}`}>
            <SelectValue>
              {mixed
                ? "Mixed"
                : loading
                  ? "Loading…"
                  : selected === "unlinked"
                    ? "Not linked"
                    : projects.find((project) => project.id === selected)?.name ?? selected}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="unlinked">Not linked (General ChatGPT)</SelectItem>
            {!known && selected && selected !== "unlinked" ? (
              <SelectItem value={selected}>
                {selected} (unavailable)
              </SelectItem>
            ) : null}
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

export function ChatGPTProjectLinksSettings({ group }: { group: SidebarProjectSnapshot }) {
  const { environments } = useEnvironments();
  const environmentsById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const membersByEnvironment = new Map<EnvironmentId, Set<ProjectId>>();
  for (const member of group.memberProjects) {
    const ids = membersByEnvironment.get(member.environmentId) ?? new Set<ProjectId>();
    ids.add(member.id);
    membersByEnvironment.set(member.environmentId, ids);
  }
  const rows = Array.from(membersByEnvironment).flatMap(([environmentId, ids]) => {
    const environment = environmentsById.get(environmentId);
    if (!environment?.serverConfig) return [];
    return deriveProviderInstanceEntries(environment.serverConfig.providers)
      .filter((provider) => provider.driverKind === "chatgpt" && provider.enabled)
      .map((provider) => ({
        environmentId,
        instanceId: provider.instanceId,
        title:
          membersByEnvironment.size > 1
            ? `${provider.displayName} · ${environment.label}`
            : provider.displayName,
        projectIds: [...ids],
        settings: environment.serverConfig!.settings,
      }));
  });
  if (rows.length === 0) return null;
  return (
    <SettingsSection title="ChatGPT project links">
      {rows.map((row) => (
        <ChatGPTProjectLinkRow key={`${row.environmentId}:${row.instanceId}`} {...row} />
      ))}
      <p className="px-3 pb-2 text-xs text-muted-foreground sm:px-4">
        You can override the linked project from the composer before sending the first message.
        Existing conversations stay in their original ChatGPT project.
      </p>
    </SettingsSection>
  );
}
