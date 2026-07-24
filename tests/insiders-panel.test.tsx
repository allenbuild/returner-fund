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
  it("renders the built-in list immediately while private overrides load", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

    render(<InsidersPanel onClose={vi.fn()} />);

    expect(screen.getByText("58 insiders")).toBeInTheDocument();
    expect(screen.getByText("Paul Graham")).toBeInTheDocument();
    expect(screen.queryByText("Loading your list…")).not.toBeInTheDocument();
    expect(screen.queryByText("Your private audience for personalized attention scoring.")).not.toBeInTheDocument();
  });

  it("offers an email sign-in path when the private editor has no session", async () => {
    const anonymous = { ...response(), authenticated: false };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(anonymous), { status: 200 })
    ));

    render(<InsidersPanel onClose={vi.fn()} />);

    expect(await screen.findByText("Sign in to edit your private list")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Email address" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Email sign-in link" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decrease Paul Graham weight" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Increase Paul Graham weight" })).toBeDisabled();
  });

  it("ranks insiders by descending weight with a name tie-break and omits source badges", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response()), { status: 200 })
    ));

    const { container } = render(<InsidersPanel onClose={vi.fn()} />);
    await screen.findByText("58 insiders");

    const names = [...container.querySelectorAll(".insider-row-copy strong")]
      .slice(0, 4)
      .map((element) => element.textContent);
    expect(names).toEqual(["Ben Horowitz", "Marc Andreessen", "Michael Seibel", "Paul Graham"]);
    expect(screen.queryByText("Default")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Recompute scores" })).not.toBeInTheDocument();
  });

  it("preserves the initially ranked row order while weights are staged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response()), { status: 200 })
    ));

    const { container } = render(<InsidersPanel onClose={vi.fn()} />);
    await screen.findByText("58 insiders");
    const names = () => [...container.querySelectorAll(".insider-row-copy strong")]
      .map((element) => element.textContent);
    const initialOrder = names();

    fireEvent.click(screen.getByRole("button", { name: "Decrease Ben Horowitz weight" }));
    fireEvent.click(screen.getByRole("button", { name: "Increase Dalton Caldwell weight" }));

    expect(screen.getByLabelText("Ben Horowitz weight")).toHaveTextContent("4");
    expect(screen.getByLabelText("Dalton Caldwell weight")).toHaveTextContent("5");
    expect(names()).toEqual(initialOrder);
  });

  it("stages stepper edits until one save and keeps all 58 defaults searchable", async () => {
    const initial = response();
    const saved = {
      ...initial,
      configuration: {
        ...initial.configuration,
        version: 1,
        weightOverrides: { "paul-graham": 4 }
      },
      effectiveMembers: initial.effectiveMembers.map((member) =>
        member.personId === "paul-graham" ? { ...member, weight: 4 } : member
      )
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(initial), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(saved), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<InsidersPanel onClose={vi.fn()} />);
    expect(await screen.findByText("58 insiders")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search insiders" }), { target: { value: "paulg" } });
    const row = screen.getByText("Paul Graham").closest(".insider-row") as HTMLElement;
    expect(row).toBeInTheDocument();
    expect(within(row).queryByText(/@paulg/i)).not.toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Decrease Paul Graham weight" }));
    expect(within(row).getByLabelText("Paul Graham weight")).toHaveTextContent("4");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Save & recompute" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const request = fetchMock.mock.calls[1][1] as RequestInit;
    expect(request.method).toBe("PUT");
    expect(JSON.parse(String(request.body))).toMatchObject({
      expectedVersion: 0,
      weightOverrides: { "paul-graham": 4 }
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("waits for personalized score recomputation before reporting the save complete", async () => {
    const initial = response();
    const saved = {
      ...initial,
      configuration: {
        ...initial.configuration,
        version: 1,
        weightOverrides: { "paul-graham": 4 }
      },
      effectiveMembers: initial.effectiveMembers.map((member) =>
        member.personId === "paul-graham" ? { ...member, weight: 4 } : member
      )
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(initial), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(saved), { status: 200 })));
    let finishRecompute: (() => void) | undefined;
    const onSaved = vi.fn(() => new Promise<void>((resolve) => {
      finishRecompute = resolve;
    }));

    render(<InsidersPanel onClose={vi.fn()} onSaved={onSaved} />);
    const decrease = await screen.findByRole("button", { name: "Decrease Paul Graham weight" });
    fireEvent.click(decrease);
    fireEvent.click(screen.getByRole("button", { name: "Save & recompute" }));

    expect(await screen.findByText("Recomputing scores…")).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledOnce();
    finishRecompute?.();
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("resets members and weights to the built-in defaults before saving", async () => {
    const initial = response(3);
    initial.configuration = {
      ...initial.configuration,
      excludedDefaultIds: ["michael-seibel"],
      weightOverrides: { "paul-graham": 3 },
      addedInsiders: [{
        personId: "user:x:test-insider",
        displayName: "Test Insider",
        aliases: ["Test Insider"],
        handles: { x: ["test-insider"] },
        category: "insider",
        weight: 5,
        active: true,
        source: "user-added"
      }]
    };
    const saved = response(4);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(initial), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(saved), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<InsidersPanel onClose={vi.fn()} />);
    expect(await screen.findByText("Test Insider")).toBeInTheDocument();
    expect(screen.queryByText("Michael Seibel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    expect(screen.queryByText("Test Insider")).not.toBeInTheDocument();
    expect(screen.getByText("Michael Seibel")).toBeInTheDocument();
    expect(screen.getByLabelText("Paul Graham weight")).toHaveTextContent("5");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect([...container.querySelectorAll(".insider-row-copy strong")]
      .slice(0, 4)
      .map((element) => element.textContent)
    ).toEqual(["Ben Horowitz", "Marc Andreessen", "Michael Seibel", "Paul Graham"]);

    fireEvent.click(screen.getByRole("button", { name: "Save & recompute" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toMatchObject({
      expectedVersion: 3,
      excludedDefaultIds: [],
      weightOverrides: {},
      addedInsiders: []
    });
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
    fireEvent.click(screen.getByRole("button", { name: "Save & recompute" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No changes were saved");
    expect(screen.getByText("57 insiders")).toBeInTheDocument();
    expect(screen.getByText("Not saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save & recompute" })).toBeEnabled();
  });
});
