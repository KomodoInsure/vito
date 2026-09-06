import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const WRITER_LOCK_DIRECTORY = ".vito-writer.lock";
const OWNER_FILENAME = "owner.json";
const SIGNALS: NodeJS.Signals[] = ["SIGHUP", "SIGINT", "SIGTERM", "SIGQUIT"];

interface LockOwner {
  version: 1;
  pid: number;
  processStart: string;
  nonce: string;
}

export class WriterLockBusyError extends Error {
  readonly code = "VITO_WRITER_BUSY";

  constructor(message = "Another Vito collector writer owns the state directory") {
    super(message);
    this.name = "WriterLockBusyError";
  }
}

export class WriterLockIntegrityError extends Error {
  readonly code = "VITO_WRITER_LOCK_INTEGRITY";

  constructor(message: string) {
    super(message);
    this.name = "WriterLockIntegrityError";
  }
}

function processStartIdentity(pid: number): string | null {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const identity = result.stdout.trim().replace(/\s+/g, " ");
  return identity.length === 0 ? null : identity;
}

function parseOwner(contents: string): LockOwner | null {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    !("pid" in value) ||
    !("processStart" in value) ||
    !("nonce" in value)
  ) return null;
  const { version, pid, processStart, nonce } = value;
  if (
    version !== 1 ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof processStart !== "string" ||
    processStart.length === 0 ||
    typeof nonce !== "string" ||
    nonce.length === 0
  ) return null;
  return { version, pid, processStart, nonce };
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const stat = lstatSync(lockPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const entries = readdirSync(lockPath);
    if (entries.length !== 1 || entries[0] !== OWNER_FILENAME) return null;
    const ownerPath = join(lockPath, OWNER_FILENAME);
    const ownerStat = lstatSync(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) return null;
    return parseOwner(readFileSync(ownerPath, "utf8"));
  } catch {
    return null;
  }
}

function ownerIsProvenStale(owner: LockOwner): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return true;
    return false;
  }

  const observedStart = processStartIdentity(owner.pid);
  return observedStart !== null && observedStart !== owner.processStart;
}

function sameOwner(left: Readonly<LockOwner>, right: Readonly<LockOwner>): boolean {
  return left.version === right.version && left.pid === right.pid && left.processStart === right.processStart && left.nonce === right.nonce;
}

const activeLocks = new Set<WriterLock>();
const signalHandlers = new Map<NodeJS.Signals, () => void>();
let exitHandler: (() => void) | null = null;
let handlingSignal = false;

function installLifecycleHandlers(): void {
  if (signalHandlers.size !== 0) return;
  exitHandler = (): void => {
    for (const lock of [...activeLocks]) lock.release();
  };
  process.once("exit", exitHandler);
  for (const signal of SIGNALS) {
    const handler = (): void => {
      if (handlingSignal) return;
      handlingSignal = true;
      for (const lock of [...activeLocks]) lock.release();
      for (const [registeredSignal, registeredHandler] of signalHandlers) {
        process.removeListener(registeredSignal, registeredHandler);
      }
      signalHandlers.clear();
      process.kill(process.pid, signal);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
}

function uninstallLifecycleHandlersIfIdle(): void {
  if (activeLocks.size !== 0 || signalHandlers.size === 0) return;
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  signalHandlers.clear();
  if (exitHandler !== null) process.removeListener("exit", exitHandler);
  exitHandler = null;
  handlingSignal = false;
}

function removeOwnedDirectory(lockPath: string, expectedOwner: Readonly<LockOwner>): boolean {
  const currentOwner = readOwner(lockPath);
  if (currentOwner === null || !sameOwner(currentOwner, expectedOwner)) return false;
  unlinkSync(join(lockPath, OWNER_FILENAME));
  rmdirSync(lockPath);
  return true;
}

export class WriterLock {
  readonly stateDir: string;
  readonly path: string;
  readonly owner: Readonly<LockOwner>;

  private held = true;

  private constructor(stateDir: string, path: string, owner: LockOwner) {
    this.stateDir = stateDir;
    this.path = path;
    this.owner = owner;
    activeLocks.add(this);
    installLifecycleHandlers();
  }

  static acquire(stateDir: string): WriterLock {
    if (typeof stateDir !== "string" || stateDir.length === 0) throw new TypeError("stateDir must be a non-empty string");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
    const canonicalStateDir = realpathSync(stateDir);
    const lockPath = join(canonicalStateDir, WRITER_LOCK_DIRECTORY);
    const processStart = processStartIdentity(process.pid);
    if (processStart === null) {
      throw new WriterLockIntegrityError("Cannot establish this collector process start identity");
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const owner: LockOwner = { version: 1, pid: process.pid, processStart, nonce: randomUUID() };
      try {
        mkdirSync(lockPath, { mode: 0o700 });
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (code !== "EEXIST") throw error;

        const existingOwner = readOwner(lockPath);
        if (existingOwner === null) {
          throw new WriterLockBusyError("Vito writer lock exists but its owner cannot be safely established");
        }
        if (!ownerIsProvenStale(existingOwner)) throw new WriterLockBusyError();

        const quarantinePath = `${lockPath}.stale-${randomUUID()}`;
        try {
          renameSync(lockPath, quarantinePath);
        } catch (renameError) {
          const code = typeof renameError === "object" && renameError !== null && "code" in renameError ? renameError.code : undefined;
          if (code === "ENOENT") continue;
          throw new WriterLockIntegrityError("A proven stale Vito writer lock could not be isolated safely");
        }
        const quarantinedOwner = readOwner(quarantinePath);
        if (quarantinedOwner === null || !sameOwner(existingOwner, quarantinedOwner)) {
          if (!existsSync(lockPath)) {
            try {
              renameSync(quarantinePath, lockPath);
            } catch {
              // Leave uncertain ownership untouched rather than deleting it.
            }
          }
          throw new WriterLockIntegrityError("Vito writer lock ownership changed during stale reclamation");
        }
        removeOwnedDirectory(quarantinePath, existingOwner);
        continue;
      }

      const ownerPath = join(lockPath, OWNER_FILENAME);
      let descriptor: number | null = null;
      try {
        descriptor = openSync(ownerPath, "wx", 0o600);
        writeSync(descriptor, `${JSON.stringify(owner)}\n`, null, "utf8");
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = null;
        chmodSync(ownerPath, 0o600);
        return new WriterLock(canonicalStateDir, lockPath, owner);
      } catch (error) {
        if (descriptor !== null) closeSync(descriptor);
        try {
          if (existsSync(ownerPath)) unlinkSync(ownerPath);
          rmdirSync(lockPath);
        } catch {
          // A damaged lock must remain visible; a later process will fail conservatively.
        }
        throw error;
      }
    }
    throw new WriterLockBusyError("Vito writer lock changed repeatedly while acquiring it");
  }

  get isHeld(): boolean {
    return this.held;
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      removeOwnedDirectory(this.path, this.owner);
    } finally {
      activeLocks.delete(this);
      uninstallLifecycleHandlersIfIdle();
    }
  }
}

const lockContext = new AsyncLocalStorage<WriterLock>();

export async function withWriterLock<T>(
  stateDir: string,
  operation: (lock: WriterLock) => T | Promise<T>,
): Promise<T> {
  const active = lockContext.getStore();
  if (active !== undefined) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const requestedStateDir = realpathSync(stateDir);
    if (requestedStateDir !== active.stateDir) {
      throw new WriterLockIntegrityError("A nested mutating operation cannot switch Vito state directories");
    }
    return operation(active);
  }

  const lock = WriterLock.acquire(stateDir);
  try {
    return await lockContext.run(lock, () => operation(lock));
  } finally {
    lock.release();
  }
}
