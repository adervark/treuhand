"use client";

/**
 * Editable list of a contract's conditions. Each condition is a sentence the
 * people agree on plus the exact test the verifier will run. Used by the
 * composer and by a DRAFT contract's page.
 */
import { useId } from "react";
import {
  CHECK_KINDS_BY_CONTRACT_TYPE,
  ConditionInputSchema,
  type CheckKind,
  type ConditionInput,
  type ContractType,
} from "@/lib/types";
import { checkSignature, defaultParams, describeCheck } from "./checks";
import { CHECK_KIND_META, CONTRACT_TYPE_META } from "./format";
import { IconCode, IconGlobe, IconPlus, IconSpark, IconTrash } from "./icons";
import { Button, cx, inputClass, monoInputClass } from "./ui";

export interface EditableCondition {
  key: string;
  text: string;
  check_kind: CheckKind;
  check_params: Record<string, unknown>;
}

let keySeq = 0;
export function newKey(): string {
  keySeq += 1;
  return `c${Date.now().toString(36)}${keySeq}`;
}

export function toEditable(conditions: { text: string; check_kind: CheckKind; check_params: unknown }[]): EditableCondition[] {
  return conditions.map((c) => ({
    key: newKey(),
    text: c.text,
    check_kind: c.check_kind,
    check_params: { ...((c.check_params ?? {}) as Record<string, unknown>) },
  }));
}

/** Drops empty optional strings so zod sees "absent", not "". */
function cleanParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === "" || v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

export type ConditionErrors = Record<string, string>;

/** Validates every condition for the contract type; returns the API payload or per-condition errors. */
export function validateConditions(
  type: ContractType,
  conditions: EditableCondition[],
): { ok: true; value: ConditionInput[] } | { ok: false; errors: ConditionErrors[]; message: string } {
  const errors: ConditionErrors[] = conditions.map(() => ({}));
  const value: ConditionInput[] = [];
  conditions.forEach((c, i) => {
    if (!CHECK_KINDS_BY_CONTRACT_TYPE[type].includes(c.check_kind)) {
      errors[i].check_kind = `Not available for a ${CONTRACT_TYPE_META[type].label.toLowerCase()}. Pick another check.`;
      return;
    }
    const parsed = ConditionInputSchema.safeParse({
      text: c.text.trim(),
      check_kind: c.check_kind,
      check_params: cleanParams(c.check_params),
    });
    if (parsed.success) {
      value.push(parsed.data);
      return;
    }
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] === "check_params" ? String(issue.path[1] ?? "check_params") : String(issue.path[0] ?? "text");
      if (!errors[i][field]) errors[i][field] = field === "text" ? "Write the condition in plain English." : issue.message;
    }
  });
  const bad = errors.filter((e) => Object.keys(e).length > 0).length;
  if (conditions.length === 0) return { ok: false, errors, message: "Add at least one condition." };
  if (bad > 0) return { ok: false, errors, message: `${bad} condition${bad === 1 ? " needs" : "s need"} attention.` };
  return { ok: true, value };
}

const BY_ICON = { code: IconCode, browser: IconGlobe, ai: IconSpark } as const;

export function CheckByBadge({ kind }: { kind: CheckKind }) {
  const meta = CHECK_KIND_META[kind];
  const Icon = BY_ICON[meta.by];
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 text-[0.7rem] font-medium whitespace-nowrap ring-1 ring-inset",
        meta.by === "ai" ? "bg-machine-soft text-machine ring-machine/30" : "bg-inset text-ink-2 ring-rule",
      )}
    >
      <Icon size={12} />
      {meta.by === "ai" ? "Judged by AI" : `Checked by code · ${meta.byLabel}`}
    </span>
  );
}

export function ConditionsEditor({
  type,
  conditions,
  onChange,
  errors = [],
  disabled = false,
}: {
  type: ContractType;
  conditions: EditableCondition[];
  onChange: (next: EditableCondition[]) => void;
  errors?: ConditionErrors[];
  disabled?: boolean;
}) {
  const update = (i: number, patch: Partial<EditableCondition>) =>
    onChange(conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const remove = (i: number) => onChange(conditions.filter((_, j) => j !== i));
  const add = () => {
    const kind = CHECK_KINDS_BY_CONTRACT_TYPE[type][0];
    onChange([...conditions, { key: newKey(), text: "", check_kind: kind, check_params: defaultParams(kind) }]);
  };

  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-3">
        {conditions.map((c, i) => (
          <ConditionRow
            key={c.key}
            index={i}
            type={type}
            condition={c}
            errors={errors[i] ?? {}}
            disabled={disabled}
            onChange={(patch) => update(i, patch)}
            onRemove={() => remove(i)}
          />
        ))}
      </ol>
      <div>
        <Button variant="secondary" size="sm" onClick={add} disabled={disabled}>
          <IconPlus size={16} /> Add a condition
        </Button>
      </div>
    </div>
  );
}

function ConditionRow({
  index,
  type,
  condition,
  errors,
  disabled,
  onChange,
  onRemove,
}: {
  index: number;
  type: ContractType;
  condition: EditableCondition;
  errors: ConditionErrors;
  disabled: boolean;
  onChange: (patch: Partial<EditableCondition>) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const kinds = CHECK_KINDS_BY_CONTRACT_TYPE[type];
  const kindAllowed = kinds.includes(condition.check_kind);
  const setParam = (name: string, value: unknown) =>
    onChange({ check_params: { ...condition.check_params, [name]: value } });
  const hasErrors = Object.keys(errors).length > 0;

  return (
    <li
      className={cx(
        "rounded-sm border bg-surface",
        hasErrors ? "border-fail/50" : "border-rule",
      )}
    >
      <div className="flex gap-3 p-3 sm:p-4">
        <span className="mt-2.5 w-6 shrink-0 tnum text-[0.7rem] font-semibold text-ink-3">
          {String(index + 1).padStart(2, "0")}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-text`} className="sr-only">
              Condition {index + 1}, in plain English
            </label>
            <textarea
              id={`${id}-text`}
              value={condition.text}
              onChange={(e) => onChange({ text: e.target.value })}
              rows={1}
              disabled={disabled}
              placeholder="The condition, in plain English"
              aria-invalid={errors.text ? true : undefined}
              className={cx(inputClass, "field-sizing-content min-h-10 resize-none text-[0.95rem] font-medium")}
            />
            {errors.text ? <p className="text-xs font-medium text-fail">{errors.text}</p> : null}
          </div>

          <div className="rounded-xs bg-surface-2 p-3 ring-1 ring-rule ring-inset">
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor={`${id}-kind`} className="label">
                Checked by
              </label>
              <select
                id={`${id}-kind`}
                value={condition.check_kind}
                disabled={disabled}
                aria-invalid={errors.check_kind ? true : undefined}
                onChange={(e) => {
                  const kind = e.target.value as CheckKind;
                  onChange({ check_kind: kind, check_params: defaultParams(kind, condition.check_params) });
                }}
                className={cx(inputClass, "h-8 w-auto py-0 pr-8 text-[0.8rem]")}
              >
                {!kindAllowed ? <option value={condition.check_kind}>{CHECK_KIND_META[condition.check_kind].label}</option> : null}
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {CHECK_KIND_META[k].label}
                  </option>
                ))}
              </select>
              <CheckByBadge kind={condition.check_kind} />
            </div>
            {errors.check_kind ? <p className="mt-1.5 text-xs font-medium text-fail">{errors.check_kind}</p> : null}

            <ParamInputs
              idPrefix={id}
              kind={condition.check_kind}
              params={condition.check_params}
              errors={errors}
              disabled={disabled}
              setParam={setParam}
            />

            <p className="mt-2.5 text-[0.8rem] leading-snug text-ink-2">{describeCheck(condition)}</p>
            <p className="mt-1 truncate tnum text-[0.68rem] text-ink-3" title={checkSignature(condition)}>
              {checkSignature(condition)}
            </p>
          </div>
        </div>
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRemove}
            disabled={disabled}
            aria-label={`Remove condition ${index + 1}`}
            className="!px-2"
          >
            <IconTrash size={16} />
          </Button>
        </div>
      </div>
    </li>
  );
}

function ParamInputs({
  idPrefix,
  kind,
  params,
  errors,
  disabled,
  setParam,
}: {
  idPrefix: string;
  kind: CheckKind;
  params: Record<string, unknown>;
  errors: ConditionErrors;
  disabled: boolean;
  setParam: (name: string, value: unknown) => void;
}) {
  const text = (name: string, label: string, placeholder: string, optional = false) => (
    <ParamField key={name} id={`${idPrefix}-${name}`} label={label} optional={optional} error={errors[name]}>
      <input
        id={`${idPrefix}-${name}`}
        type="text"
        value={typeof params[name] === "string" ? (params[name] as string) : ""}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={errors[name] ? true : undefined}
        onChange={(e) => setParam(name, e.target.value)}
        className={cx(monoInputClass, "h-8 py-1")}
      />
    </ParamField>
  );
  const num = (name: string, label: string, placeholder: string) => (
    <ParamField key={name} id={`${idPrefix}-${name}`} label={label} error={errors[name]}>
      <input
        id={`${idPrefix}-${name}`}
        type="number"
        inputMode="numeric"
        min={1}
        value={typeof params[name] === "number" ? (params[name] as number) : ""}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={errors[name] ? true : undefined}
        onChange={(e) => setParam(name, e.target.value === "" ? undefined : Number(e.target.value))}
        className={cx(monoInputClass, "h-8 py-1")}
      />
    </ParamField>
  );

  const fields: React.ReactNode[] = [];
  switch (kind) {
    case "github_pr_merged":
    case "github_checks_passed":
      fields.push(text("repo", "Repository", "owner/name"));
      break;
    case "github_pr_references_issue":
      fields.push(text("repo", "Repository", "owner/name"), num("issue", "Issue number", "212"));
      break;
    case "http_ok":
      fields.push(text("path", "Page path", "/", true));
      break;
    case "dom_assert":
      fields.push(
        text("selector", "CSS selector", "form#contact"),
        text("text", "Must contain text", "Opening hours", true),
        text("path", "Page path", "/", true),
      );
      break;
    case "responsive":
      fields.push(num("width", "Width (px)", "375"), text("path", "Page path", "/", true));
      break;
    case "form_submits":
      fields.push(
        text("form_selector", "Form selector", "form"),
        text("success_text", "Success text", "Thank you"),
        text("path", "Page path", "/", true),
      );
      break;
    case "ai_page_judgement":
      fields.push(text("path", "Page path", "/", true));
      break;
  }

  return (
    <div className="mt-3 flex flex-col gap-3">
      {kind === "ai_page_judgement" ? (
        <ParamField id={`${idPrefix}-criterion`} label="Question the AI answers" error={errors.criterion}>
          <textarea
            id={`${idPrefix}-criterion`}
            value={typeof params.criterion === "string" ? params.criterion : ""}
            disabled={disabled}
            rows={2}
            placeholder="Does the page clearly show the opening hours?"
            aria-invalid={errors.criterion ? true : undefined}
            onChange={(e) => setParam("criterion", e.target.value)}
            className={cx(inputClass, "field-sizing-content min-h-16 resize-none text-[0.85rem]")}
          />
        </ParamField>
      ) : null}
      {fields.length > 0 ? <div className="grid gap-3 sm:grid-cols-3">{fields}</div> : null}
      {kind === "form_submits" ? (
        <FormFieldsEditor
          idPrefix={idPrefix}
          value={(params.fields as Record<string, string> | undefined) ?? {}}
          disabled={disabled}
          error={errors.fields}
          onChange={(v) => setParam("fields", v)}
        />
      ) : null}
    </div>
  );
}

function ParamField({
  id,
  label,
  optional = false,
  error,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-[0.72rem] font-medium text-ink-2">
        {label}
        {optional ? <span className="font-normal text-ink-3"> · optional</span> : null}
      </label>
      {children}
      {error ? <p className="text-[0.7rem] font-medium text-fail">{error}</p> : null}
    </div>
  );
}

function FormFieldsEditor({
  idPrefix,
  value,
  disabled,
  error,
  onChange,
}: {
  idPrefix: string;
  value: Record<string, string>;
  disabled: boolean;
  error?: string;
  onChange: (v: Record<string, string>) => void;
}) {
  const rows = Object.entries(value);
  const setRow = (i: number, key: string, val: string) => {
    const next = rows.map((r, j) => (j === i ? [key, val] : r));
    onChange(Object.fromEntries(next));
  };
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-[0.72rem] font-medium text-ink-2">Fields to fill (selector → value)</legend>
      {rows.length === 0 ? <p className="text-[0.75rem] text-ink-3">No fields: the form is submitted as it is.</p> : null}
      {rows.map(([sel, val], i) => (
        <div key={i} className="flex items-center gap-2">
          <label className="sr-only" htmlFor={`${idPrefix}-f${i}-sel`}>
            Field {i + 1} selector
          </label>
          <input
            id={`${idPrefix}-f${i}-sel`}
            value={sel}
            disabled={disabled}
            placeholder="input[name=email]"
            onChange={(e) => setRow(i, e.target.value, val)}
            className={cx(monoInputClass, "h-8 py-1")}
          />
          <span className="text-ink-3" aria-hidden>
            →
          </span>
          <label className="sr-only" htmlFor={`${idPrefix}-f${i}-val`}>
            Field {i + 1} value
          </label>
          <input
            id={`${idPrefix}-f${i}-val`}
            value={val}
            disabled={disabled}
            placeholder="test@example.com"
            onChange={(e) => setRow(i, sel, e.target.value)}
            className={cx(monoInputClass, "h-8 py-1")}
          />
          <Button
            variant="ghost"
            size="sm"
            className="!px-2"
            disabled={disabled}
            aria-label={`Remove field ${i + 1}`}
            onClick={() => onChange(Object.fromEntries(rows.filter((_, j) => j !== i)))}
          >
            <IconTrash size={15} />
          </Button>
        </div>
      ))}
      <div>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || "" in value}
          onClick={() => onChange({ ...value, "": "" })}
        >
          <IconPlus size={15} /> Add field
        </Button>
      </div>
      {error ? <p className="text-[0.7rem] font-medium text-fail">{error}</p> : null}
    </fieldset>
  );
}
