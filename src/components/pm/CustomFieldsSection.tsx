import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sliders } from "lucide-react";
import { useMemo } from "react";
import { Input, inputClass } from "@/components/ui/Input";
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ["custom_field_value", cardId] }),
  });

  if (defs.isLoading) return <Spinner size={14} />;
  const fields = defs.data ?? [];
  if (fields.length === 0) return null;

  return (
    <section>
      <h3 className="flex items-center gap-2 text-base font-semibold text-ink">
        <Sliders size={14} /> Custom fields
      </h3>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
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
    <div className="text-[11px] font-semibold uppercase tracking-eyebrow text-subtle mb-1">{field.name}</div>
  );

  switch (field.type) {
    case "text":
      return (
        <div>
          {label}
          <Input
            disabled={disabled}
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
          <label className="inline-flex items-center gap-2">
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
          <select
            disabled={disabled}
            className={`${inputClass} h-9`}
            defaultValue={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value || null)}
          >
            <option value="">None</option>
            {(field.options ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      );
    default:
      return null;
  }
}
