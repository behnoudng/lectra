import { useRef, useState, type ReactNode } from "react";
import * as Context from "@radix-ui/react-context-menu";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Icon } from "./Icon";
import type { Lecture } from "./types";

export function LectureActions({
  lecture,
  busy,
  onToggle,
  className,
  children,
}: {
  lecture: Lecture;
  busy: boolean;
  onToggle: (lecture: Lecture) => void;
  className: string;
  children: ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const label = lecture.is_used ? "Mark as unused" : "Mark as used";
  const content = (
    <>
      <Icon name={lecture.is_used ? "undo" : "check"} />
      {label}
    </>
  );
  return (
    <Context.Root modal={false}>
      <Context.Trigger asChild>
        <div
          className={className}
          onKeyDown={(event) => {
            if (
              event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10")
            ) {
              event.preventDefault();
              if (!busy) {
                trigger.current?.focus();
                setOpen(true);
              }
            }
          }}
        >
          {children}
          <Menu.Root modal={false} open={open} onOpenChange={setOpen}>
            <Menu.Trigger asChild>
              <button
                ref={trigger}
                type="button"
                className="lecture-more"
                disabled={busy}
                aria-label={
                  busy
                    ? `Saving usage for ${lecture.title}`
                    : `More actions for ${lecture.title}`
                }
              >
                <Icon name={busy ? "loader" : "more"} />
              </button>
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content
                className="action-menu"
                data-lectra-popup=""
                sideOffset={6}
                align="end"
                collisionPadding={12}
              >
                <Menu.Item
                  className="action-menu-item"
                  disabled={busy}
                  onSelect={() => onToggle(lecture)}
                >
                  {content}
                </Menu.Item>
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
        </div>
      </Context.Trigger>
      <Context.Portal>
        <Context.Content
          className="action-menu"
          data-lectra-popup=""
          collisionPadding={12}
        >
          <Context.Item
            className="action-menu-item"
            disabled={busy}
            onSelect={() => onToggle(lecture)}
          >
            {content}
          </Context.Item>
        </Context.Content>
      </Context.Portal>
    </Context.Root>
  );
}
