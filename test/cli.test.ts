import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { CliUsageError, main, parseArgs } from "../src/cli";
import type { CommandRunner, ParsedInvocation } from "../src/cli";

function invocation(command: ParsedInvocation["command"], configPath?: string): ParsedInvocation {
  return configPath === undefined ? { command } : { command, configPath };
}

describe("parseArgs accepted invocations", () => {
  const accepted: Array<{
    name: string;
    argv: string[];
    expected: ParsedInvocation;
  }> = [
    {
      name: "minimal init",
      argv: ["init", "--workspace", "/work", "--pages-repo", "owner/activity"],
      expected: invocation({
        kind: "init",
        workspaceRoots: ["/work"],
        pagesRepository: "owner/activity",
      }),
    },
    {
      name: "relative workspace resolves from invocation directory",
      argv: ["init", "--workspace", ".", "--workspace", "test", "--pages-repo", "owner/activity"],
      expected: invocation({
        kind: "init",
        workspaceRoots: [process.cwd(), resolve("test")],
        pagesRepository: "owner/activity",
      }),
    },
    {
      name: "complete init with repeated workspaces and global config",
      argv: [
        "--config",
        "/private/config.json",
        "init",
        "--timezone",
        "America/New_York",
        "--workspace",
        "/work/one",
        "--state-dir",
        "state",
        "--pages-repo",
        "agent-native/activity.widgets",
        "--workspace",
        "/work/two",
      ],
      expected: invocation(
        {
          kind: "init",
          workspaceRoots: ["/work/one", "/work/two"],
          pagesRepository: "agent-native/activity.widgets",
          timezone: "America/New_York",
          stateDir: resolve("state"),
        },
        "/private/config.json",
      ),
    },
    {
      name: "discover",
      argv: ["discover"],
      expected: invocation({ kind: "discover" }),
    },
    {
      name: "discover with relative global config",
      argv: ["--config", "relative-config.json", "discover"],
      expected: invocation({ kind: "discover" }, resolve("relative-config.json")),
    },
    {
      name: "incremental collect",
      argv: ["collect"],
      expected: invocation({ kind: "collect", rebuild: false }),
    },
    {
      name: "rebuild collect",
      argv: ["collect", "--rebuild"],
      expected: invocation({ kind: "collect", rebuild: true }),
    },
    {
      name: "export resolves relative output",
      argv: ["export", "--out", "./public"],
      expected: invocation({ kind: "export", out: resolve("public") }),
    },
    {
      name: "fixed-cutoff export in either option order",
      argv: ["export", "--at", "2026-09-06T18:04:05.123Z", "--out", "/tmp/public"],
      expected: invocation({
        kind: "export",
        out: "/tmp/public",
        at: "2026-09-06T18:04:05.123Z",
      }),
    },
    {
      name: "private fixed-cutoff scope report",
      argv: ["scope", "--days", "30", "--at", "2026-09-06T18:04:05.123Z"],
      expected: invocation({
        kind: "scope",
        days: 30,
        at: "2026-09-06T18:04:05.123Z",
      }),
    },
    {
      name: "preview resolves relative directory",
      argv: ["preview", "--dir", "./public"],
      expected: invocation({ kind: "preview", dir: resolve("public"), port: 4173 }),
    },
    {
      name: "preview explicit port",
      argv: ["preview", "--port", "8080", "--dir", "/tmp/public"],
      expected: invocation({ kind: "preview", dir: "/tmp/public", port: 8080 }),
    },
    {
      name: "publish",
      argv: ["publish"],
      expected: invocation({ kind: "publish", dryRun: false }),
    },
    {
      name: "dry-run publish",
      argv: ["publish", "--dry-run"],
      expected: invocation({ kind: "publish", dryRun: true }),
    },
    {
      name: "pages setup",
      argv: ["pages", "setup"],
      expected: invocation({ kind: "pages-setup" }),
    },
    {
      name: "tick",
      argv: ["tick"],
      expected: invocation({ kind: "tick" }),
    },
    {
      name: "schedule install",
      argv: ["schedule", "install"],
      expected: invocation({ kind: "schedule", action: "install" }),
    },
    {
      name: "schedule status",
      argv: ["schedule", "status"],
      expected: invocation({ kind: "schedule", action: "status" }),
    },
    {
      name: "schedule uninstall",
      argv: ["schedule", "uninstall"],
      expected: invocation({ kind: "schedule", action: "uninstall" }),
    },
  ];

  for (const { name, argv, expected } of accepted) {
    test(name, () => {
      expect(parseArgs(argv)).toEqual(expected);
    });
  }
});

describe("parseArgs rejects invalid invocations", () => {
  const invalid: Array<{ name: string; argv: string[]; message: string }> = [
    { name: "empty argv", argv: [], message: "A command is required" },
    { name: "unknown command", argv: ["frobnicate"], message: "Unknown command" },
    { name: "unknown global option", argv: ["--verbose", "discover"], message: "Unknown global option" },
    { name: "missing global config value", argv: ["--config"], message: "requires a value" },
    {
      name: "duplicate global config",
      argv: ["--config", "/a", "--config", "/b", "discover"],
      message: "may only be specified once",
    },
    {
      name: "misplaced global config",
      argv: ["discover", "--config", "/a"],
      message: "must appear before",
    },
    { name: "init missing workspace", argv: ["init", "--pages-repo", "a/b"], message: "at least one --workspace" },
    { name: "init missing workspace value", argv: ["init", "--workspace", "--pages-repo", "a/b"], message: "requires a value" },
    { name: "init equivalent relative workspace", argv: ["init", "--workspace", ".", "--workspace", "./", "--pages-repo", "a/b"], message: "Duplicate --workspace" },
    { name: "init duplicate workspace", argv: ["init", "--workspace", "/work", "--workspace", "/work", "--pages-repo", "a/b"], message: "Duplicate --workspace" },
    { name: "init missing pages repository", argv: ["init", "--workspace", "/work"], message: "requires --pages-repo" },
    { name: "init invalid pages repository", argv: ["init", "--workspace", "/work", "--pages-repo", "not-a-repository"], message: "owner/name" },
    { name: "init missing pages repository value", argv: ["init", "--workspace", "/work", "--pages-repo"], message: "requires a value" },
    { name: "init duplicate pages repository", argv: ["init", "--workspace", "/work", "--pages-repo", "a/b", "--pages-repo", "a/c"], message: "may only be specified once" },
    { name: "init duplicate timezone", argv: ["init", "--workspace", "/work", "--pages-repo", "a/b", "--timezone", "UTC", "--timezone", "Etc/UTC"], message: "may only be specified once" },
    { name: "init missing timezone value", argv: ["init", "--workspace", "/work", "--pages-repo", "a/b", "--timezone"], message: "requires a value" },
    { name: "init invalid timezone", argv: ["init", "--workspace", "/work", "--pages-repo", "a/b", "--timezone", "Planet/Olympus"], message: "valid IANA timezone" },
    { name: "init missing state directory value", argv: ["init", "--workspace", "/work", "--pages-repo", "a/b", "--state-dir"], message: "requires a value" },
    { name: "init duplicate state directory", argv: ["init", "--workspace", "/work", "--pages-repo", "a/b", "--state-dir", "/one", "--state-dir", "/two"], message: "may only be specified once" },
    { name: "init unknown option", argv: ["init", "--workspace", "/work", "--pages-repo", "a/b", "--scan"], message: "Unknown argument" },
    { name: "discover arguments", argv: ["discover", "extra"], message: "Unknown argument" },
    { name: "collect duplicate rebuild", argv: ["collect", "--rebuild", "--rebuild"], message: "may only be specified once" },
    { name: "collect unknown option", argv: ["collect", "--all"], message: "Unknown argument" },
    { name: "export missing out", argv: ["export"], message: "requires --out" },
    { name: "export missing out value", argv: ["export", "--out"], message: "requires a value" },
    { name: "export duplicate out", argv: ["export", "--out", "/a", "--out", "/b"], message: "may only be specified once" },
    { name: "export invalid instant", argv: ["export", "--out", "/a", "--at", "yesterday"], message: "ISO instant" },
    { name: "export instant without offset", argv: ["export", "--out", "/a", "--at", "2026-09-06T12:00:00"], message: "ISO instant" },
    { name: "export missing instant value", argv: ["export", "--out", "/a", "--at"], message: "requires a value" },
    { name: "export invalid calendar instant", argv: ["export", "--out", "/a", "--at", "2026-02-31T12:00:00Z"], message: "ISO instant" },
    { name: "export duplicate instant", argv: ["export", "--out", "/a", "--at", "2026-09-06T12:00:00Z", "--at", "2026-09-06T13:00:00Z"], message: "may only be specified once" },
    { name: "scope missing days", argv: ["scope", "--at", "2026-09-06T12:00:00Z"], message: "requires --days" },
    { name: "scope invalid days", argv: ["scope", "--days", "0", "--at", "2026-09-06T12:00:00Z"], message: "positive integer" },
    { name: "scope missing cutoff", argv: ["scope", "--days", "7"], message: "requires --at" },
    { name: "preview missing directory", argv: ["preview"], message: "requires --dir" },
    { name: "preview missing port value", argv: ["preview", "--dir", "/a", "--port"], message: "requires a value" },
    { name: "preview nonnumeric port", argv: ["preview", "--dir", "/a", "--port", "four"], message: "integer from 1 to 65535" },
    { name: "preview zero port", argv: ["preview", "--dir", "/a", "--port", "0"], message: "integer from 1 to 65535" },
    { name: "preview high port", argv: ["preview", "--dir", "/a", "--port", "65536"], message: "integer from 1 to 65535" },
    { name: "preview missing directory value", argv: ["preview", "--dir"], message: "requires a value" },
    { name: "preview duplicate port", argv: ["preview", "--dir", "/a", "--port", "4000", "--port", "4001"], message: "may only be specified once" },
    { name: "preview duplicate directory", argv: ["preview", "--dir", "/a", "--dir", "/b"], message: "may only be specified once" },
    { name: "publish duplicate dry run", argv: ["publish", "--dry-run", "--dry-run"], message: "may only be specified once" },
    { name: "publish unknown option", argv: ["publish", "--force"], message: "Unknown argument" },
    { name: "pages missing subcommand", argv: ["pages"], message: "requires the 'setup'" },
    { name: "pages unknown subcommand", argv: ["pages", "enable"], message: "Unknown pages subcommand" },
    { name: "pages setup arguments", argv: ["pages", "setup", "--force"], message: "Unknown argument" },
    { name: "tick arguments", argv: ["tick", "now"], message: "Unknown argument" },
    { name: "schedule missing action", argv: ["schedule"], message: "requires install, status, or uninstall" },
    { name: "schedule unknown action", argv: ["schedule", "restart"], message: "Unknown schedule subcommand" },
    { name: "schedule action arguments", argv: ["schedule", "status", "--json"], message: "Unknown argument" },
  ];

  for (const { name, argv, message } of invalid) {
    test(name, () => {
      expect(() => parseArgs(argv)).toThrow(CliUsageError);
      expect(() => parseArgs(argv)).toThrow(message);
    });
  }
});

describe("main dispatch", () => {
  test("init calls only the configuration initializer", async () => {
    let runnerCalls = 0;
    let configChecks = 0;
    let received: unknown;
    const output: string[] = [];
    const errors: string[] = [];
    const runner: CommandRunner = {
      run() {
        runnerCalls += 1;
      },
    };

    const exitCode = await main(
      ["--config", "/tmp/vito.json", "init", "--workspace", ".", "--pages-repo", "owner/activity"],
      runner,
      {
        async initializeConfig(input) {
          received = input;
          return { configPath: "/tmp/vito.json" };
        },
        async requireConfig() {
          configChecks += 1;
        },
        stdout: (message) => output.push(message),
        stderr: (message) => errors.push(message),
      },
    );

    expect(exitCode).toBe(0);
    expect(received).toEqual({
      configPath: "/tmp/vito.json",
      workspaceRoots: [process.cwd()],
      pagesRepository: "owner/activity",
    });
    expect(runnerCalls).toBe(0);
    expect(configChecks).toBe(0);
    expect(output).toEqual(["Initialized Vito configuration at /tmp/vito.json"]);
    expect(errors).toEqual([]);
  });

  test("non-config commands dispatch without loading company configuration", async () => {
    const commands: string[] = [];
    let configChecks = 0;
    const runner: CommandRunner = {
      run(command) {
        commands.push(command.kind);
      },
    };
    const dependencies = {
      async requireConfig() {
        configChecks += 1;
      },
      stdout() {},
      stderr() {},
    };

    expect(await main(["discover"], runner, dependencies)).toBe(0);
    expect(await main(["preview", "--dir", "/tmp/export"], runner, dependencies)).toBe(0);
    expect(commands).toEqual(["discover", "preview"]);
    expect(configChecks).toBe(0);
  });

  test("configured commands preserve parsed options and preflight before dispatch", async () => {
    const events: unknown[] = [];
    const exitCode = await main(
      ["--config", "/tmp/vito.json", "collect", "--rebuild"],
      {
        run(command, context) {
          events.push({ command, context });
        },
      },
      {
        async requireConfig(configPath) {
          events.push({ checked: configPath });
        },
        stdout() {},
        stderr() {},
      },
    );

    expect(exitCode).toBe(0);
    expect(events).toEqual([
      { checked: "/tmp/vito.json" },
      {
        command: { kind: "collect", rebuild: true },
        context: { configPath: "/tmp/vito.json" },
      },
    ]);
  });

  test("commands needing private state fail before their handlers when config is absent", async () => {
    const invocations = [
      ["collect"],
      ["export", "--out", "/tmp/export"],
      ["publish"],
      ["pages", "setup"],
      ["tick"],
      ["schedule", "install"],
      ["schedule", "status"],
      ["schedule", "uninstall"],
    ];

    for (const argv of invocations) {
      let runnerCalls = 0;
      const errors: string[] = [];
      const runner: CommandRunner = {
        run() {
          runnerCalls += 1;
        },
      };
      const exitCode = await main(argv, runner, {
        async requireConfig() {
          throw new Error("No Vito configuration found; run 'vito init' first.");
        },
        stdout() {},
        stderr: (message) => errors.push(message),
      });

      expect(exitCode).toBe(1);
      expect(runnerCalls).toBe(0);
      expect(errors).toEqual(["vito: No Vito configuration found; run 'vito init' first."]);
    }
  });

  test("usage errors are actionable and return exit code 2", async () => {
    let runnerCalls = 0;
    const errors: string[] = [];
    const exitCode = await main(
      ["collect", "--unknown"],
      { run: () => { runnerCalls += 1; } },
      { stdout() {}, stderr: (message) => errors.push(message) },
    );

    expect(exitCode).toBe(2);
    expect(runnerCalls).toBe(0);
    expect(errors).toEqual(["vito: Unknown argument for collect: --unknown"]);
  });

});
