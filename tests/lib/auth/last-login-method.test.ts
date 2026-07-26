import { describe, it, expect, afterEach } from "vitest";
import {
  LAST_LOGIN_METHOD_STORAGE_KEY,
  LOGIN_METHODS,
  readLastLoginMethod,
  rememberLastLoginMethod
} from "@/lib/auth/last-login-method";

type StorageStub = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

function installWindow(storage: StorageStub | null): () => void {
  const original = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = storage
    ? { localStorage: storage }
    : {
        get localStorage(): StorageStub {
          throw new Error("storage disabled by policy");
        }
      };
  return () => {
    if (original === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = original;
    }
  };
}

function memoryStorage(seed: Record<string, string> = {}): StorageStub & {
  values: Record<string, string>;
} {
  const values: Record<string, string> = { ...seed };
  return {
    values,
    getItem: (key) => (key in values ? values[key] : null),
    setItem: (key, value) => {
      values[key] = value;
    }
  };
}

describe("last login method", () => {
  let uninstall: (() => void) | null = null;

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("returns null on the server, where there is no window", () => {
    expect(readLastLoginMethod()).toBeNull();
    expect(() => rememberLastLoginMethod("google")).not.toThrow();
  });

  it("round-trips every supported method", () => {
    const storage = memoryStorage();
    uninstall = installWindow(storage);

    for (const method of LOGIN_METHODS) {
      rememberLastLoginMethod(method);
      expect(storage.values[LAST_LOGIN_METHOD_STORAGE_KEY]).toBe(method);
      expect(readLastLoginMethod()).toBe(method);
    }
  });

  it("returns null when nothing has been stored yet", () => {
    uninstall = installWindow(memoryStorage());
    expect(readLastLoginMethod()).toBeNull();
  });

  it("ignores a value that is not a known method", () => {
    uninstall = installWindow(
      memoryStorage({ [LAST_LOGIN_METHOD_STORAGE_KEY]: "carrier-pigeon" })
    );
    expect(readLastLoginMethod()).toBeNull();
  });

  it("survives storage that throws (private mode, storage disabled)", () => {
    uninstall = installWindow(null);
    expect(readLastLoginMethod()).toBeNull();
    expect(() => rememberLastLoginMethod("passkey")).not.toThrow();
  });
});
