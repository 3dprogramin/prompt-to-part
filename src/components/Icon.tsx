const PATHS: Record<string, string> = {
  send: 'M4 12 20 4l-6 16-3-7-7-1z',
  image: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15 9.5a1.5 1.5 0 1 0 0-.01',
  stop: 'M7 7h10v10H7z',
  plus: 'M12 5v14M5 12h14',
  folder: 'M3 7h6l2 2h10v10H3z',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  x: 'M6 6l12 12M18 6 6 18',
  coin: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM14.8 9.2c-.5-.8-1.5-1.3-2.8-1.3-1.7 0-2.8.8-2.8 2 0 2.8 5.6 1.4 5.6 4.2 0 1.2-1.1 2-2.8 2-1.3 0-2.4-.5-2.9-1.4M12 6.3v1.6M12 16.1v1.6',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  pin: 'M9 4h6M10 4v6l-3 4h10l-3-4V4M12 14v6',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  home: 'M3 11 12 4l9 7M5 9.5V20h5v-6h4v6h5V9.5',
  fit: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5M8 11h6M11 8v6',
  fullscreen: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  fullscreenExit: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  printer: 'M7 9V4h10v5M6 18H4v-7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7h-2M7 14h10v6H7z',
  palette: 'M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.3-1.7-.4-1 .3-2.1 1.4-2.1H17a4 4 0 0 0 4-4c0-5.6-4-10.2-9-10.2zM7.5 12.5h.01M9 8h.01M13.5 7h.01M17 10.5h.01',
  assemble: 'M4 14h7v6H4zM13 4h7v6h-7zM16.5 10v4h-5M8 14v-3h3',
  play: 'M8 5v14l11-7z',
  pause: 'M8 5h3v14H8zM13 5h3v14h-3z',
  prev: 'M6 5v14M18 5 9 12l9 7z',
  next: 'M18 5v14M6 5l9 7-9 7z',
  ruler: 'M3 17 17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2',
  cube: 'M12 3 20 7.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12 4 7.5',
  dims: 'M4 20V8M20 20V8M4 14h16M7 11l-3 3 3 3M17 11l3 3-3 3',
  tag: 'M3 12V4h8l10 10-8 8zM7.5 7.5h.01',
  edges: 'M4 8 12 4l8 4v8l-8 4-8-4z',
  section: 'M4 4h16v16H4zM4 14l16-6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.9 8.3 2 12 2 12s4 7 10 7c1.8 0 3.4-.6 4.8-1.4',
  download: 'M12 4v11M7 10l5 5 5-5M4 20h16',
  restore: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v5h5',
  ortho: 'M5 5h14v14H5zM5 5l14 14',
  chevron: 'M9 6l6 6-6 6',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
  check: 'M5 12l5 5 9-10',
  alert: 'M12 4 2 20h20zM12 10v4M12 17h.01',
  code: 'M9 7l-5 5 5 5M15 7l5 5-5 5',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01',
};

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}
