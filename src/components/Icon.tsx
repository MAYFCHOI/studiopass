const paths: Record<string, string> = {
  today: 'M4 5h16v15H4zM4 10h16M8 3v4M16 3v4',
  scan: 'M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4M7 12h10',
  members: 'M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21c0-4 3.5-6 8-6s8 2 8 6',
  pay: 'M3 7h18v11H3zM3 11h18M7 15h3',
  settle: 'M5 20V10M12 20V4M19 20v-7',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.2-1.6l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2.8-1.6L13.3 2h-2.6l-.4 2.9a7 7 0 0 0-2.8 1.6l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .5.1 1.1.2 1.6l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2.8 1.6l.4 2.9h2.6l.4-2.9a7 7 0 0 0 2.8-1.6l2.3 1 2-3.4-2-1.5c.1-.5.2-1.1.2-1.6z',
  back: 'M15 5l-7 7 7 7',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12l5 5L20 7',
  x: 'M6 6l12 12M18 6L6 18',
  upload: 'M12 16V4M6 10l6-6 6 6M4 20h16',
  download: 'M12 4v12M6 10l6 6 6-6M4 20h16',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z',
};
export function Icon({ name, size = 22 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}
