// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useMemo, useState } from "react";
import { PERSONAL_PROJECT_ID, type ThreadListEntry } from "@bb/domain";
import type {
  ExperimentalThreadGroup,
  ExperimentalThreadGroupTabsRegistration,
} from "@get-bb/plugin-sdk";
import {
  makeThreadListEntry,
  makeThreadWithRuntime,
} from "@bb/test-helpers/domain-fixtures";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { threadQueryKey } from "@/hooks/queries/query-keys";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import {
  PaneContext,
  type PaneContextValue,
} from "@/views/thread-detail/PaneContext";
import { resetThreadGroupTabFocusHandoffForTest } from "@/components/thread/ThreadGroupTabStrip";
import { resetAllCrashedPluginSlotsForTest } from "./PluginSlotMount";
import { PluginThreadGroupTabs } from "./PluginThreadGroupTabs";

const state = vi.hoisted(() => ({
  navigationPending: false,
  threads: [] as ThreadListEntry[],
}));

const sdkThreads = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/lib/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sdk")>()),
  sdk: { threads: sdkThreads },
}));

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => ({
    data: state.navigationPending
      ? undefined
      : {
          sections: [],
          projects: [{ id: "proj_app", name: "App", threads: state.threads }],
          personalProject: {
            id: PERSONAL_PROJECT_ID,
            name: "Personal",
            threads: [],
          },
        },
    isError: false,
  }),
}));

const COORDINATOR = "thr_coordinator";
const AUTH = "thr_auth";
const PERF = "thr_perf";

function paneContext(
  overrides: Partial<PaneContextValue> = {},
): PaneContextValue {
  return {
    paneId: "main",
    isFocused: true,
    isSplitPane: false,
    secondaryPanelHost: null,
    reservesWindowPanelToggle: false,
    onRequestClose: null,
    isMaximized: false,
    onToggleMaximize: null,
    isBoundedPane: false,
    isTopRow: true,
    ownsWindowTopLeft: true,
    navigateInPane: vi.fn(),
    ...overrides,
  };
}

function registerGroups(
  ...registrations: (readonly [
    string,
    ExperimentalThreadGroupTabsRegistration,
  ])[]
) {
  for (const [pluginId, registration] of registrations) {
    setPluginSlotRegistrations(
      pluginId,
      makePluginRegistrationSet({ threadGroupTabs: [registration] }),
    );
  }
}

function groupSlot(
  useThreadGroup: ExperimentalThreadGroupTabsRegistration["useThreadGroup"],
): ExperimentalThreadGroupTabsRegistration {
  return { id: "group", title: "Initiative threads", useThreadGroup };
}

const INITIATIVE: ExperimentalThreadGroup = {
  tabs: [
    { threadId: AUTH },
    { threadId: COORDINATOR, label: "Coordinator", pinned: true },
    { threadId: PERF, label: "Perf" },
  ],
};

function renderTabs(
  threadId: string,
  pane = paneContext(),
  cachedThreadIds: readonly string[] = [COORDINATOR, AUTH, PERF],
) {
  const { queryClient, wrapper } = createQueryClientTestHarness();
  for (const id of cachedThreadIds) {
    queryClient.setQueryData(
      threadQueryKey(id),
      makeThreadWithRuntime({ id, projectId: "proj_app" }),
    );
  }
  render(
    <TooltipProvider>
      <PaneContext.Provider value={pane}>
        <PluginThreadGroupTabs
          fallback={<p>Plain title</p>}
          projectId="proj_app"
          threadId={threadId}
        />
      </PaneContext.Provider>
    </TooltipProvider>,
    { wrapper },
  );
  return pane;
}

beforeEach(() => {
  sdkThreads.list.mockResolvedValue([]);
  sdkThreads.get.mockRejectedValue(new Error("not found"));
});

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetAllCrashedPluginSlotsForTest();
  resetThreadGroupTabFocusHandoffForTest();
  state.navigationPending = false;
  state.threads = [];
  sdkThreads.get.mockReset();
  sdkThreads.list.mockReset();
  vi.restoreAllMocks();
});

describe("PluginThreadGroupTabs", () => {
  it("keeps the plain title when no plugin claims the thread", () => {
    registerGroups(["initiatives", groupSlot(() => null)]);
    renderTabs(COORDINATOR);

    expect(screen.getByText("Plain title")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("replaces the title with pinned-first tabs and selects the current thread", () => {
    state.threads = [
      makeThreadListEntry({
        id: AUTH,
        projectId: "proj_app",
        title: "Auth flow",
      }),
    ];
    registerGroups(["initiatives", groupSlot(() => INITIATIVE)]);
    renderTabs(AUTH);

    expect(screen.queryByText("Plain title")).toBeNull();
    const tablist = screen.getByRole("tablist", { name: "Initiative threads" });
    const tabs = screen.getAllByRole("tab");
    expect(tablist.contains(tabs[0] ?? null)).toBe(true);
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Coordinator",
      "Auth flow",
      "Perf",
    ]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("opens another tab's thread in the same pane", async () => {
    registerGroups(["initiatives", groupSlot(() => INITIATIVE)]);
    const pane = renderTabs(COORDINATOR);

    fireEvent.click(screen.getByRole("tab", { name: "Perf" }));

    await waitFor(() =>
      expect(pane.navigateInPane).toHaveBeenCalledWith({
        projectId: "proj_app",
        threadId: PERF,
      }),
    );
  });

  it("moves focus between tabs with arrow, Home and End keys", () => {
    registerGroups(["initiatives", groupSlot(() => INITIATIVE)]);
    renderTabs(COORDINATOR);
    const [coordinator, auth, perf] = screen.getAllByRole("tab");

    coordinator?.focus();
    fireEvent.keyDown(coordinator!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(auth);
    fireEvent.keyDown(auth!, { key: "End" });
    expect(document.activeElement).toBe(perf);
    fireEvent.keyDown(perf!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(coordinator);
    fireEvent.keyDown(coordinator!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(perf);
  });

  it("opens the thread a create action returns", async () => {
    const onCreate = vi.fn(async () => AUTH);
    registerGroups([
      "initiatives",
      groupSlot(() => ({
        ...INITIATIVE,
        create: { label: "New discussion", onCreate },
      })),
    ]);
    const pane = renderTabs(COORDINATOR);

    fireEvent.click(screen.getByRole("button", { name: "New discussion" }));

    await waitFor(() =>
      expect(pane.navigateInPane).toHaveBeenCalledWith({
        projectId: "proj_app",
        threadId: AUTH,
      }),
    );
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("stays put when a create action returns nothing", async () => {
    const onCreate = vi.fn(async () => undefined);
    registerGroups([
      "initiatives",
      groupSlot(() => ({
        ...INITIATIVE,
        create: { label: "New discussion", onCreate },
      })),
    ]);
    const pane = renderTabs(COORDINATOR);
    const button = screen.getByRole("button", { name: "New discussion" });

    fireEvent.click(button);

    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(pane.navigateInPane).not.toHaveBeenCalled();
  });

  it("falls through to the next plugin, and back to the title when a hook crashes", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    registerGroups(
      [
        "broken",
        groupSlot(() => {
          throw new Error("boom");
        }),
      ],
      ["declines", groupSlot(() => null)],
      ["initiatives", groupSlot(() => INITIATIVE)],
    );
    renderTabs(COORDINATOR);

    expect(screen.getAllByRole("tab")).toHaveLength(3);

    cleanup();
    resetPluginSlotStoreForTest();
    registerGroups([
      "broken",
      groupSlot(() => {
        throw new Error("boom");
      }),
    ]);
    renderTabs(COORDINATOR);

    expect(screen.getByText("Plain title")).toBeTruthy();
  });

  it("gives the lexically first plugin id precedence, whatever the load order", () => {
    registerGroups(
      [
        "z-loaded-first",
        groupSlot(() => ({
          tabs: [{ threadId: COORDINATOR, label: "Loaded first" }],
        })),
      ],
      [
        "a-loaded-second",
        groupSlot(() => ({
          tabs: [{ threadId: COORDINATOR, label: "Loaded second" }],
        })),
      ],
    );
    renderTabs(COORDINATOR);

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Loaded second",
    ]);
  });

  describe("focus after activation", () => {
    function NavigatingTabs() {
      const [threadId, setThreadId] = useState(COORDINATOR);
      const pane = useMemo(
        () =>
          paneContext({
            navigateInPane: (target) => setThreadId(target.threadId),
          }),
        [],
      );
      return (
        <TooltipProvider>
          <PaneContext.Provider value={pane}>
            <PluginThreadGroupTabs
              fallback={<p>Plain title</p>}
              projectId="proj_app"
              threadId={threadId}
            />
          </PaneContext.Provider>
        </TooltipProvider>
      );
    }

    function renderNavigating() {
      registerGroups(["initiatives", groupSlot(() => INITIATIVE)]);
      const { queryClient, wrapper } = createQueryClientTestHarness();
      for (const id of [COORDINATOR, AUTH, PERF]) {
        queryClient.setQueryData(
          threadQueryKey(id),
          makeThreadWithRuntime({ id, projectId: "proj_app" }),
        );
      }
      render(<NavigatingTabs />, { wrapper });
    }

    it("keeps focus on the newly selected tab after keyboard activation", async () => {
      renderNavigating();
      const coordinator = screen.getByRole("tab", { name: "Coordinator" });
      coordinator.focus();
      fireEvent.keyDown(coordinator, { key: "End" });
      const perf = screen.getByRole("tab", { name: "Perf" });
      expect(document.activeElement).toBe(perf);

      fireEvent.click(perf, { detail: 0 });

      await waitFor(() =>
        expect(
          screen
            .getByRole("tab", { name: "Perf" })
            .getAttribute("aria-selected"),
        ).toBe("true"),
      );
      const selected = screen.getByRole("tab", { name: "Perf" });
      expect(selected).not.toBe(perf);
      expect(document.activeElement).toBe(selected);
      expect(selected.tabIndex).toBe(0);
    });

    it("leaves focus to the thread after a pointer click", async () => {
      renderNavigating();

      fireEvent.click(screen.getByRole("tab", { name: "Perf" }), {
        detail: 1,
      });

      await waitFor(() =>
        expect(
          screen
            .getByRole("tab", { name: "Perf" })
            .getAttribute("aria-selected"),
        ).toBe("true"),
      );
      expect(document.activeElement).toBe(document.body);
    });
  });

  describe("keeping the selected tab in view", () => {
    const TAB_WIDTH = 100;
    const VIEWPORT_WIDTH = 200;
    let tabs: ExperimentalThreadGroup["tabs"] = [];

    beforeEach(() => {
      const scrollLeft = new WeakMap<Element, number>();
      vi.spyOn(Element.prototype, "scrollLeft", "get").mockImplementation(
        function (this: Element) {
          return scrollLeft.get(this) ?? 0;
        },
      );
      vi.spyOn(Element.prototype, "scrollLeft", "set").mockImplementation(
        function (this: Element, value: number) {
          const tabCount = this.firstElementChild?.children.length ?? 0;
          const max = Math.max(0, tabCount * TAB_WIDTH - VIEWPORT_WIDTH);
          scrollLeft.set(this, Math.min(max, Math.max(0, value)));
        },
      );
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
        function (this: Element) {
          const tab = this.closest("[data-thread-group-tab]");
          if (tab === null) {
            return DOMRect.fromRect({
              x: 0,
              width: VIEWPORT_WIDTH,
              height: 28,
            });
          }
          const content = tab.parentElement!;
          const viewport = content.parentElement!;
          const index = [...content.children].indexOf(tab);
          return DOMRect.fromRect({
            x: index * TAB_WIDTH - viewport.scrollLeft,
            width: TAB_WIDTH,
            height: 28,
          });
        },
      );
    });

    function renderGroup() {
      registerGroups(["initiatives", groupSlot(() => ({ tabs }))]);
      const view = render(
        <TooltipProvider>
          <PaneContext.Provider value={paneContext()}>
            <PluginThreadGroupTabs
              fallback={<p>Plain title</p>}
              projectId="proj_app"
              threadId={COORDINATOR}
            />
          </PaneContext.Provider>
        </TooltipProvider>,
        { wrapper: createQueryClientTestHarness().wrapper },
      );
      const rerender = (next: ExperimentalThreadGroup["tabs"]) => {
        tabs = next;
        view.rerender(
          <TooltipProvider>
            <PaneContext.Provider value={paneContext()}>
              <PluginThreadGroupTabs
                fallback={<p>Plain title</p>}
                projectId="proj_app"
                threadId={COORDINATOR}
              />
            </PaneContext.Provider>
          </TooltipProvider>,
        );
      };
      const viewport = () =>
        screen.getByRole("tab", { selected: true }).parentElement!
          .parentElement!;
      return { rerender, viewport };
    }

    const discussions = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        threadId: `thr_discussion_${index}`,
        label: `Discussion ${index}`,
      }));

    it("reveals the selected tab when tabs are inserted before it", () => {
      tabs = [{ threadId: AUTH, label: "Auth" }, { threadId: COORDINATOR }];
      const { rerender, viewport } = renderGroup();
      expect(viewport().scrollLeft).toBe(0);

      rerender([...discussions(7), ...tabs, { threadId: PERF, label: "Perf" }]);

      expect(viewport().scrollLeft).toBe(900 - VIEWPORT_WIDTH + 24);
    });

    it("leaves the scroll position alone for a fresh but identical group", () => {
      tabs = [...discussions(7), { threadId: COORDINATOR }];
      const { rerender, viewport } = renderGroup();
      viewport().scrollLeft = 0;

      rerender([...tabs]);

      expect(viewport().scrollLeft).toBe(0);
    });

    it("reveals the selected tab when another tab is pinned or unpinned", () => {
      tabs = [...discussions(7), { threadId: COORDINATOR }];
      const { rerender, viewport } = renderGroup();
      viewport().scrollLeft = 0;

      rerender([{ ...tabs[0]!, pinned: true }, ...tabs.slice(1)]);

      expect(viewport().scrollLeft).toBeGreaterThan(0);
    });
  });

  describe("threads missing from the sidebar", () => {
    const ARCHIVED = "thr_archived";
    const GONE = "thr_gone";

    it("resolves titles from the Archive list and detail, in two batches", async () => {
      sdkThreads.list.mockResolvedValue([
        makeThreadListEntry({
          id: ARCHIVED,
          projectId: "proj_app",
          title: "Old auth thread",
          archivedAt: 1,
        }),
      ]);
      let rejectGone: (error: Error) => void = () => {};
      sdkThreads.get.mockImplementation(
        () =>
          new Promise((_, reject) => {
            rejectGone = reject;
          }),
      );
      registerGroups([
        "initiatives",
        groupSlot(() => ({
          tabs: [
            { threadId: COORDINATOR, pinned: true },
            { threadId: ARCHIVED },
            { threadId: GONE },
          ],
        })),
      ]);
      renderTabs(COORDINATOR, paneContext(), [COORDINATOR]);

      const coordinator = screen.getAllByRole("tab")[0]!;
      expect(coordinator.textContent).toBe("Test thread");

      await waitFor(() =>
        expect(
          screen.getByRole("tab", { name: "Old auth thread, Archived thread" }),
        ).toBeTruthy(),
      );
      const gone = screen.getByRole("tab", { name: "Loading thread" });
      expect(gone.getAttribute("aria-busy")).toBe("true");

      await act(async () => rejectGone(new Error("not found")));

      await waitFor(() =>
        expect(
          screen.getByRole("tab", {
            name: "Unavailable thread, Thread unavailable",
          }),
        ).toBeTruthy(),
      );
      expect(sdkThreads.list).toHaveBeenCalledTimes(1);
      expect(sdkThreads.list).toHaveBeenCalledWith(
        expect.objectContaining({ archived: true }),
      );
      expect(sdkThreads.get).toHaveBeenCalledTimes(1);
      expect(sdkThreads.get).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: GONE }),
      );
    });

    it("shows cached titles while the sidebar is still loading, without fetching", () => {
      state.navigationPending = true;
      registerGroups(["initiatives", groupSlot(() => INITIATIVE)]);
      renderTabs(AUTH, paneContext(), [COORDINATOR, AUTH]);

      expect(
        screen.getAllByRole("tab").map((tab) => tab.getAttribute("title")),
      ).toEqual(["Coordinator", "Test thread", "Perf · Loading"]);
      expect(sdkThreads.list).not.toHaveBeenCalled();
      expect(sdkThreads.get).not.toHaveBeenCalled();
    });

    it("keeps a plugin label while the thread is still loading", () => {
      sdkThreads.list.mockReturnValue(new Promise(() => {}));
      registerGroups([
        "initiatives",
        groupSlot(() => ({
          tabs: [
            { threadId: COORDINATOR },
            { threadId: ARCHIVED, label: "Retro" },
          ],
        })),
      ]);
      renderTabs(COORDINATOR, paneContext(), [COORDINATOR]);

      expect(
        screen
          .getByRole("tab", { name: "Retro, Loading" })
          .getAttribute("aria-busy"),
      ).toBe("true");
    });
  });
});
