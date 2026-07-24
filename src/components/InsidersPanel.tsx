"use client";

import {
  Check,
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  Minus,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X
} from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState
} from "react";
import type { Platform, TopVoiceMember } from "@/lib/graph/types";
import {
  configurationResponse,
  createAddedInsider,
  emptyInsiderConfiguration,
  type InsiderConfigurationResponse,
  type UserInsiderConfiguration
} from "@/lib/social/user-insiders";
import {
  insiderApiFetch,
  requestInsiderSignInLink,
  subscribeToInsiderAuth
} from "@/lib/social/user-insiders-client";
import { formatPlatform } from "./PlatformLogo";

const ADD_PLATFORMS = ["x", "linkedin", "github", "instagram", "youtube"] as const satisfies readonly Platform[];

export interface InsidersPanelHandle {
  requestLeave(action: () => void): void;
}

interface InsidersPanelProps {
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void | Promise<void>;
}

interface PendingLeave {
  action: () => void;
}

export const InsidersPanel = forwardRef<InsidersPanelHandle, InsidersPanelProps>(function InsidersPanel(
  { onClose, onDirtyChange, onSaved },
  ref
) {
  const [response, setResponse] = useState<InsiderConfigurationResponse>(() =>
    configurationResponse(emptyInsiderConfiguration(), false)
  );
  const [saved, setSaved] = useState<UserInsiderConfiguration>(() =>
    emptyInsiderConfiguration()
  );
  const [draft, setDraft] = useState<UserInsiderConfiguration>(() =>
    emptyInsiderConfiguration()
  );
  const [memberOrder, setMemberOrder] = useState<string[]>(() => {
    const initialResponse = configurationResponse(emptyInsiderConfiguration(), false);
    return sortMembersByWeight(initialResponse.effectiveMembers).map((member) => member.personId);
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "recomputing" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInSending, setSignInSending] = useState(false);
  const [signInSent, setSignInSent] = useState(false);
  const [query, setQuery] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addWeight, setAddWeight] = useState("1");
  const [addHandles, setAddHandles] = useState<Partial<Record<Platform, string>>>({});
  const [pendingLeave, setPendingLeave] = useState<PendingLeave | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await insiderApiFetch("/api/insiders", { cache: "no-store" });
      if (!result.ok) throw new Error(`Insiders request failed with ${result.status}.`);
      const payload = await result.json() as InsiderConfigurationResponse;
      if (!isInsiderConfigurationResponse(payload)) {
        throw new Error("The Insiders service returned an invalid configuration.");
      }
      const configuration = cloneConfiguration(payload.configuration);
      setResponse(payload);
      setSaved(configuration);
      setDraft(cloneConfiguration(configuration));
      setMemberOrder(
        sortMembersByWeight(resolveEffectiveMembers(payload, configuration))
          .map((member) => member.personId)
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your Insiders list could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => subscribeToInsiderAuth(() => {
    setSignInSent(false);
    void load();
  }), [load]);

  const dirty = useMemo(
    () => Boolean(saved && draft && configurationSignature(saved) !== configurationSignature(draft)),
    [draft, saved]
  );

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!dirty) return undefined;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [dirty]);

  const effectiveMembers = useMemo(() => {
    if (!response || !draft) return [];
    return orderMembers(resolveEffectiveMembers(response, draft), memberOrder);
  }, [draft, memberOrder, response]);

  const visibleMembers = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return effectiveMembers;
    return effectiveMembers.filter((member) =>
      [
        member.displayName,
        member.personId,
        ...member.aliases,
        ...Object.values(member.handles).flat()
      ].join(" ").toLowerCase().includes(normalized)
    );
  }, [effectiveMembers, query]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!draft || !response?.authenticated || saving) return false;
    setSaving(true);
    setError(null);
    setStatus("idle");
    try {
      const result = await insiderApiFetch("/api/insiders", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: draft.version,
          excludedDefaultIds: draft.excludedDefaultIds,
          weightOverrides: draft.weightOverrides,
          addedInsiders: draft.addedInsiders
        })
      });
      const payload = await result.json() as InsiderConfigurationResponse & {
        error?: { message?: string };
      };
      if (!result.ok) throw new Error(payload.error?.message ?? `Save failed with ${result.status}.`);
      setResponse(payload);
      setSaved(cloneConfiguration(payload.configuration));
      setDraft(cloneConfiguration(payload.configuration));
      setStatus("recomputing");
      void Promise.resolve(onSaved?.()).then(
        () => setStatus("saved"),
        (caught: unknown) => {
          setError(caught instanceof Error ? caught.message : "Scores could not be recomputed.");
          setStatus("error");
        }
      );
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "No changes were saved.");
      setStatus("error");
      return false;
    } finally {
      setSaving(false);
    }
  }, [draft, onSaved, response?.authenticated, saving]);

  async function sendSignInLink() {
    const email = signInEmail.trim();
    if (!email) {
      setError("Enter your email address.");
      return;
    }
    setSignInSending(true);
    setError(null);
    try {
      await requestInsiderSignInLink(email);
      setSignInSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The sign-in link could not be sent.");
    } finally {
      setSignInSending(false);
    }
  }

  const requestLeave = useCallback((action: () => void) => {
    if (!dirty) {
      action();
      return;
    }
    setPendingLeave({ action });
  }, [dirty]);

  useImperativeHandle(ref, () => ({ requestLeave }), [requestLeave]);

  function setWeight(member: TopVoiceMember, weight: number) {
    if (!draft) return;
    if (!Number.isInteger(weight) || weight < 1 || weight > 5) {
      setError("Weight must be a whole number from 1 to 5.");
      return;
    }
    setError(null);
    if (member.source === "user-added") {
      setDraft({
        ...draft,
        addedInsiders: draft.addedInsiders.map((candidate) =>
          candidate.personId === member.personId ? { ...candidate, weight } : candidate
        )
      });
      return;
    }
    const weightOverrides = { ...draft.weightOverrides };
    const defaultWeight = response?.defaultMembers.find(
      (candidate) => candidate.personId === member.personId
    )?.weight;
    if (weight === defaultWeight) delete weightOverrides[member.personId];
    else weightOverrides[member.personId] = weight;
    setDraft({ ...draft, weightOverrides });
  }

  function resetToDefaults() {
    if (!draft || !response?.authenticated) return;
    const resetDraft = {
      ...draft,
      excludedDefaultIds: [],
      weightOverrides: {},
      addedInsiders: []
    };
    setDraft(resetDraft);
    setMemberOrder(
      sortMembersByWeight(resolveEffectiveMembers(response, resetDraft))
        .map((member) => member.personId)
    );
    setQuery("");
    setAddOpen(false);
    setError(null);
    setStatus("idle");
  }

  function removeMember(member: TopVoiceMember) {
    if (!draft) return;
    if (member.source === "user-added") {
      setDraft({
        ...draft,
        addedInsiders: draft.addedInsiders.map((candidate) =>
          candidate.personId === member.personId ? { ...candidate, active: false } : candidate
        )
      });
      return;
    }
    const weightOverrides = { ...draft.weightOverrides };
    delete weightOverrides[member.personId];
    setDraft({
      ...draft,
      excludedDefaultIds: [...new Set([...draft.excludedDefaultIds, member.personId])],
      weightOverrides
    });
  }

  function restoreDefault(personId: string) {
    if (!draft) return;
    setDraft({
      ...draft,
      excludedDefaultIds: draft.excludedDefaultIds.filter((candidate) => candidate !== personId)
    });
  }

  function restoreAdded(personId: string) {
    if (!draft) return;
    setDraft({
      ...draft,
      addedInsiders: draft.addedInsiders.map((member) =>
        member.personId === personId ? { ...member, active: true } : member
      )
    });
  }

  function addInsider() {
    if (!draft) return;
    try {
      const handles = Object.fromEntries(
        ADD_PLATFORMS
          .map((platform) => [platform, addHandles[platform]?.trim()])
          .filter((entry): entry is [Platform, string] => Boolean(entry[1]))
          .map(([platform, handle]) => [platform, [handle]])
      ) as Partial<Record<Platform, string[]>>;
      const member = createAddedInsider({
        displayName: addName,
        handles,
        weight: Number(addWeight)
      });
      const allIds = new Set([
        ...response!.defaultMembers.map((candidate) => candidate.personId),
        ...draft.addedInsiders.map((candidate) => candidate.personId)
      ]);
      const allNames = new Set([
        ...response!.defaultMembers.flatMap((candidate) => [candidate.displayName, ...candidate.aliases]),
        ...draft.addedInsiders.flatMap((candidate) => [candidate.displayName, ...candidate.aliases])
      ].map(normalizeName));
      const allHandles = new Set(
        effectiveMembers.flatMap((candidate) =>
          Object.entries(candidate.handles).flatMap(([platform, values]) =>
            (values ?? []).map((value) => `${platform}:${normalizeHandle(value)}`)
          )
        )
      );
      if (allIds.has(member.personId)) throw new Error("That insider is already on the list.");
      if ([member.displayName, ...member.aliases].some((name) => allNames.has(normalizeName(name)))) {
        throw new Error("That insider name or alias is already on the list.");
      }
      for (const [platform, values] of Object.entries(member.handles)) {
        if ((values ?? []).some((value) => allHandles.has(`${platform}:${normalizeHandle(value)}`))) {
          throw new Error(`That ${formatPlatform(platform as Platform)} handle is already on the list.`);
        }
      }
      setDraft({ ...draft, addedInsiders: [...draft.addedInsiders, member] });
      setMemberOrder((current) =>
        current.includes(member.personId) ? current : [...current, member.personId]
      );
      setAddName("");
      setAddWeight("1");
      setAddHandles({});
      setAddOpen(false);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The insider could not be added.");
    }
  }

  function discardAndLeave() {
    if (saved) setDraft(cloneConfiguration(saved));
    const action = pendingLeave?.action;
    setPendingLeave(null);
    window.setTimeout(() => action?.(), 0);
  }

  async function saveAndLeave() {
    const action = pendingLeave?.action;
    if (await save()) {
      setPendingLeave(null);
      window.setTimeout(() => action?.(), 0);
    }
  }

  return (
    <aside className="node-panel insiders-panel" aria-label="Insiders editor">
      <header className="insiders-panel-header">
        <div>
          <span className="eyebrow">Top Voices</span>
          <h2>Insiders</h2>
        </div>
        <div className="insiders-header-actions">
          <button
            type="button"
            className="insiders-reset-button"
            onClick={resetToDefaults}
            disabled={!response.authenticated || saving}
          >
            <RotateCcw size={15} />
            Reset
          </button>
          <button type="button" className="icon-button" aria-label="Close Insiders" onClick={() => requestLeave(onClose)}>
            <X size={18} />
          </button>
        </div>
      </header>

      {!draft || !response ? (
        <div className="insiders-error-state">
          <p>{error ?? "Your Insiders list is unavailable."}</p>
          <button type="button" onClick={() => void load()}>Retry</button>
        </div>
      ) : (
        <>
          {!loading && !response.authenticated && (
            <div className="insiders-auth-note" role="status">
              <strong>Sign in to edit your private list</strong>
              {signInSent ? (
                <p>Check your email for the sign-in link, then return here. Your list will unlock automatically.</p>
              ) : (
                <>
                  <p>Enter your email once to unlock weights, additions, and removals.</p>
                  <div className="insiders-auth-form">
                    <input
                      type="email"
                      value={signInEmail}
                      onChange={(event) => setSignInEmail(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void sendSignInLink();
                      }}
                      placeholder="you@example.com"
                      aria-label="Email address"
                    />
                    <button
                      type="button"
                      className="primary-button"
                      disabled={signInSending}
                      onClick={() => void sendSignInLink()}
                    >
                      {signInSending ? <LoaderCircle className="spin" size={15} /> : null}
                      Email sign-in link
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          <div className="insiders-toolbar">
            <label>
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search names"
                aria-label="Search insiders"
              />
            </label>
            <button
              type="button"
              onClick={() => setAddOpen((open) => !open)}
              disabled={!response.authenticated}
              aria-expanded={addOpen}
            >
              <Plus size={15} />
              Add
              {addOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>

          {addOpen && (
            <section className="insider-add-form" aria-label="Add insider">
              <div className="insider-add-grid">
                <label>
                  <span>Name</span>
                  <input value={addName} onChange={(event) => setAddName(event.target.value)} placeholder="Full name" />
                </label>
                <label>
                  <span>Weight</span>
                  <input
                    type="number"
                    min="1"
                    max="5"
                    step="1"
                    value={addWeight}
                    onChange={(event) => setAddWeight(event.target.value)}
                  />
                </label>
                {ADD_PLATFORMS.map((platform) => (
                  <label key={platform}>
                    <span>{formatPlatform(platform)}</span>
                    <input
                      value={addHandles[platform] ?? ""}
                      onChange={(event) => setAddHandles({ ...addHandles, [platform]: event.target.value })}
                      placeholder="@handle"
                    />
                  </label>
                ))}
              </div>
              <div className="insider-add-actions">
                <button type="button" onClick={() => setAddOpen(false)}>Cancel</button>
                <button type="button" className="primary-button" onClick={addInsider}>Add insider</button>
              </div>
            </section>
          )}

          <div className="insiders-list-summary">
            <strong>{effectiveMembers.length} insiders</strong>
            {visibleMembers.length !== effectiveMembers.length && <span>{visibleMembers.length} matches</span>}
          </div>

          <div className="insiders-list">
            {visibleMembers.map((member) => (
              <article className="insider-row" key={member.personId}>
                <div className="insider-row-copy">
                  <div>
                    <strong>{member.displayName}</strong>
                  </div>
                </div>
                <div className="insider-weight">
                  <span>Weight</span>
                  <div className="insider-weight-stepper">
                    <button
                      type="button"
                      onClick={() => setWeight(member, member.weight - 1)}
                      disabled={!response.authenticated || member.weight <= 1}
                      aria-label={`Decrease ${member.displayName} weight`}
                    >
                      <Minus size={15} strokeWidth={3} />
                    </button>
                    <output aria-label={`${member.displayName} weight`}>{member.weight}</output>
                    <button
                      type="button"
                      onClick={() => setWeight(member, member.weight + 1)}
                      disabled={!response.authenticated || member.weight >= 5}
                      aria-label={`Increase ${member.displayName} weight`}
                    >
                      <Plus size={15} strokeWidth={3} />
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  className="icon-button danger"
                  onClick={() => removeMember(member)}
                  disabled={!response.authenticated}
                  aria-label={`Remove ${member.displayName}`}
                >
                  <Trash2 size={16} />
                </button>
              </article>
            ))}
            {!visibleMembers.length && <div className="empty-state">No insiders match this search.</div>}
          </div>

          {(draft.excludedDefaultIds.length > 0 || draft.addedInsiders.some((member) => !member.active)) && (
            <section className="removed-insiders">
              <strong>Disabled insiders</strong>
              <div>
                {draft.excludedDefaultIds.map((personId) => {
                  const member = response.defaultMembers.find((candidate) => candidate.personId === personId);
                  return (
                    <button type="button" key={personId} onClick={() => restoreDefault(personId)}>
                      <RotateCcw size={13} />
                      Restore {member?.displayName ?? personId}
                    </button>
                  );
                })}
                {draft.addedInsiders.filter((member) => !member.active).map((member) => (
                  <button type="button" key={member.personId} onClick={() => restoreAdded(member.personId)}>
                    <RotateCcw size={13} />
                    Restore {member.displayName}
                  </button>
                ))}
              </div>
            </section>
          )}

          {error && <p className="insiders-inline-error" role="alert">{error}</p>}

          <footer className="insiders-save-footer">
            <div aria-live="polite">
              {status === "recomputing" ? "Recomputing scores…" : saving ? "Saving…" : status === "saved" ? (
                <><Check size={14} /> Saved</>
              ) : status === "error" ? "Not saved" : dirty ? "Unsaved changes" : "No changes"}
            </div>
            <div className="insiders-save-actions">
              <button
                type="button"
                className="primary-button insiders-save-button"
                disabled={!dirty || saving || !response.authenticated}
                onClick={() => void save()}
              >
                {saving ? <LoaderCircle className="spin" size={15} /> : null}
                Save & recompute
              </button>
            </div>
          </footer>

          {pendingLeave && (
            <div className="insiders-leave-prompt" role="dialog" aria-modal="true" aria-labelledby="insiders-leave-title">
              <div>
                <h3 id="insiders-leave-title">Save your Insiders changes?</h3>
                <p>You have staged changes that have not been saved.</p>
                <div>
                  <button type="button" onClick={() => setPendingLeave(null)}>Continue editing</button>
                  <button type="button" onClick={discardAndLeave}>Discard</button>
                  <button type="button" className="primary-button" onClick={() => void saveAndLeave()} disabled={saving}>
                    Save and continue
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </aside>
  );
});

function cloneConfiguration(configuration: UserInsiderConfiguration): UserInsiderConfiguration {
  return {
    ...configuration,
    excludedDefaultIds: [...configuration.excludedDefaultIds],
    weightOverrides: { ...configuration.weightOverrides },
    addedInsiders: configuration.addedInsiders.map((member) => ({
      ...member,
      aliases: [...member.aliases],
      handles: Object.fromEntries(
        Object.entries(member.handles).map(([platform, handles]) => [platform, [...(handles ?? [])]])
      ) as Partial<Record<Platform, string[]>>
    }))
  };
}

function resolveEffectiveMembers(
  response: InsiderConfigurationResponse,
  configuration: UserInsiderConfiguration
): TopVoiceMember[] {
  const excluded = new Set(configuration.excludedDefaultIds);
  const addedById = new Map(
    configuration.addedInsiders.map((member) => [member.personId, member])
  );
  return response.defaultMembers
    .filter((member) => !excluded.has(member.personId))
    .map((member) => ({
      ...member,
      weight: configuration.weightOverrides[member.personId] ?? member.weight
    }))
    .concat([...addedById.values()].filter((member) => member.active));
}

function compareMembersByWeight(left: TopVoiceMember, right: TopVoiceMember): number {
  return right.weight - left.weight ||
    left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" }) ||
    left.personId.localeCompare(right.personId);
}

function sortMembersByWeight(members: TopVoiceMember[]): TopVoiceMember[] {
  return [...members].sort(compareMembersByWeight);
}

function orderMembers(members: TopVoiceMember[], memberOrder: string[]): TopVoiceMember[] {
  const positionById = new Map(memberOrder.map((personId, index) => [personId, index]));
  return [...members].sort((left, right) => {
    const leftPosition = positionById.get(left.personId);
    const rightPosition = positionById.get(right.personId);
    if (leftPosition !== undefined && rightPosition !== undefined) {
      return leftPosition - rightPosition;
    }
    if (leftPosition !== undefined) return -1;
    if (rightPosition !== undefined) return 1;
    return compareMembersByWeight(left, right);
  });
}

function isInsiderConfigurationResponse(value: unknown): value is InsiderConfigurationResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<InsiderConfigurationResponse>;
  const configuration = candidate.configuration as Partial<UserInsiderConfiguration> | undefined;
  return (
    typeof candidate.authenticated === "boolean" &&
    Array.isArray(candidate.defaultMembers) &&
    Array.isArray(candidate.effectiveMembers) &&
    Boolean(configuration) &&
    Array.isArray(configuration?.excludedDefaultIds) &&
    Boolean(configuration?.weightOverrides && typeof configuration.weightOverrides === "object") &&
    Array.isArray(configuration?.addedInsiders)
  );
}

function configurationSignature(configuration: UserInsiderConfiguration): string {
  return JSON.stringify({
    excludedDefaultIds: [...configuration.excludedDefaultIds].sort(),
    weightOverrides: Object.fromEntries(Object.entries(configuration.weightOverrides).sort(([a], [b]) => a.localeCompare(b))),
    addedInsiders: configuration.addedInsiders
  });
}

function normalizeHandle(value: string): string {
  return value.trim().toLowerCase().replace(/^@/, "");
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
