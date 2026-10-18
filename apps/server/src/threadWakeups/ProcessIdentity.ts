import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class ProcessIdentityError extends Schema.TaggedError<ProcessIdentityError>()(
  "ProcessIdentityError",
  {
    pid: Schema.Int,
    reason: Schema.Literals(["unsupported", "unreadable", "invalid_stat"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported":
        return "Process wakeups require Linux /proc execution identities on the T3 server.";
      case "unreadable":
        return "Unable to read the process execution identity on the T3 server.";
      case "invalid_stat":
        return "The process stat did not contain a valid execution identity.";
    }
  }
}

export class ProcessIdentity extends Context.Service<
  ProcessIdentity,
  { readonly read: (pid: number) => Effect.Effect<string | null, ProcessIdentityError> }
>()("t3/threadWakeups/ProcessIdentity") {}

export const layer = (platform: NodeJS.Platform = process.platform) =>
  Layer.effect(
    ProcessIdentity,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const read = Effect.fn("ProcessIdentity.read")(function* (pid: number) {
        if (platform !== "linux") {
          return yield* new ProcessIdentityError({ pid, reason: "unsupported" });
        }
        // Start ticks alone can repeat after reboot. The boot id also makes
        // persisted registrations safe across a machine restart.
        const bootId = yield* fs
          .readFileString("/proc/sys/kernel/random/boot_id")
          .pipe(
            Effect.mapError(
              (cause) => new ProcessIdentityError({ pid, reason: "unreadable", cause }),
            ),
          );
        const stat = yield* fs
          .readFileString(`/proc/${pid}/stat`)
          .pipe(
            Effect.catch((cause) =>
              cause.reason._tag === "NotFound"
                ? Effect.succeed(null)
                : Effect.fail(new ProcessIdentityError({ pid, reason: "unreadable", cause })),
            ),
          );
        if (stat === null) return null;
        // comm may contain spaces and parentheses, so fields start after its
        // final ')'. Field 22 is starttime; the suffix starts at field 3.
        const end = stat.lastIndexOf(")");
        const fields = stat
          .slice(end + 1)
          .trim()
          .split(/\s+/);
        const ticks = fields[19];
        if (
          !stat.startsWith(`${pid} (`) ||
          end < 0 ||
          ticks === undefined ||
          !/^\d+$/.test(ticks) ||
          !/^[0-9a-f-]{36}$/.test(bootId.trim())
        ) {
          return yield* new ProcessIdentityError({ pid, reason: "invalid_stat" });
        }
        if (fields[0] === "Z" || fields[0] === "X" || fields[0] === "x") return null;
        return `${bootId.trim()}:${ticks}`;
      });
      return ProcessIdentity.of({ read });
    }),
  );
