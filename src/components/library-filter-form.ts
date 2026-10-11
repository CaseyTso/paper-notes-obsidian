/**
 * Pending Library Filter form (Task 24 redesign, lane P — stage S2a).
 *
 * A standalone, nonmodal form widget that edits a *pending* draft of the
 * Applied Library Filters and reports a validated snapshot only through
 * `onApply` on an explicit activation. Nothing here writes the library
 * query, the vault or paper metadata, and nothing auto-applies on
 * keystroke / change / blur.
 *
 * Contract highlights (plan v1, S2a):
 * - four numeric controls only — year from/to and IF/JCI minimum; the raw
 *   partial text (`2` → `20` → `200` → `2001`, `0.`, `.5`) survives every
 *   local update because the draft keeps raw strings and the input nodes
 *   are never recreated;
 * - native `validity.badInput` (the browser sanitises `.value` to `""`
 *   while the text is unparseable) is forwarded to the frozen validator,
 *   so an unparseable value can never be read as "unrestricted";
 * - the journal chooser narrows the *displayed* options by the lookup
 *   text; that text is never a filter — only an explicit option
 *   activation sets the pending journal;
 * - per-instance unique ids/labels, field errors wired through
 *   `aria-describedby` + `aria-invalid`, visible focus states, no focus
 *   trap and no focus stealing (S2b owns focus restoration);
 * - a scrollable field region plus a nonshrinking footer, so the later
 *   bounded overlay can cap the height and keep the actions reachable.
 *
 * The overlay/anchoring lifecycle is deliberately NOT implemented here.
 */

import {
  CAS_PARTITION_CHOICES,
  JCR_QUARTILE_CHOICES,
  casPartitionRank,
  createEmptyLibraryFilterDraft,
  createLibraryFilterDraft,
  jcrQuartile,
  validateLibraryFilterDraft,
  type LibraryFilterBadInput,
  type LibraryFilterDraft,
  type NumericFilterField,
} from "./library-filter-draft";
import type { ArtifactPart, LibraryFilters } from "./library-filters";

type ReadingStatus = NonNullable<LibraryFilters["readingStatus"]>;

/** Construction options for {@link LibraryFilterForm}. */
export interface LibraryFilterFormOptions {
  /** Host element the form is appended to (never emptied by the form). */
  container: HTMLElement;
  /** Currently Applied Library Filters the pending draft starts from. */
  filters: LibraryFilters;
  /** Whole-library journal roster (never just the filtered rows). */
  journals: readonly string[];
  /** Called once per explicit Apply with a fresh validated snapshot. */
  onApply(filters: LibraryFilters): void;
  /** Called on Cancel; never carries a filter payload. */
  onCancel(): void;
}

/** Public instance surface of {@link LibraryFilterForm}. */
export interface LibraryFilterFormInstance {
  /** Root element of the form (already appended to the container). */
  readonly element: HTMLElement;
  /** Idempotent local cleanup: listeners removed, form detached. */
  dispose(): void;
  /** Replace the whole-source journal roster, preserving pending state. */
  setJournalOptions(journals: readonly string[]): void;
}

/** One numeric control: which draft field, how it is labelled, raw attrs. */
interface NumericFieldSpec {
  readonly field: NumericFilterField;
  readonly label: string;
  readonly attrs: Record<string, string>;
}

/** A live numeric control plus its error node (created exactly once). */
interface NumericControl {
  readonly field: NumericFilterField;
  readonly input: HTMLInputElement;
  readonly error: HTMLElement;
  readonly errorId: string;
}

const ROOT_CLASS = "paper-notes-library-filter-form";

/**
 * Four numeric controls, and nothing else. Year bounds are four-digit
 * integers; the metric minima are non-negative decimals with no upper
 * bound — no `max` attribute, no spinner slider, no maxima anywhere.
 */
const NUMERIC_FIELDS: readonly NumericFieldSpec[] = [
  {
    field: "yearFrom",
    label: "Year from",
    attrs: { min: "1000", max: "9999", step: "1", inputmode: "numeric" },
  },
  {
    field: "yearTo",
    label: "Year to",
    attrs: { min: "1000", max: "9999", step: "1", inputmode: "numeric" },
  },
  {
    field: "ifMin",
    label: "IF minimum",
    attrs: { min: "0", step: "any", inputmode: "decimal" },
  },
  {
    field: "jciMin",
    label: "JCI minimum",
    attrs: { min: "0", step: "any", inputmode: "decimal" },
  },
];

const ARTIFACT_PARTS: readonly ArtifactPart[] = ["pdf", "minerU", "figure"];
const ARTIFACT_LABELS: Record<ArtifactPart, string> = {
  pdf: "PDF",
  minerU: "MinerU",
  figure: "Figure",
};

const READING_STATUS_CHOICES: readonly ReadingStatus[] = ["unread", "reading", "read"];
const READING_STATUS_LABELS: Record<ReadingStatus, string> = {
  unread: "Unread",
  reading: "Reading",
  read: "Read",
};

/** Upper bound on rendered journal options; a note reports the remainder. */
const MAX_VISIBLE_JOURNAL_OPTIONS = 200;

/**
 * Value prefix for a non-selectable "unsupported current value" placeholder.
 * A raw rank can never begin with this prefix, and the prefix is never empty,
 * so the placeholder value stays disjoint from "Any" and the four finite
 * choices and can be selected explicitly.
 */
const UNSUPPORTED_VALUE_PREFIX = "unsupported:";

/** Monotonic per-process counter so every instance gets unique ids. */
let formInstanceSeq = 0;

/** Trimmed, blank-free, case-insensitively deduplicated roster order. */
function normalizeJournals(journals: readonly string[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of journals) {
    const name = raw.trim();
    if (name.length === 0) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    names.push(name);
  }
  return names;
}

/** Case-folded identity key of one journal name. */
function journalKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Map a known applied CAS/JCR spelling onto the finite choice the select can
 * display (`中科院一区` → `1区`). The applied snapshot itself is untouched;
 * only this private draft copy is canonicalised. Unknown or ambiguous raw
 * values are preserved verbatim rather than silently dropped.
 */
function canonicalizeDraft(draft: LibraryFilterDraft): LibraryFilterDraft {
  const casRank = casPartitionRank(draft.cas);
  if (casRank !== undefined) {
    draft.cas = CAS_PARTITION_CHOICES[casRank - 1];
  }
  const quartile = jcrQuartile(draft.jcr);
  if (quartile !== undefined) {
    draft.jcr = JCR_QUARTILE_CHOICES[quartile - 1];
  }
  return draft;
}

/**
 * Local rank-correspondence guard (the frozen F validator/API is untouched).
 *
 * A draft CAS/JCR value that is neither blank nor a canonical rank/quartile
 * cannot be represented by the finite selectable choices. The raw value is
 * preserved (never rewritten or dropped) and returned here so the form can
 * show it as an unsupported current value and block Apply.
 */
function unsupportedRankValue(
  raw: string | undefined,
  rank: (value: string | undefined) => number | undefined,
): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const text = raw.trim();
  if (text.length === 0) {
    return undefined;
  }
  return rank(text) === undefined ? text : undefined;
}

/** One live journal option button plus its own removable listeners. */
interface JournalOptionRecord {
  readonly key: string;
  readonly name: string;
  readonly node: HTMLElement;
  readonly off: Array<() => void>;
  /** Whether the click listener is currently attached to the node. */
  attached: boolean;
}

export class LibraryFilterForm implements LibraryFilterFormInstance {
  /** Root element, appended to `options.container` by the constructor. */
  readonly element: HTMLElement;

  private readonly idPrefix: string;
  private readonly options: LibraryFilterFormOptions;

  private draft: LibraryFilterDraft;
  private journals: string[];
  /** Journal lookup text — display-only, never a filter by itself. */
  private journalQuery = "";
  private errors: Partial<Record<NumericFilterField, string>> = {};

  private readonly numericControls: NumericControl[] = [];
  private readonly teardown: Array<() => void> = [];
  /** Created once, so Reset never remounts a control. */
  private readonly artifactBoxes: HTMLInputElement[] = [];
  /** Both rank selects, in DOM order (CAS then JCR). */
  private readonly rankControls: RankControl[] = [];
  /**
   * Journal option buttons keyed by case-folded name, kept across renders so a
   * surviving option keeps its DOM node (and native focus).
   */
  private readonly journalOptions = new Map<string, JournalOptionRecord>();
  /** Selected-journal row, built once and updated in place. */
  private selectedRow: {
    readonly host: HTMLElement;
    readonly label: HTMLElement;
    readonly name: HTMLElement;
    readonly empty: HTMLElement;
    readonly clear: HTMLButtonElement;
  } | null = null;


  private applyButton!: HTMLButtonElement;
  private journalQueryInput!: HTMLInputElement;
  private journalSelected!: HTMLElement;
  private journalList!: HTMLElement;
  private journalStatus!: HTMLElement;

  private disposed = false;

  constructor(options: LibraryFilterFormOptions) {
    this.options = options;
    this.idPrefix = `paper-notes-lff-${(formInstanceSeq += 1)}`;
    this.draft = canonicalizeDraft(createLibraryFilterDraft(options.filters));
    this.journals = normalizeJournals(options.journals);

    this.element = options.container.createDiv({ cls: ROOT_CLASS });
    this.build();
    this.refreshValidation();
    this.renderJournalSelection();
    this.renderJournalOptions();
  }

  /** Idempotent: drops every local listener and detaches the form. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const record of this.journalOptions.values()) {
      this.detachOption(record);
    }
    this.journalOptions.clear();
    this.selectedRow = null;
    for (const off of this.teardown.splice(0)) {
      off();
    }
    this.element.remove();
  }

  /**
   * Replace the whole-source roster. Pending numeric values, the selected
   * journal, the lookup text, the field errors and the lookup input node
   * (hence its focus) are all left untouched; only the option list is
   * rebuilt.
   */
  setJournalOptions(journals: readonly string[]): void {
    if (this.disposed) {
      return;
    }
    this.journals = normalizeJournals(journals);
    this.renderJournalOptions();
  }

  // ── construction ───────────────────────────────────────────────────

  private build(): void {
    const root = this.element;
    root.setAttribute("role", "group");
    root.setAttribute("aria-labelledby", `${this.idPrefix}-title`);
    root.createEl("div", {
      cls: `${ROOT_CLASS}-title`,
      text: "Library Filters",
      attr: {
        id: `${this.idPrefix}-title`,
        role: "heading",
        "aria-level": "2",
      },
    });

    const scroller = root.createDiv({ cls: `${ROOT_CLASS}-scroll` });
    this.buildYearSection(scroller);
    this.buildMetricSection(scroller);
    this.buildRankSection(scroller);
    this.buildReadingSection(scroller);
    this.buildArtifactSection(scroller);
    this.buildJournalSection(scroller);

    this.buildFooter(root.createDiv({ cls: `${ROOT_CLASS}-footer` }));
  }

  private buildYearSection(host: HTMLElement): void {
    const section = host.createDiv({ cls: `${ROOT_CLASS}-section` });
    section.createEl("div", {
      cls: `${ROOT_CLASS}-section-title`,
      text: "Publication year",
    });
    const row = section.createDiv({ cls: `${ROOT_CLASS}-row` });
    for (const spec of NUMERIC_FIELDS.slice(0, 2)) {
      this.buildNumericControl(row, spec);
    }
  }

  private buildMetricSection(host: HTMLElement): void {
    const section = host.createDiv({ cls: `${ROOT_CLASS}-section` });
    section.createEl("div", {
      cls: `${ROOT_CLASS}-section-title`,
      text: "Journal metrics (minimum only)",
    });
    const row = section.createDiv({ cls: `${ROOT_CLASS}-row` });
    for (const spec of NUMERIC_FIELDS.slice(2)) {
      this.buildNumericControl(row, spec);
    }
  }

  private buildRankSection(host: HTMLElement): void {
    const section = host.createDiv({ cls: `${ROOT_CLASS}-section` });
    section.createEl("div", {
      cls: `${ROOT_CLASS}-section-title`,
      text: "Journal rank",
    });
    const row = section.createDiv({ cls: `${ROOT_CLASS}-row` });
    this.buildRankSelect(row, "cas", "CAS partition", [
      { value: "", label: "Any" },
      ...CAS_PARTITION_CHOICES.map((choice) => ({ value: choice, label: choice })),
    ]);
    this.buildRankSelect(row, "jcr", "JCR quartile", [
      { value: "", label: "Any" },
      ...JCR_QUARTILE_CHOICES.map((choice) => ({ value: choice, label: choice })),
    ]);
  }

  /**
   * A rank select with an optional non-selectable "current value" placeholder.
   *
   * When the pending value is not representable by the finite choices, the
   * raw value is kept verbatim in the draft and surfaced as a disabled
   * placeholder option plus a per-field error, so the user sees what is
   * currently pending instead of a misleading "Any".
   */
  private buildRankSelect(
    host: HTMLElement,
    key: "cas" | "jcr",
    label: string,
    entries: readonly { value: string; label: string }[],
  ): RankControl {
    const wrap = host.createDiv({ cls: `${ROOT_CLASS}-field` });
    const selectId = `${this.idPrefix}-${key}`;
    const errorId = `${selectId}-error`;
    wrap.createEl("label", {
      cls: `${ROOT_CLASS}-label`,
      text: label,
      attr: { for: selectId },
    });
    const select = wrap.createEl("select", {
      cls: `${ROOT_CLASS}-select`,
      attr: { id: selectId },
    });
    const error = wrap.createEl("div", {
      cls: `${ROOT_CLASS}-error`,
      attr: { id: errorId, role: "alert", hidden: "" },
    });
    const control: RankControl = { key, select, error, errorId, placeholder: null };
    this.rankControls.push(control);
    for (const entry of entries) {
      select.createEl("option", { value: entry.value, text: entry.label });
    }
    this.listen(select, "change", () => {
      const value = select.value;
      if (key === "cas") {
        this.draft.cas = value.length > 0 ? value : undefined;
      } else {
        this.draft.jcr = value.length > 0 ? value : undefined;
      }
      this.refreshValidation();
    });
    this.renderRankValue(control);
    return control;
  }

  /**
   * Render one rank select against the pending draft value: canonical value,
   * "Any", or the unsupported current-value placeholder with an error.
   */
  private renderRankValue(control: RankControl): void {
    const raw = control.key === "cas" ? this.draft.cas : this.draft.jcr;
    const rank = control.key === "cas" ? casPartitionRank : jcrQuartile;
    const fieldLabel = control.key === "cas" ? "CAS partition" : "JCR quartile";
    const unsupported = unsupportedRankValue(raw, rank);
    const placeholder = control.placeholder;
    if (unsupported === undefined) {
      if (placeholder !== null) {
        placeholder.remove();
        control.placeholder = null;
      }
      control.select.value = raw !== undefined && raw.trim().length > 0 ? raw.trim() : "";
      control.error.setAttribute("hidden", "");
      control.error.textContent = "";
      control.select.setAttribute("aria-invalid", "false");
      control.select.removeAttribute("aria-describedby");
      return;
    }
    // The placeholder must carry a UNIQUE NON-EMPTY value: an empty value
    // would collide with the native "Any" option, so `select.value = ""`
    // would silently select Any instead of surfacing the unsupported value.
    // The trimmed raw text is disjoint from Any and the four valid choices.
    const placeholderValue = UNSUPPORTED_VALUE_PREFIX + unsupported;
    if (placeholder === null) {
      control.placeholder = selectCreateOption(
        control.select,
        placeholderValue,
        `Unsupported current value: ${unsupported} — choose Any or a valid ${fieldLabel}`,
        true,
      );
    } else {
      placeholder.value = placeholderValue;
      placeholder.textContent = `Unsupported current value: ${unsupported} — choose Any or a valid ${fieldLabel}`;
      placeholder.setAttribute("disabled", "");
    }
    control.select.value = placeholderValue;
    control.error.removeAttribute("hidden");
    control.error.textContent = `Unsupported ${fieldLabel} "${unsupported}" cannot be applied. Choose Any or a valid ${fieldLabel}, or Reset.`;
    control.select.setAttribute("aria-invalid", "true");
    control.select.setAttribute("aria-describedby", control.errorId);
  }

  /** Refresh both rank selects (and their guards) against the draft. */
  private renderRankValues(): void {
    for (const control of this.rankControls) {
      this.renderRankValue(control);
    }
  }


  private buildReadingSection(host: HTMLElement): void {
    const section = host.createDiv({ cls: `${ROOT_CLASS}-section` });
    section.createEl("div", {
      cls: `${ROOT_CLASS}-section-title`,
      text: "Reading status",
    });
    const row = section.createDiv({ cls: `${ROOT_CLASS}-row` });
    this.readingSelect = this.buildSelect(
      row,
      "reading",
      "Reading status",
      [
        { value: "", label: "Any" },
        ...READING_STATUS_CHOICES.map((choice) => ({
          value: choice,
          label: READING_STATUS_LABELS[choice],
        })),
      ],
      this.draft.readingStatus ?? "",
      (value) => {
        this.draft.readingStatus =
          value.length > 0 ? (value as ReadingStatus) : undefined;
      },
    );
  }

  private buildArtifactSection(host: HTMLElement): void {
    const section = host.createDiv({ cls: `${ROOT_CLASS}-section` });
    section.createEl("div", {
      cls: `${ROOT_CLASS}-section-title`,
      text: "Required artifacts",
    });
    const row = section.createDiv({ cls: `${ROOT_CLASS}-row` });
    for (const part of ARTIFACT_PARTS) {
      const id = `${this.idPrefix}-artifact-${part}`;
      const wrap = row.createDiv({ cls: `${ROOT_CLASS}-check` });
      wrap.createEl("label", {
        cls: `${ROOT_CLASS}-check-label`,
        text: ARTIFACT_LABELS[part],
        attr: { for: id },
      });
      const box = wrap.createEl("input", {
        cls: `${ROOT_CLASS}-checkbox`,
        attr: { type: "checkbox", id },
      });
      box.checked = this.draft.requiredArtifacts.includes(part);
      this.artifactBoxes.push(box);
      this.listen(box, "change", () => {
        this.draft.requiredArtifacts = box.checked
          ? appendArtifact(this.draft.requiredArtifacts, part)
          : this.draft.requiredArtifacts.filter((existing) => existing !== part);
        this.refreshValidation();
      });
    }
  }

  private buildJournalSection(host: HTMLElement): void {
    const section = host.createDiv({ cls: `${ROOT_CLASS}-section` });
    section.createEl("div", {
      cls: `${ROOT_CLASS}-section-title`,
      text: "Journal filter",
    });
    const group = section.createDiv({ cls: `${ROOT_CLASS}-journal` });

    const queryId = `${this.idPrefix}-journal-query`;
    group.createEl("label", {
      cls: `${ROOT_CLASS}-label`,
      text: "Search journals",
      attr: { for: queryId },
    });
    // The lookup text only narrows the option list; it is never applied.
    this.journalQueryInput = group.createEl("input", {
      cls: `${ROOT_CLASS}-input ${ROOT_CLASS}-journal-query`,
      attr: {
        type: "search",
        id: queryId,
        autocomplete: "off",
        placeholder: "Search journals…",
      },
    });
    this.journalQueryInput.value = this.journalQuery;
    this.listen(this.journalQueryInput, "input", () => {
      this.journalQuery = this.journalQueryInput.value;
      this.renderJournalOptions();
    });

    this.journalSelected = group.createDiv({
      cls: `${ROOT_CLASS}-journal-selected`,
    });
    this.journalList = group.createDiv({
      cls: `${ROOT_CLASS}-journal-list`,
      attr: { role: "group", "aria-label": "Journal options" },
    });
    this.journalStatus = group.createDiv({
      cls: `${ROOT_CLASS}-journal-status`,
      attr: { hidden: "", role: "status" },
    });
  }

  private buildNumericControl(host: HTMLElement, spec: NumericFieldSpec): void {
    const wrap = host.createDiv({ cls: `${ROOT_CLASS}-field` });
    const inputId = `${this.idPrefix}-${spec.field}`;
    const errorId = `${inputId}-error`;
    wrap.createEl("label", {
      cls: `${ROOT_CLASS}-label`,
      text: spec.label,
      attr: { for: inputId },
    });
    const input = wrap.createEl("input", {
      cls: `${ROOT_CLASS}-input`,
      attr: { type: "number", id: inputId, ...spec.attrs },
    });
    input.value = this.draft[spec.field];
    const error = wrap.createEl("div", {
      cls: `${ROOT_CLASS}-error`,
      attr: { id: errorId, role: "alert", hidden: "" },
    });
    this.numericControls.push({ field: spec.field, input, error, errorId });
    this.listen(input, "input", () => {
      // Raw text only: no parsing, rounding or clamping here.
      this.draft[spec.field] = input.value;
      this.refreshValidation();
    });
    this.listen(input, "blur", () => this.refreshValidation());
  }

  private buildSelect(
    host: HTMLElement,
    key: string,
    label: string,
    entries: readonly { value: string; label: string }[],
    initial: string,
    assign: (value: string) => void,
  ): HTMLSelectElement {
    const wrap = host.createDiv({ cls: `${ROOT_CLASS}-field` });
    const selectId = `${this.idPrefix}-${key}`;
    wrap.createEl("label", {
      cls: `${ROOT_CLASS}-label`,
      text: label,
      attr: { for: selectId },
    });
    const select = wrap.createEl("select", {
      cls: `${ROOT_CLASS}-select`,
      attr: { id: selectId },
    });
    for (const entry of entries) {
      select.createEl("option", { value: entry.value, text: entry.label });
    }
    select.value = initial;
    this.listen(select, "change", () => {
      assign(select.value);
      this.refreshValidation();
    });
    return select;
  }

  private readingSelect!: HTMLSelectElement;

  private buildFooter(host: HTMLElement): void {
    const reset = host.createEl("button", {
      cls: `${ROOT_CLASS}-button`,
      attr: { type: "button" },
      text: "Reset",
    });
    this.listen(reset, "click", () => this.handleReset());

    const cancel = host.createEl("button", {
      cls: `${ROOT_CLASS}-button`,
      attr: { type: "button" },
      text: "Cancel",
    });
    this.listen(cancel, "click", () => this.handleCancel());

    this.applyButton = host.createEl("button", {
      cls: `${ROOT_CLASS}-button ${ROOT_CLASS}-button-primary`,
      attr: { type: "button" },
      text: "Apply",
    });
    // A native button already emits `click` for Enter and Space, so no
    // extra keyboard-submit handler exists and a journal option can never
    // submit the form.
    this.listen(this.applyButton, "click", () => this.handleApply());
  }

  // ── local state ────────────────────────────────────────────────────

  /**
   * Re-validate the draft and refresh only the affected DOM.
   *
   * Besides the frozen numeric validation this also enforces the local
   * rank-correspondence guard: an unsupported current CAS/JCR value keeps
   * Apply disabled even though the pure validator would accept the raw
   * string. The frozen F validator/API is never modified.
   */
  private refreshValidation(): void {
    if (this.disposed) {
      return;
    }
    const result = validateLibraryFilterDraft(this.draft, this.readBadInput());
    this.errors = result.errors;
    this.renderRankValues();
    const unsupportedRank =
      unsupportedRankValue(this.draft.cas, casPartitionRank) !== undefined ||
      unsupportedRankValue(this.draft.jcr, jcrQuartile) !== undefined;
    for (const control of this.numericControls) {
      const message = this.errors[control.field];
      if (message === undefined) {
        control.error.setAttribute("hidden", "");
        control.error.textContent = "";
        control.input.setAttribute("aria-invalid", "false");
        control.input.removeAttribute("aria-describedby");
      } else {
        control.error.removeAttribute("hidden");
        control.error.textContent = message;
        control.input.setAttribute("aria-invalid", "true");
        control.input.setAttribute("aria-describedby", control.errorId);
      }
    }
    this.applyButton.disabled = result.filters === undefined || unsupportedRank;
  }

  /** Live `validity.badInput` per numeric control (never the `.value`). */
  private readBadInput(): LibraryFilterBadInput {
    const bad: LibraryFilterBadInput = {};
    for (const control of this.numericControls) {
      if (control.input.validity?.badInput === true) {
        bad[control.field] = true;
      }
    }
    return bad;
  }

  /**
   * Selected-journal row, built once. Every update mutates text/hidden in
   * place, so no listener ever accumulates on a detached Clear button.
   */
  private renderJournalSelection(): void {
    if (this.disposed) {
      return;
    }
    const host = this.journalSelected;
    if (this.selectedRow === null) {
      const label = host.createEl("span", {
        cls: `${ROOT_CLASS}-journal-selected-label`,
        text: "Selected journal:",
      });
      const name = host.createEl("span", {
        cls: `${ROOT_CLASS}-journal-selected-name`,
      });
      const clear = host.createEl("button", {
        cls: `${ROOT_CLASS}-journal-clear`,
        attr: { type: "button", "aria-label": "Clear selected journal" },
        text: "Clear",
      });
      const empty = host.createEl("span", {
        cls: `${ROOT_CLASS}-journal-selected-empty`,
        text: "No journal selected",
      });
      this.listen(clear, "click", () => {
        this.draft.journal = undefined;
        // A focused Clear button becomes hidden here: hand focus to the
        // lookup so the user is never left on an invisible control.
        const wasFocused = isFocused(clear);
        this.renderJournalSelection();
        this.renderJournalOptions();
        this.refreshValidation();
        if (wasFocused) {
          this.journalQueryInput.focus();
        }
      });
      this.selectedRow = { host, label, name, empty, clear };
    }

    const row = this.selectedRow;
    const name = this.draft.journal;
    const hasSelection = name !== undefined && name.trim().length > 0;
    row.name.textContent = hasSelection ? (name as string) : "";
    setHidden(row.name, !hasSelection);
    setHidden(row.label, !hasSelection);
    setHidden(row.clear, !hasSelection);
    setHidden(row.empty, hasSelection);
  }

  /**
   * Reconcile the option list against the current roster and lookup.
   *
   * Surviving option buttons keep their DOM node (and therefore native
   * focus/caret); only newly matched names create nodes and only removed
   * names detach theirs. The lookup input, the numeric controls and the
   * pending draft are never touched. When the focused option disappears,
   * focus is deliberately handed to the lookup input.
   */
  private renderJournalOptions(): void {
    if (this.disposed) {
      return;
    }
    const list = this.journalList;
    const needle = this.journalQuery.trim().toLowerCase();
    const selected = journalKey(this.draft.journal ?? "");

    // The exact case-folded match for the lookup is always reachable, even
    // when the full roster is longer than the render limit.
    const matched =
      needle.length === 0
        ? this.journals
        : this.journals.filter((name) => journalKey(name).includes(needle));
    const visible: string[] = [];
    for (const name of matched) {
      if (journalKey(name) === needle) {
        visible.push(name);
        break;
      }
    }
    for (const name of matched) {
      if (visible.length >= MAX_VISIBLE_JOURNAL_OPTIONS) {
        break;
      }
      if (!visible.includes(name)) {
        visible.push(name);
      }
    }

    const visibleKeys = new Set(visible.map(journalKey));
    // Capture the focused surviving option BEFORE any DOM operation, so a
    // necessary move can restore exactly that button afterwards.
    const focusedKey = focusedJournalKey(list);
    const focusedWillSurvive = focusedKey !== undefined && visibleKeys.has(focusedKey);
    const focusedRecord = focusedKey === undefined ? undefined : this.journalOptions.get(focusedKey);

    // Drop options that are no longer visible, removing their listeners so no
    // stale handler can fire from a detached node.
    for (const [key, record] of this.journalOptions) {
      if (!visibleKeys.has(key)) {
        this.detachOption(record);
      }
    }

    // Create missing nodes, then re-append in roster order only when the
    // order actually changed, so unchanged rosters never move nodes.
    let cursor = list.firstChild;
    for (const name of visible) {
      const key = journalKey(name);
      let record = this.journalOptions.get(key);
      if (record === undefined) {
        const node = list.ownerDocument.createElement("button");
        node.setAttribute("type", "button");
        node.setAttribute("title", name);
        node.addClass(`${ROOT_CLASS}-journal-option`);
        const span = list.ownerDocument.createElement("span");
        span.addClass(`${ROOT_CLASS}-journal-option-name`);
        span.textContent = name;
        node.appendChild(span);
        const off: Array<() => void> = [];
        // Single selection: activating one option replaces the previous one.
        this.listen(
          node,
          "click",
          () => {
            this.draft.journal = name;
            this.renderJournalSelection();
            this.renderJournalOptions();
            this.refreshValidation();
          },
          off,
        );
        record = { key, name, node, off, attached: true };
        this.journalOptions.set(key, record);
      } else if (!record.attached) {
        // A previously detached node came back: re-attach its listener.
        for (const off of record.off) {
          off();
        }
        record.off.length = 0;
        this.listen(
          record.node,
          "click",
          () => {
            this.draft.journal = record?.name ?? name;
            this.renderJournalSelection();
            this.renderJournalOptions();
            this.refreshValidation();
          },
          record.off,
        );
        record.attached = true;
      }
      const expected = cursor;
      // Unconditional insertBefore for new, reinserted and reordered nodes:
      // appending first and then moving would displace the trailing suffix
      // (e.g. an already-focused Science) for no reason.
      if (expected !== record.node) {
        list.insertBefore(record.node, expected);
      }
      cursor = record.node.nextSibling;
    }

    // Update selection state in place; the nodes themselves are untouched.
    for (const [key, record] of this.journalOptions) {
      const isSelected = key === selected;
      if (isSelected) {
        record.node.addClass("is-selected");
      } else {
        record.node.removeClass("is-selected");
      }
      record.node.setAttribute("aria-pressed", isSelected ? "true" : "false");
    }

    // Restore focus on the SAME surviving button when the reconciliation
    // necessarily dislodged it; a choice that disappeared still hands focus
    // to the lookup. Unchanged order/selection never touches focus.
    if (focusedWillSurvive && focusedRecord !== undefined) {
      if (list.ownerDocument.activeElement !== focusedRecord.node) {
        focusedRecord.node.focus();
      }
    } else if (focusedKey !== undefined && !visibleKeys.has(focusedKey)) {
      this.journalQueryInput.focus();
    }

    if (matched.length === 0) {
      this.setJournalStatus("No journals match the search.");
      return;
    }
    if (matched.length > visible.length) {
      this.setJournalStatus(
        `Showing ${visible.length} of ${matched.length} journals — refine the search.`,
      );
      return;
    }
    this.setJournalStatus("");
  }

  private setJournalStatus(text: string): void {
    if (text.length === 0) {
      this.journalStatus.setAttribute("hidden", "");
      this.journalStatus.textContent = "";
      return;
    }
    this.journalStatus.removeAttribute("hidden");
    this.journalStatus.textContent = text;
  }

  /** Detach one option node and remove its listeners (kept for reuse). */
  private detachOption(record: JournalOptionRecord): void {
    for (const off of record.off) {
      off();
    }
    record.off.length = 0;
    record.attached = false;
    record.node.remove();
  }

  // ── actions ────────────────────────────────────────────────────────

  /**
   * Reset clears ONLY the pending draft, the journal lookup text and the
   * field errors. Applied Library Filters are untouched and `onApply` is
   * never called.
   */
  private handleReset(): void {
    if (this.disposed) {
      return;
    }
    this.draft = createEmptyLibraryFilterDraft();
    this.journalQuery = "";
    this.errors = {};
    // Explicit user action, so pushing the cleared draft back into the
    // existing controls is allowed — the nodes themselves are reused.
    for (const control of this.numericControls) {
      control.input.value = "";
    }
    this.readingSelect.value = "";
    for (const box of this.artifactBoxes) {
      box.checked = false;
    }
    this.journalQueryInput.value = "";
    this.refreshValidation();
    this.renderJournalSelection();
    this.renderJournalOptions();
  }

  /** Cancel emits no filter payload at all. */
  private handleCancel(): void {
    if (this.disposed) {
      return;
    }
    this.options.onCancel();
  }

  /**
   * Explicit activation only. Revalidates (the guard matters because a
   * disabled button can still be clicked programmatically) and emits a
   * fresh canonical snapshot at most once.
   *
   * The local rank guard is enforced here too, so an unsupported current
   * CAS/JCR value can never be applied even if the button is invoked
   * directly.
   */
  private handleApply(): void {
    if (this.disposed) {
      return;
    }
    const result = validateLibraryFilterDraft(this.draft, this.readBadInput());
    this.errors = result.errors;
    this.refreshValidation();
    if (result.filters === undefined) {
      return;
    }
    if (
      unsupportedRankValue(this.draft.cas, casPartitionRank) !== undefined ||
      unsupportedRankValue(this.draft.jcr, jcrQuartile) !== undefined
    ) {
      return;
    }
    this.options.onApply(result.filters);
  }

  private listen(
    target: HTMLElement,
    type: string,
    handler: () => void,
    bucket: Array<() => void> = this.teardown,
  ): void {
    target.addEventListener(type, handler);
    bucket.push(() => target.removeEventListener(type, handler));
  }

}

/** Add/remove the `hidden` attribute so visibility matches `hidden`. */
function setHidden(el: HTMLElement, hidden: boolean): void {
  if (hidden) {
    el.setAttribute("hidden", "");
  } else {
    el.removeAttribute("hidden");
  }
}

/**
 * Whether a control currently owns focus. Simulated in the mock tests via
 * `ownerDocument.activeElement`; NOT a proof of real browser focus.
 */
function isFocused(el: HTMLElement): boolean {
  return el.ownerDocument?.activeElement === el;
}

/**
 * Case-folded key of the focused journal option inside `list`, if any. Read
 * from the list's own owner document so the helper never depends on a global
 * `document` (which headless test environments do not provide).
 */
function focusedJournalKey(list: HTMLElement): string | undefined {
  const active = list.ownerDocument.activeElement as HTMLElement | null;
  if (active === null || active === undefined) {
    return undefined;
  }
  if (list.contains !== undefined && !list.contains(active)) {
    return undefined;
  }
  const name = active.querySelector?.(
    ".paper-notes-library-filter-form-journal-option-name",
  );
  return name?.textContent ? journalKey(name.textContent) : undefined;
}

function appendArtifact(
  parts: readonly ArtifactPart[],
  part: ArtifactPart,
): ArtifactPart[] {
  return parts.includes(part) ? [...parts] : [...parts, part];
}

/**
 * Append one `<option>` to a select. Obsidian's `createEl` does not accept a
 * `disabled` flag for options, so this stays a plain DOM append.
 */
function selectCreateOption(
  select: HTMLSelectElement,
  value: string,
  text: string,
  disabled: boolean,
): HTMLOptionElement {
  const option = select.ownerDocument.createElement("option");
  option.value = value;
  option.textContent = text;
  if (disabled) {
    option.setAttribute("disabled", "");
  }
  select.appendChild(option);
  return option;
}

/** A rank select plus its unsupported-current-value placeholder and error. */
interface RankControl {
  readonly key: "cas" | "jcr";
  readonly select: HTMLSelectElement;
  readonly error: HTMLElement;
  readonly errorId: string;
  /** Nonselectable placeholder for an unsupported current value, or null. */
  placeholder: HTMLOptionElement | null;
}
