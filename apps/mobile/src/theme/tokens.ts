/**
 * Nocturne design tokens: the single source of truth for colour, spacing, radius, and type.
 *
 * A dark warm precision instrument. Depth comes from stepped surfaces plus 1px hairlines, not
 * shadows or glow. One amber accent means "live/working"; coral is reserved for "needs you"; green
 * and red are reserved for allow/deny and ok/error. Never a font weight below 400 (thin weights
 * blur on OLED). Components consume these tokens by name and never inline a hex value.
 */
import { Platform, type TextStyle } from 'react-native';
import type { SessionState } from '@claude-code-remote/protocol';

export const colors = {
  bg: '#100D0B',
  surface1: '#1A1613',
  surface2: '#221C17',
  line: '#31291F',
  hi: '#F4EEE6',
  lo: '#A79C8D',
  mut: '#6E655A',
  accent: '#F6A93B',
  onAccent: '#20140A',
  urgent: '#FF7A4D',
  onUrgent: '#2A1206',
  ok: '#35C08A',
  onOk: '#06231A',
  warn: '#FFC53D',
  err: '#F26D6D',
} as const;

export type ColorName = keyof typeof colors;

/** Spacing scale, 4 through 32. Use by name so rhythm stays consistent. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const radius = {
  card: 16,
  sheet: 22,
  screen: 28,
  pill: 999,
} as const;

/** Minimum comfortable touch target (iOS HIG 44, Material 48). */
export const touchTarget = 44;

/** The platform monospace face, for cwd, commands, and data. */
export const monoFamily = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export const typography = {
  /** Screen and card titles. System font, heavy, tight tracking. */
  display: { fontSize: 26, fontWeight: '800', letterSpacing: -0.5, color: colors.hi },
  /** Section and row titles. */
  title: { fontSize: 18, fontWeight: '700', letterSpacing: -0.2, color: colors.hi },
  /** Default reading text. */
  body: { fontSize: 15, fontWeight: '400', color: colors.hi },
  /** Emphasised reading text. */
  bodyStrong: { fontSize: 15, fontWeight: '600', color: colors.hi },
  /** Secondary reading text. */
  bodyMuted: { fontSize: 14, fontWeight: '400', color: colors.lo },
  /** Commands, cwd, and other machine data. */
  mono: { fontFamily: monoFamily, fontSize: 13, fontWeight: '400', color: colors.lo },
  /** Uppercase micro labels above a value. */
  micro: { fontSize: 10, fontWeight: '600', letterSpacing: 1.2, textTransform: 'uppercase', color: colors.lo },
} as const satisfies Record<string, TextStyle>;

/**
 * A hex colour (#RRGGBB) at a given opacity, as an rgba() string. Used for state tints, which are a
 * ~15% wash of a state's own colour rather than a raw saturated block.
 */
export function alpha(hex: string, a: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  const clamped = Math.max(0, Math.min(1, a));
  return `rgba(${r}, ${g}, ${b}, ${clamped})`;
}

export interface StatePresentation {
  /** The colour that carries the state (text and LED). */
  color: string;
  /** The short human label. */
  label: string;
  /** Whether the LED should pulse (a live, in-progress state). */
  pulse: boolean;
}

/** Map a session state to its colour, label, and whether its LED pulses. */
export function stateColor(state: SessionState): StatePresentation {
  switch (state) {
    case 'starting':
      return { color: colors.accent, label: 'Starting', pulse: false };
    case 'ready':
      return { color: colors.ok, label: 'Ready', pulse: false };
    case 'working':
      return { color: colors.accent, label: 'Working', pulse: true };
    case 'waiting_approval':
      return { color: colors.urgent, label: 'Approval', pulse: true };
    case 'waiting_input':
      return { color: colors.warn, label: 'Waiting', pulse: false };
    case 'idle':
      return { color: colors.mut, label: 'Idle', pulse: false };
    case 'finished':
      return { color: colors.mut, label: 'Done', pulse: false };
    case 'errored':
      return { color: colors.err, label: 'Errored', pulse: false };
  }
}
