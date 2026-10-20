import { Children, isValidElement, type ReactNode } from "react";
import * as Primitive from "@radix-ui/react-select";
import { Icon } from "./Icon";

type Option = {
  value?: string | number;
  disabled?: boolean;
  children?: ReactNode;
};
// Encoding every value also avoids reserving a value that could be a real tag.
const encode = (value: string | number) => "option:" + String(value);

function text(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      isValidElement<Option>(child)
        ? text(child.props.children)
        : String(child),
    )
    .join("");
}

/** Option children keep callers' labels and values together, without native menus. */
export function Select({
  value,
  onValueChange,
  children,
  disabled,
  id,
  className = "",
  "aria-label": label,
}: {
  value: string | number;
  onValueChange: (value: string) => void;
  children: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
}) {
  const options = Children.toArray(children).filter(isValidElement<Option>);
  return (
    <Primitive.Root
      value={encode(value)}
      onValueChange={(next) => onValueChange(next.slice("option:".length))}
      disabled={disabled}
    >
      <Primitive.Trigger
        id={id}
        aria-label={label}
        className={"select-trigger " + className}
        type="button"
      >
        <Primitive.Value />
        <Primitive.Icon>
          <Icon name="chevronDown" />
        </Primitive.Icon>
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          className="select-popup"
          data-lectra-popup=""
          position="popper"
          sideOffset={6}
          collisionPadding={12}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Primitive.ScrollUpButton className="select-scroll">
            <Icon name="chevronUp" />
          </Primitive.ScrollUpButton>
          <Primitive.Viewport className="select-options">
            {options.map(({ props }) => {
              const name = text(props.children);
              const optionValue = encode(props.value ?? name);
              return (
                <Primitive.Item
                  key={optionValue}
                  value={optionValue}
                  disabled={props.disabled}
                  textValue={name}
                  className="select-option"
                >
                  <Primitive.ItemText>
                    <bdi>{props.children}</bdi>
                  </Primitive.ItemText>
                  <Primitive.ItemIndicator className="select-check">
                    <Icon name="check" />
                  </Primitive.ItemIndicator>
                </Primitive.Item>
              );
            })}
          </Primitive.Viewport>
          <Primitive.ScrollDownButton className="select-scroll">
            <Icon name="chevronDown" />
          </Primitive.ScrollDownButton>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
