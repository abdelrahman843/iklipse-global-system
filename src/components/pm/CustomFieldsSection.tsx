import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sliders } from "lucide-react";
import { useMemo } from "react";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import {
  listCardValues,
  listFields,
  setCardValue,
  type CustomFieldDef,
} from "@/lib/pm/customFieldsApi";
import { useBoardCan } from "@/lib/pm/boardAccess";

export function CustomFieldsSection({ boardId, cardId }: { boardId: string; cardId: string }) {
  const qc = useQueryClient();
  const can = useBoardCan();

  const defs = useQuery({
    queryKey: ["custom_field_def", boardId],
    queryFn: () => listFields(boardId),
  });
  const vals = useQuery({
    queryKey: ["custom_field_value", cardId],
    queryFn: () => listCardValues(cardId),
  });

  const valuesById = useMemo(() => {
    const m = new Map<string, unknown>();
    for (const v of vals.data ?? []) m.set(v.field_id, v.value);
    return m;
  }, [vals.data]);

  const save = useMutation({
    mutationFn: (v: { fieldId: string; value: unknown }) => setCardValue(cardId, v.fieldId, v.value),
    // Optimistic: pickers and checkboxes show the new value straight away.
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["custom_field_value", cardId] });
      qc.setQueryData<{ field_id: string; value: unknown }[]>(["custom_field_value", cardId], (rows) => {
        const list = rows ?? [];
        return list.some((r) => r.field_id === v.fieldId)
          ? list.map((r) => (r.field_id === v.fieldId ? { ...r, value: v.value } : r))
          : [...list, { field_id: v.fieldId, value: v.value }];
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["custom_field_value", cardId] }),
  });

  if (defs.isLoading) return <Spinner size={14} />;
  const fields = defs.data ?? [];
  if (fields.length === 0) return null;

  return (
    <section>
      <h3 className="flex items-center gap-2 text-base font-semibold text-ink">
        <Sliders size={14} /> Custom fields
      </h3>
      {/* grid-cols-1 = minmax(0, 1fr): a wide native date field can't push
          the column past the pane on a phone. */}
      <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
        {fields.map((f) => (
          <FieldRow
            key={f.id}
            field={f}
            value={valuesById.get(f.id) ?? null}
            disabled={!can("pm.edit_card")}
            onChange={(v) => save.mutate({ fieldId: f.id, value: v })}
          />
        ))}
      </div>
    </section>
  );
}

function FieldRow({
  field,
  value,
  onChange,
  disabled,
}: {
  field: CustomFieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
}) {
  const label = (
    <div className="text-[11px] font-semibold uppercase tracking-eyebrow text-subtle mb-1 line-clamp-2 break-words" title={field.name}>
      {field.name}
    </div>
  );

  switch (field.type) {
    case "text":
      return (
        <div>
          {label}
          <Input
            disabled={disabled}
            aria-label={field.name}
            defaultValue={typeof value === "string" ? value : ""}
            onBlur={(e) => onChange(e.target.value)}
          />
        </div>
      );
    case "number":
      return (
        <div>
          {label}
          <Input
            disabled={disabled}
            aria-label={field.name}
            type="number"
            defaultValue={typeof value === "number" ? value : ""}
            onBlur={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          />
        </div>
      );
    case "date":
      return (
        <div>
          {label}
          <Input
            disabled={disabled}
            aria-label={field.name}
            type="date"
            defaultValue={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value || null)}
          />
        </div>
      );
    case "checkbox":
      return (
        <div>
          {label}
          <label className="inline-flex items-center gap-2 min-h-10 sm:min-h-0">
            <input
              type="checkbox"
              className="accent-accent"
              disabled={disabled}
              checked={value === true}
              onChange={(e) => onChange(e.target.checked)}
            />
            <span className="text-sm text-ink">{value === true ? "Yes" : "No"}</span>
          </label>
        </div>
      );
    case "select":
      return (
        <div>
          {label}
          <Select
            className="w-full"
            aria-label={field.name}
            disabled={disabled}
            value={typeof value === "string" ? value : ""}
            onChange={(v) => onChange(v || null)}
            options={[{ value: "", label: "None" }, ...(field.options ?? []).map((o) => ({ value: o.id, label: o.label }))]}
          />
        </div>
      );
    default:
      return null;
  }
}
