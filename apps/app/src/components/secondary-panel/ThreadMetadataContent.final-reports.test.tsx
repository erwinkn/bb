// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { makeThread } from "@bb/test-helpers/domain-fixtures";
import type { ParentNoticesMode } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FinalReportsOnlyRow } from "./ThreadMetadataContent";

afterEach(cleanup);

function renderRow(args: {
  mode: ParentNoticesMode;
  parentThreadId: string | null;
  onChange?: (mode: ParentNoticesMode) => void;
}) {
  const onChange = args.onChange ?? vi.fn();
  render(
    <TooltipProvider>
      <dl>
        <FinalReportsOnlyRow
          thread={makeThread({ parentThreadId: args.parentThreadId })}
          parentNotices={{ mode: args.mode, onChange }}
          disabled={false}
        />
      </dl>
    </TooltipProvider>,
  );
  return onChange;
}

describe("FinalReportsOnlyRow", () => {
  it("turns final reports on for a child", () => {
    const onChange = renderRow({ mode: "turns", parentThreadId: "thr_parent" });
    const toggle = screen.getByRole("switch", { name: "Final reports only" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith("explicit");
  });

  it("turns final reports off again", () => {
    const onChange = renderRow({
      mode: "explicit",
      parentThreadId: "thr_parent",
    });
    const toggle = screen.getByRole("switch", { name: "Final reports only" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith("turns");
  });

  it("is hidden for a thread without a parent", () => {
    renderRow({ mode: "turns", parentThreadId: null });
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
