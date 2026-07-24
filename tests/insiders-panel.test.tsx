import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InsidersPanel } from "@/components/InsidersPanel";
import type { InsiderConfigurationResponse } from "@/lib/social/user-insiders";
import { defaultInsiderMembers } from "@/lib/social/top-voices";

function response(version = 0): InsiderConfigurationResponse {
  const defaults = defaultInsiderMembers();
  return {
    authenticated: true,
    defaultsCount: defaults.length,
    defaultMembers: defaults,
    effectiveMembers: defaults,
    configuration: {
      version,
      excludedDefaultIds: [],
      weightOverrides: {},
      addedInsiders: [],
      createdAt: null,
      updatedAt: null
    }
  };
}

describe("InsidersPanel", () => {
  it("stages edits until one save and keeps all 50 defaults searchable", async () => {
    const initial = response();
    const saved = {
      ...initial,
      configuration: {
        ...initial.configuration,
        version: 1,
        weightOverrides: { "paul-graham": 1.5 }
      },
      effectiveMembers: initial.effectiveMembers.map((member) =>
        member.personId === "paul-graham" ? { ...member, weight: 1.5 } : member
      )
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(initial), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(saved), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<InsidersPanel onClose={vi.fn()} />);
    expect(await screen.findByText("50 insiders")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search insiders" }), { target: { value: "paulg" } });
    const row = screen.getByText("Paul Graham").closest(".insider-row") as HTMLElement;
    expect(row).toBeInTheDocument();
    fireEvent.change(within(row).getByRole("spinbutton", { name: "Paul Graham weight" }), { target: { value: "1.5" } });
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const request = fetchMock.mock.calls[1][1] as RequestInit;
    expect(request.method).toBe("PUT");
    expect(JSON.parse(String(request.body))).toMatchObject({
      expectedVersion: 0,
      weightOverrides: { "paul-graham": 1.5 }
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("requires an explicit leave choice and can save before closing", async () => {
    const initial = response();
    const saved = {
      ...initial,
      configuration: {
        ...initial.configuration,
        version: 1,
        excludedDefaultIds: ["paul-graham"]
      },
      effectiveMembers: initial.effectiveMembers.filter((member) => member.personId !== "paul-graham")
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(initial), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(saved), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();

    render(<InsidersPanel onClose={onClose} />);
    const remove = await screen.findByRole("button", { name: "Remove Paul Graham" });
    fireEvent.click(remove);
    fireEvent.click(screen.getByRole("button", { name: "Close Insiders" }));
    expect(screen.getByRole("dialog", { name: "Save your Insiders changes?" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Continue editing" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close Insiders" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("preserves staged state after a failed save", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(response()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "No changes were saved. Please try again." }
      }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<InsidersPanel onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove Paul Graham" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No changes were saved");
    expect(screen.getByText("49 insiders")).toBeInTheDocument();
    expect(screen.getByText("Not saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });
});
