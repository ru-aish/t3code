import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { CloudIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerControl, ComposerControlChevron } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";

export function ChatGPTProjectPicker(props: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  projectId: string | null;
  locked: boolean;
  disabled: boolean;
  onChange: (projectId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ReadonlyArray<{ id: string; name: string }>>([]);
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useAtomCommand(serverEnvironment.listProviderCloudProjects, {
    reportFailure: false,
  });
  const create = useAtomCommand(serverEnvironment.createProviderCloudProject, {
    reportFailure: false,
  });
  const menuProps = useComposerMenuProps();
  const loaded = useRef<{ scope: string; at: number } | null>(null);
  const canCreate = useAtomValue(
    serverEnvironment.createProviderCloudProject.permissionAtom(props.environmentId),
  );
  useEffect(() => {
    const scope = `${props.environmentId}:${props.instanceId}`;
    if (loaded.current?.scope === scope && (!open || Date.now() - loaded.current.at < 60_000))
      return;
    let cancelled = false;
    if (loaded.current?.scope !== scope) setProjects([]);
    setError(null);
    setBusy(true);
    void list({ environmentId: props.environmentId, input: { instanceId: props.instanceId } }).then(
      (result) => {
        if (cancelled) return;
        setBusy(false);
        if (result._tag === "Success") {
          loaded.current = { scope, at: Date.now() };
          setProjects(result.value.projects);
        } else setError("Could not load ChatGPT projects. Reopen to retry.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [list, props.environmentId, props.instanceId, open]);
  const selected = projects.find((project) => project.id === props.projectId);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <ComposerControl
            type="button"
            disabled={props.disabled}
            aria-label="ChatGPT project"
            title={
              props.locked
                ? "This thread's ChatGPT project is fixed. Start a new thread to change it."
                : "Choose the ChatGPT cloud project for this thread"
            }
          />
        }
      >
        <CloudIcon className="size-3.5" />
        <span className="max-w-40 truncate">
          {props.projectId ? `ChatGPT · ${selected?.name ?? props.projectId}` : "General ChatGPT"}
        </span>
        <ComposerControlChevron />
      </PopoverTrigger>
      <PopoverPopup {...menuProps} className="w-72" align="start">
        <div className="px-2 py-1 text-xs text-muted-foreground">ChatGPT project</div>
        {props.locked ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            Fixed for this thread. Start a new thread to choose another project.
          </p>
        ) : null}
        <input
          aria-label="Search ChatGPT projects"
          placeholder="Search ChatGPT projects…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="mb-1 w-full border-b bg-transparent px-2 py-2 text-sm outline-none"
        />
        <div role="listbox" aria-label="ChatGPT projects" className="max-h-64 overflow-y-auto">
          {[{ id: "", name: "General chat" }, ...projects]
            .filter((project) => project.name.toLowerCase().includes(query.toLowerCase()))
            .map((project) => (
              <button
                key={project.id}
                type="button"
                role="option"
                aria-selected={(props.projectId ?? "") === project.id}
                disabled={props.locked || busy}
                className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-60 aria-selected:bg-accent"
                onClick={() => {
                  props.onChange(project.id || null);
                  setOpen(false);
                }}
              >
                {project.name}
              </button>
            ))}
        </div>
        {busy ? (
          <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
            Loading…
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="px-2 py-1 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {!props.locked && !creating && canCreate ? (
          <button
            type="button"
            className="mt-1 flex w-full items-center gap-2 border-t px-2 py-2 text-sm"
            onClick={() => setCreating(true)}
          >
            <PlusIcon className="size-3.5" />
            New ChatGPT project
          </button>
        ) : null}
        {creating && !props.locked ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!name.trim() || busy) return;
              setBusy(true);
              setError(null);
              void create({
                environmentId: props.environmentId,
                input: { instanceId: props.instanceId, name: name.trim() },
              }).then((result) => {
                setBusy(false);
                if (result._tag !== "Success") {
                  setError("Could not create the ChatGPT project. Please retry.");
                  return;
                }
                setProjects((current) => [result.value, ...current]);
                props.onChange(result.value.id);
                setCreating(false);
                setName("");
                setOpen(false);
              });
            }}
            className="mt-2 flex gap-2"
          >
            <input
              autoFocus
              aria-label="New ChatGPT project name"
              placeholder="Project name"
              value={name}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
              className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-sm"
            />
            <button
              type="submit"
              disabled={busy || !name.trim()}
              className="rounded bg-accent px-2 text-sm disabled:opacity-50"
            >
              Create
            </button>
          </form>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
