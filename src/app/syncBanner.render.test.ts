/**
 * jsdom render coverage for the M4 SyncBanner (§16.1, A20). It mounts the REAL
 * SyncBanner against a REAL Workbench (in-memory storage) plus a REAL
 * KoofrStorageAdapter backed by an in-memory fake fetch - nothing in the engine
 * is mocked. Asserts:
 *  - sync-publication-status reflects wb.syncStatus();
 *  - publish-remote-btn drives wb.publishToRemote and flips the status to
 *    'up-to-date';
 *  - refresh-remote-btn drives wb.refreshFromRemote.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InMemoryStorageAdapter } from "../test/InMemoryStorageAdapter";
import { Workbench } from "./workbench";
import { KoofrStorageAdapter } from "../storage";
import { SyncBanner } from "./SyncBanner";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

function makeRemote() {
  const store = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.replace("https://dav.example/Koofr/", "");
    if (method === "PUT") {
      store.set(path, bodyToBytes(init?.body, enc));
      return resp(201, "");
    }
    if (method === "GET") {
      const bytes = store.get(path);
      return bytes ? resp(200, bytes) : resp(404, "");
    }
    if (method === "MKCOL") return resp(201, "");
    if (method === "PROPFIND") {
      const children = [...store.keys()].filter((k) => k.startsWith(path + "/"));
      const hrefs = children
        .map((k) => `<d:response><d:href>/Koofr/${k}</d:href></d:response>`)
        .join("");
      return resp(207, `<d:multistatus xmlns:d="DAV:">${hrefs}</d:multistatus>`);
    }
    return resp(405, "");
  }) as unknown as typeof fetch;
  return { store, fetchImpl };
}

function bodyToBytes(body: unknown, enc: TextEncoder): Uint8Array {
  if (typeof body === "string") return enc.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body && typeof (body as ArrayBuffer).byteLength === "number") {
    return new Uint8Array(body as ArrayBuffer);
  }
  return enc.encode(String(body ?? ""));
}

function resp(status: number, body: string | Uint8Array): Response {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    async text() {
      return new TextDecoder().decode(bytes);
    },
    async arrayBuffer() {
      return bytes.slice().buffer;
    },
  } as unknown as Response;
}

function adapterFor(fetchImpl: typeof fetch): KoofrStorageAdapter {
  return new KoofrStorageAdapter({
    baseUrl: "https://dav.example/Koofr",
    username: "u",
    appPassword: "p",
    fetchImpl,
  });
}

async function mount(wb: Workbench, remote: KoofrStorageAdapter | null, bump: () => void): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(SyncBanner, { wb, remote, onChange: bump }));
  });
  return container;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * The publish/refresh chain is genuinely async (fetch + crypto.subtle.digest),
 * so it is not guaranteed to settle within a fixed number of microtask ticks.
 * Poll until the predicate holds, re-draining the microtask queue inside act.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    await act(async () => {
      await Promise.resolve();
      ok = predicate();
    });
    if (ok) return;
    if (Date.now() >= deadline) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("SyncBanner — status + publish/refresh (A20)", () => {
  it("renders the current sync state and disables actions without a remote", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const el = await mount(wb, null, () => undefined);
    const badge = el.querySelector('[data-testid="sync-publication-status"]')!;
    expect(badge).not.toBeNull();
    expect(badge.getAttribute("data-state")).toBe(wb.syncStatus().state);
    expect((el.querySelector('[data-testid="publish-remote-btn"]') as HTMLButtonElement).disabled).toBe(true);
    expect((el.querySelector('[data-testid="refresh-remote-btn"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("publish-remote-btn invokes the engine and flips status to up-to-date", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const remote = makeRemote();
    let bumps = 0;
    const el = await mount(wb, adapterFor(remote.fetchImpl), () => {
      bumps += 1;
    });

    await click(el.querySelector('[data-testid="publish-remote-btn"]')!);
    await waitFor(() => wb.syncStatus().state === "up-to-date");

    expect(bumps).toBeGreaterThan(0);
    expect(wb.syncStatus().state).toBe("up-to-date");
    // Re-render with the fresh status so the badge reflects it.
    await act(async () => {
      root!.render(createElement(SyncBanner, { wb, remote: adapterFor(remote.fetchImpl), onChange: () => undefined }));
    });
    expect(
      el.querySelector('[data-testid="sync-publication-status"]')!.getAttribute("data-state"),
    ).toBe("up-to-date");
  });

  it("refresh-remote-btn invokes refreshFromRemote against the published remote", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const remote = makeRemote();
    // Publish once so the remote has a pointer to refresh from.
    await wb.publishToRemote(adapterFor(remote.fetchImpl));

    const fresh = await Workbench.open(new InMemoryStorageAdapter());
    const el = await mount(fresh, adapterFor(remote.fetchImpl), () => undefined);
    await click(el.querySelector('[data-testid="refresh-remote-btn"]')!);
    await waitFor(() => fresh.syncStatus().state === "up-to-date");

    expect(fresh.syncStatus().state).toBe("up-to-date");
  });
});

describe("FEAT-003 3.2 SyncBanner configure-sync modal + demo remote", () => {
  async function mountConfig(
    wb: Workbench,
    onConfigureRemote: (remote: KoofrStorageAdapter) => void,
  ): Promise<HTMLElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(SyncBanner, {
          wb,
          remote: null,
          onChange: () => undefined,
          onConfigureRemote,
        }),
      );
    });
    return container;
  }

  it("configure-sync-btn toggles the sync-config-modal open and closed", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const el = await mountConfig(wb, () => undefined);
    expect(el.querySelector('[data-testid="sync-config-modal"]')).toBeNull();

    await click(el.querySelector('[data-testid="configure-sync-btn"]')!);
    expect(el.querySelector('[data-testid="sync-config-modal"]')).not.toBeNull();
    // The WebDAV credential inputs + both actions are present.
    expect(el.querySelector('[data-testid="sync-base-url-input"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="sync-username-input"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="sync-app-password-input"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="use-demo-remote-btn"]')).not.toBeNull();

    await click(el.querySelector('[data-testid="configure-sync-btn"]')!);
    expect(el.querySelector('[data-testid="sync-config-modal"]')).toBeNull();
  });

  it("use-demo-remote-btn lifts an in-memory remote that enables publish/refresh and round-trips", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    let configured: KoofrStorageAdapter | null = null;
    const el = await mountConfig(wb, (r) => {
      configured = r;
    });

    await click(el.querySelector('[data-testid="configure-sync-btn"]')!);
    await click(el.querySelector('[data-testid="use-demo-remote-btn"]')!);

    expect(configured).not.toBeNull();
    // The demo remote is a REAL KoofrStorageAdapter; publishing + refreshing a
    // fresh brain from it round-trips through the in-memory WebDAV fake fetch.
    await wb.publishToRemote(configured!);
    expect(wb.syncStatus().state).toBe("up-to-date");
    const fresh = await Workbench.open(new InMemoryStorageAdapter());
    await fresh.refreshFromRemote(configured!);
    expect(fresh.syncStatus().state).toBe("up-to-date");
  });

  it("re-rendering with the configured remote enables the publish/refresh buttons", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    let configured: KoofrStorageAdapter | null = null;
    const el = await mountConfig(wb, (r) => {
      configured = r;
    });
    await click(el.querySelector('[data-testid="configure-sync-btn"]')!);
    await click(el.querySelector('[data-testid="use-demo-remote-btn"]')!);

    // The shell lifts the remote and re-renders the banner with it wired.
    await act(async () => {
      root!.render(
        createElement(SyncBanner, {
          wb,
          remote: configured,
          onChange: () => undefined,
          onConfigureRemote: () => undefined,
        }),
      );
    });
    expect(
      (el.querySelector('[data-testid="publish-remote-btn"]') as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (el.querySelector('[data-testid="refresh-remote-btn"]') as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("P5 SyncBanner — WebDAV config persistence", () => {
  async function mountConfig(
    wb: Workbench,
    onConfigureRemote: (remote: KoofrStorageAdapter) => void,
  ): Promise<HTMLElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(SyncBanner, {
          wb,
          remote: null,
          onChange: () => undefined,
          onConfigureRemote,
        }),
      );
    });
    return container;
  }

  function typeInto(el: Element, testId: string, value: string): Promise<void> {
    const input = el.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement;
    return act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  afterEach(() => {
    localStorage.clear();
  });

  it("Connect WebDAV persists the endpoint and shows the reconnect hint", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    let configured: KoofrStorageAdapter | null = null;
    const el = await mountConfig(wb, (r) => {
      configured = r;
    });

    await click(el.querySelector('[data-testid="configure-sync-btn"]')!);
    await typeInto(el, "sync-base-url-input", "https://dav.example/Koofr");
    await typeInto(el, "sync-username-input", "alice");
    await typeInto(el, "sync-app-password-input", "pw");
    await click(el.querySelector('[data-testid="sync-connect-webdav-btn"]')!);

    // A real adapter was lifted AND the endpoint was persisted to localStorage.
    expect(configured).not.toBeNull();
    const { loadSyncConfig } = await import("../storage");
    expect(loadSyncConfig()).toEqual({
      baseUrl: "https://dav.example/Koofr",
      username: "alice",
      appPassword: "pw",
    });

    // Re-opening the modal shows the persisted-endpoint reconnect hint.
    await click(el.querySelector('[data-testid="configure-sync-btn"]')!);
    expect(el.querySelector('[data-testid="sync-saved-hint"]')!.textContent).toContain(
      "https://dav.example/Koofr",
    );
  });

  it("Disconnect clears the persisted endpoint", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const el = await mountConfig(wb, () => undefined);
    await click(el.querySelector('[data-testid="configure-sync-btn"]')!);
    await typeInto(el, "sync-base-url-input", "https://dav.example/Koofr");
    await click(el.querySelector('[data-testid="sync-connect-webdav-btn"]')!);

    const { loadSyncConfig } = await import("../storage");
    expect(loadSyncConfig()).not.toBeNull();

    await click(el.querySelector('[data-testid="configure-sync-btn"]')!);
    await click(el.querySelector('[data-testid="sync-disconnect-btn"]')!);
    expect(loadSyncConfig()).toBeNull();
  });

  it("the demo remote is labelled ephemeral and is NOT persisted", async () => {
    const wb = await Workbench.open(new InMemoryStorageAdapter());
    const el = await mountConfig(wb, () => undefined);
    await click(el.querySelector('[data-testid="configure-sync-btn"]')!);

    const note = el.querySelector('[data-testid="sync-demo-note"]')!;
    expect(note.textContent).toContain("cleared on reload");

    await click(el.querySelector('[data-testid="use-demo-remote-btn"]')!);
    const { loadSyncConfig } = await import("../storage");
    expect(loadSyncConfig()).toBeNull(); // demo remote never persists
  });
});
