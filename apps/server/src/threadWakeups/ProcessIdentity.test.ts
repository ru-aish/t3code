import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";

import * as ProcessIdentity from "./ProcessIdentity.ts";

const bootId = "12345678-1234-1234-1234-123456789abc";
const stat = (state = "S", ticks = "456") =>
  `42 (command with ) parentheses) ${[state, ...Array<string>(18).fill("0"), ticks, "0"].join(" ")}`;

const read = (input: {
  stat?: string;
  missing?: boolean;
  denied?: boolean;
  platform?: NodeJS.Platform;
  bootMissing?: boolean;
}) => {
  const fs = FileSystem.layerNoop({
    readFileString: (path) => {
      const isBoot = path.endsWith("boot_id");
      if (input.denied || (isBoot ? input.bootMissing : input.missing)) {
        return Effect.fail(
          new PlatformError.PlatformError(
            new PlatformError.SystemError({
              module: "FileSystem",
              method: "readFileString",
              _tag: input.denied ? "PermissionDenied" : "NotFound",
              pathOrDescriptor: path,
            }),
          ),
        );
      }
      return Effect.succeed(isBoot ? bootId : (input.stat ?? stat()));
    },
  });
  return Effect.flatMap(ProcessIdentity.ProcessIdentity, (service) => service.read(42)).pipe(
    Effect.provide(ProcessIdentity.layer(input.platform ?? "linux").pipe(Layer.provide(fs))),
  );
};

it.effect(
  "captures boot identity and exact start ticks despite spaces and parentheses in comm",
  () =>
    Effect.gen(function* () {
      expect(yield* read({})).toBe(`${bootId}:456`);
      expect(yield* read({ stat: stat("S", "789") })).toBe(`${bootId}:789`);
      expect(yield* read({ missing: true })).toBeNull();
      expect(yield* read({ stat: stat("Z") })).toBeNull();
      expect(yield* read({ stat: stat("X") })).toBeNull();
    }),
);

it.effect.each([
  [{ platform: "darwin" as const }, "unsupported"],
  [{ denied: true }, "unreadable"],
  [{ bootMissing: true }, "unreadable"],
  [{ stat: "invalid" }, "invalid_stat"],
  [{ stat: stat("S", "bad") }, "invalid_stat"],
] as const)("refuses unsafe identity reads: %j", ([input, reason]) =>
  Effect.gen(function* () {
    expect(yield* read(input).pipe(Effect.flip)).toMatchObject({
      _tag: "ProcessIdentityError",
      reason,
    });
  }),
);
