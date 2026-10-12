import { useId, useRef, type InputHTMLAttributes } from "react";
import { Icon } from "./Icon";

type Props = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "onChange"
> & {
  label: string;
  value: string | number;
  onValueChange: (value: string) => void;
};

export function NumberField({
  label,
  value,
  onValueChange,
  id,
  ...props
}: Props) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const input = useRef<HTMLInputElement>(null);
  const locked = props.disabled || props.readOnly || props.step === "any";
  const hasValue = value !== "" && Number.isFinite(Number(value));
  const atMin =
    hasValue && props.min !== undefined && Number(value) <= Number(props.min);
  const atMax =
    hasValue && props.max !== undefined && Number(value) >= Number(props.max);

  function adjust(direction: number) {
    if (!input.current || locked) return;
    // Native stepping preserves decimal precision, step alignment, and bounds.
    input.current.stepUp(direction);
    onValueChange(input.current.value);
  }

  return (
    <div className="number-field">
      <label htmlFor={inputId}>{label}</label>
      <div
        className={"number-control" + (props.disabled ? " is-disabled" : "")}
      >
        <input
          {...props}
          id={inputId}
          ref={input}
          type="number"
          value={value}
          onChange={(event) => onValueChange(event.currentTarget.value)}
        />
        <span className="number-steps">
          <button
            type="button"
            aria-label={"Decrease " + label.toLowerCase()}
            aria-controls={inputId}
            disabled={locked || atMin}
            onClick={() => adjust(-1)}
          >
            <Icon name="minus" />
          </button>
          <button
            type="button"
            aria-label={"Increase " + label.toLowerCase()}
            aria-controls={inputId}
            disabled={locked || atMax}
            onClick={() => adjust(1)}
          >
            <Icon name="plus" />
          </button>
        </span>
      </div>
    </div>
  );
}
