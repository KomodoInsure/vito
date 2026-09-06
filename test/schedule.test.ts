import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Config } from "../src/config";
import {
  installSchedule,
  renderLaunchdPlist,
  SCHEDULE_LABEL,
  ScheduleError,
  scheduleStatus,
  uninstallSchedule,
  type CommandResult,
  type LaunchctlTransport,
  type ScheduleOptions,
} from "../src/schedule";
import { CollectorStore } from "../src/store";

const temporaryDirectories: string[] = [];

class FixtureLaunchctl implements LaunchctlTransport {
  readonly calls: Array<{ executable: string; args: string[] }> = [];
  loaded = false;

  run(executable: string, args: readonly string[]): CommandResult {
    this.calls.push({ executable, args: [...args] });
    if (args[0] === "print") {
      return this.loaded
        ? { exitCode: 0, stdout: `${SCHEDULE_LABEL} = { state = running; }`, stderr: "" }
        : { exitCode: 113, stdout: "", stderr: "Could not find service" };
    }
    if (args[0] === "bootstrap") {
      this.loaded = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "bootout") {
      this.loaded = false;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 64, stdout: "", stderr: "unexpected fixture command" };
  }
}

interface Fixture {
  root: string;
  config: Config;
  configPath: string;
  projectDir: string;
  plistPath: string;
  launchctl: FixtureLaunchctl;
  options: ScheduleOptions;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function executable(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "vito-schedule-test-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const stateDir = join(root, "private state & logs");
  const projectDir = join(root, "Vito <project> & 'activity'");
  const configPath = join(root, 'config "private" & value.json');
  const plistPath = join(root, "Launch Agents", `${SCHEDULE_LABEL}.plist`);
  mkdirSync(workspace);
  mkdirSync(stateDir, { mode: 0o700 });
  mkdirSync(join(projectDir, "src"), { recursive: true });
  writeFileSync(join(projectDir, "src", "cli.ts"), "console.log(JSON.stringify(process.argv.slice(2)));\n");

  const config: Config = {
    version: 1,
    workspaceRoots: [workspace],
    timezone: "UTC",
    stateDir,
    sources: {},
    repositories: [],
    publication: { repository: "fixture/activity", branch: "main" },
  };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const launchctl = new FixtureLaunchctl();
  const options: ScheduleOptions = {
    bunPath: process.execPath,
    gitPath: executable(join(root, "Git tools & helpers", "git")),
    ghPath: executable(join(root, "GitHub tools <cli>", "gh")),
    launchctlPath: executable(join(root, "system tools", "launchctl")),
    projectDir,
    plistPath,
    guiUid: 501,
    launchctl,
  };
  return { root, config, configPath, projectDir, plistPath, launchctl, options };
}

function plistJson(path: string): Record<string, unknown> {
  const conversion = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", path], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(conversion.exitCode, conversion.stderr.toString("utf8")).toBe(0);
  return JSON.parse(conversion.stdout.toString("utf8")) as Record<string, unknown>;
}

describe("managed launchd plist", () => {
  test("renders plutil-compatible XML with absolute escaped argv and a minimal executable PATH", () => {
    const value = fixture();
    const plist = renderLaunchdPlist(value.config, value.configPath, value.options);
    expect(plist).toContain("Vito &lt;project&gt; &amp; &apos;activity&apos;");
    expect(plist).toContain("config &quot;private&quot; &amp; value.json");
    expect(plist).toContain("private state &amp; logs");
    expect(plist).toContain("<key>Umask</key>\n    <integer>63</integer>");
    expect(plist).toContain("<key>StartInterval</key>\n    <integer>60</integer>");
    expect(plist).toContain("<key>RunAtLoad</key>\n    <true/>");

    mkdirSync(dirname(value.plistPath), { recursive: true });
    writeFileSync(value.plistPath, plist);
    const lint = Bun.spawnSync(["plutil", "-lint", value.plistPath], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(lint.exitCode, lint.stderr.toString("utf8")).toBe(0);

    const parsed = plistJson(value.plistPath);
    const argumentsList = parsed.ProgramArguments as string[];
    expect(argumentsList).toEqual([
      realpathSync(process.execPath),
      "run",
      join(realpathSync(value.projectDir), "src", "cli.ts"),
      "--config",
      realpathSync(value.configPath),
      "tick",
    ]);
    expect(parsed.StandardOutPath).toBe(join(value.config.stateDir, "logs", "schedule.stdout.log"));
    expect(parsed.StandardErrorPath).toBe(join(value.config.stateDir, "logs", "schedule.stderr.log"));
    expect(parsed.Umask).toBe(63);
    expect(parsed.StartInterval).toBe(60);
    expect(parsed.RunAtLoad).toBe(true);
    expect(parsed.EnvironmentVariables).toEqual({
      PATH: [
        dirname(realpathSync(process.execPath)),
        dirname(realpathSync(value.options.gitPath!)),
        dirname(realpathSync(value.options.ghPath!)),
      ].join(":"),
    });
  });

  test("the rendered tick ProgramArguments execute directly without a shell", () => {
    const value = fixture();
    mkdirSync(dirname(value.plistPath), { recursive: true });
    writeFileSync(value.plistPath, renderLaunchdPlist(value.config, value.configPath, value.options));
    const argumentsList = plistJson(value.plistPath).ProgramArguments as string[];
    const invocation = Bun.spawnSync(argumentsList, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(invocation.exitCode, invocation.stderr.toString("utf8")).toBe(0);
    expect(JSON.parse(invocation.stdout.toString("utf8"))).toEqual([
      "--config",
      realpathSync(value.configPath),
      "tick",
    ]);
  });

  test("installs idempotently, reports local run/publication metadata, and uninstalls only the job", async () => {
    const value = fixture();
    const collectionAt = Date.parse("2026-09-06T12:34:56.000Z");
    const store = CollectorStore.open(value.config.stateDir);
    store.upsertCollectionRun({
      runKey: "fixture-run",
      startedAtMs: collectionAt - 1_000,
      cutoffMs: collectionAt,
      completedAtMs: collectionAt,
      successfulScanMs: collectionAt,
      status: "completed",
      rebuild: false,
    });
    store.close();
    writeFileSync(join(value.config.stateDir, "publication-state.json"), JSON.stringify({
      schemaVersion: 1,
      lastSuccessfulPublicationAt: "2026-09-06T12:30:00Z",
      repository: value.config.publication.repository,
      commit: "fixture-commit",
      siteUrl: "https://fixture.example/activity/",
    }), { mode: 0o600 });
    const retainedArtifact = join(value.config.stateDir, "export", "activity.json");
    mkdirSync(dirname(retainedArtifact), { recursive: true });
    writeFileSync(retainedArtifact, "{}\n");

    const first = await installSchedule(value.config, value.configPath, value.options);
    expect(first).toEqual({ label: SCHEDULE_LABEL, plistPath: value.plistPath, installed: true, bootstrapped: true });
    expect(statSync(value.plistPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(value.config.stateDir, "logs")).mode & 0o777).toBe(0o700);
    expect(value.launchctl.calls.map((call) => call.args[0])).toEqual(["bootstrap"]);

    const second = await installSchedule(value.config, value.configPath, value.options);
    expect(second.bootstrapped).toBe(false);
    expect(value.launchctl.calls.map((call) => call.args[0])).toEqual(["bootstrap", "print"]);

    const status = await scheduleStatus(value.config, value.configPath, value.options);
    expect(status).toEqual({
      label: SCHEDULE_LABEL,
      plistPath: value.plistPath,
      installed: true,
      managed: true,
      loaded: true,
      lastCollectionAt: "2026-09-06T12:34:56.000Z",
      lastPublicationAt: "2026-09-06T12:30:00.000Z",
      siteUrl: "https://fixture.example/activity/",
    });

    const removed = await uninstallSchedule(value.config, value.configPath, value.options);
    expect(removed).toEqual({ label: SCHEDULE_LABEL, plistPath: value.plistPath, removed: true, bootedOut: true });
    expect(existsSync(value.plistPath)).toBe(false);
    expect(existsSync(join(value.config.stateDir, "activity.sqlite"))).toBe(true);
    expect(readFileSync(retainedArtifact, "utf8")).toBe("{}\n");
    expect(existsSync(join(value.config.stateDir, "publication-state.json"))).toBe(true);
    expect(value.launchctl.calls.at(-1)?.args).toEqual(["bootout", "gui/501", value.plistPath]);

    const repeated = await uninstallSchedule(value.config, value.configPath, value.options);
    expect(repeated).toEqual({ label: SCHEDULE_LABEL, plistPath: value.plistPath, removed: false, bootedOut: false });
  });

  test("refuses to replace or remove an unrelated plist without calling launchctl", async () => {
    const value = fixture();
    mkdirSync(dirname(value.plistPath), { recursive: true });
    const unrelated = "<?xml version=\"1.0\"?><plist><dict><key>Label</key><string>other.job</string></dict></plist>\n";
    writeFileSync(value.plistPath, unrelated);

    await expect(installSchedule(value.config, value.configPath, value.options)).rejects.toThrow(ScheduleError);
    await expect(uninstallSchedule(value.config, value.configPath, value.options)).rejects.toThrow(ScheduleError);
    expect(readFileSync(value.plistPath, "utf8")).toBe(unrelated);
    expect(value.launchctl.calls).toHaveLength(0);

    const status = await scheduleStatus(value.config, value.configPath, value.options);
    expect(status).toMatchObject({ installed: true, managed: false, loaded: false });
    expect(value.launchctl.calls).toHaveLength(1);
    expect(value.launchctl.calls[0]?.args).toEqual(["print", "gui/501/com.agentnative.vito"]);
  });
});
