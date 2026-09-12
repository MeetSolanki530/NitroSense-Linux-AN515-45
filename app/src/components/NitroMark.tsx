/**
 * The centrepiece "N".
 *
 * The original is a rendered 3D asset that recolours per mode. Reproducing
 * that faithfully in Electron is not practical, so this is layered SVG with
 * gradients and a bevel highlight, inheriting the mode accent — close in
 * spirit, and it recolours for free.
 */
import type { JSX } from 'react';

export function NitroMark({ size = 260 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size * 1.32} viewBox="0 0 100 132" className="nitro-mark"
         role="img" aria-label="NitroSense">
      <defs>
        <linearGradient id="n-face" x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0%" stopColor="var(--accent-bright)" />
          <stop offset="45%" stopColor="var(--accent)" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.55" />
        </linearGradient>
        <linearGradient id="n-bevel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="55%" stopColor="#fff" stopOpacity="0.05" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <filter id="n-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="5" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Angular N, echoing the sheared strokes of the original mark. */}
      {/* Sheared to match the original mark's forward lean. */}
      <g filter="url(#n-glow)" transform="translate(12 0) skewX(-9)">
        <path d="M10 126 L10 6 L34 6 L34 72 L62 6 L86 6 L86 126 L62 126 L62 60 L34 126 Z"
              fill="url(#n-face)" />
        <path d="M10 126 L10 6 L34 6 L34 72 Z" fill="url(#n-bevel)" />
      </g>
    </svg>
  );
}
