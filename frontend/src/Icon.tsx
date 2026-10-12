import type { ReactNode } from "react";

const paths = {
  library: (
    <>
      <path d="M12 6v15M3 4.5c3-1 6-.5 9 1.5 3-2 6-2.5 9-1.5v15c-3-1-6-.5-9 1.5-3-2-6-2.5-9-1.5Z" />
    </>
  ),
  audio: (
    <>
      <path d="M4 10v4M8 6v12M12 3v18M16 8v8M20 5v14" />
    </>
  ),
  editor: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
      <path d="M14 3v6h6M8 13h8M8 17h6" />
    </>
  ),
  queue: (
    <>
      <path d="M4 5h16M4 10h12M4 15h7M16 14l4 4-4 4M12 18h8" />
    </>
  ),
  backups: (
    <>
      <path d="M3 11a9 9 0 1 1 2.6 7.4M3 4v7h7M12 7v5l3 2" />
    </>
  ),
  settings: (
    <>
      <path d="M3 6h8m4 0h6M3 12h2m4 0h12M3 18h10m4 0h4" />
      <circle cx="13" cy="6" r="2" />
      <circle cx="7" cy="12" r="2" />
      <circle cx="15" cy="18" r="2" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" />
    </>
  ),
  moon: (
    <>
      <path d="M20.5 13.2A9 9 0 0 1 10.8 3.5a9 9 0 1 0 9.7 9.7Z" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  plus: <path d="M5 12h14M12 5v14" />,
  play: <path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect
        x="6"
        y="5"
        width="4"
        height="14"
        rx="1"
        fill="currentColor"
        stroke="none"
      />
      <rect
        x="14"
        y="5"
        width="4"
        height="14"
        rx="1"
        fill="currentColor"
        stroke="none"
      />
    </>
  ),
  loader: <path d="M21 12a9 9 0 1 1-9-9" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className={"icon" + (name === "loader" ? " icon-spinner" : "")}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
