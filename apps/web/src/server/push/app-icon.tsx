/**
 * Nuera Dev application icon, drawn for `next/og` ImageResponse (app/icon.tsx, app/apple-icon.tsx).
 *
 * Design source (Figma S5 « Icône de l'application » + design-system §9.3): a `--near-black`
 * square, radius 12 at 40 px (30 %), holding the `DEV` pill of the Nuera Dev logo — pill
 * `--accent-on-dark`, radius 8, `DEV` in JetBrains Mono Bold, `--near-black`. The glyphs are the
 * outlined paths exported from the Figma logo (`Logo Nuera Dev · papier`, node 201:41), so no
 * font file is needed. Colours mirror src/styles/tokens.css (`--near-black`, `--accent-on-dark`).
 */

export const ICON_COLORS = {
  nearBlack: '#141830', // --near-black
  accentOnDark: '#a6b9dd', // --accent-on-dark
  paper: '#ffffff', // --paper
} as const;

/** Pill outline in the logo coordinate space (x 144 → 176, y 3.8057 → 23.8057: 32 × 20, radius 8). */
const PILL_PATH =
  'M144 11.8057C144 7.38739 147.582 3.80566 152 3.80566H168C172.418 3.80566 176 7.38739 176 11.8057V15.8057C176 20.2239 172.418 23.8057 168 23.8057H152C147.582 23.8057 144 20.2239 144 15.8057V11.8057Z';

/** `DEV` glyphs (JetBrains Mono Bold, outlined by Figma), same coordinate space. */
const DEV_PATH =
  'M148.9 17.8057V9.04566H151.504C152.096 9.04566 152.608 9.15766 153.04 9.38166C153.48 9.60566 153.82 9.92166 154.06 10.3297C154.3 10.7377 154.42 11.2217 154.42 11.7817V15.0577C154.42 15.6097 154.3 16.0937 154.06 16.5097C153.82 16.9177 153.48 17.2377 153.04 17.4697C152.608 17.6937 152.096 17.8057 151.504 17.8057H148.9ZM150.4 16.4257H151.504C151.936 16.4257 152.28 16.3057 152.536 16.0657C152.792 15.8177 152.92 15.4817 152.92 15.0577V11.7817C152.92 11.3657 152.792 11.0377 152.536 10.7977C152.28 10.5497 151.936 10.4257 151.504 10.4257H150.4V16.4257ZM157.211 17.8057V9.04566H162.467V10.3537H158.687V12.6337H162.047V13.9297H158.687V16.4977H162.467V17.8057H157.211ZM166.939 17.8057L164.731 9.04566H166.291L167.611 14.7577C167.683 15.0377 167.751 15.3377 167.815 15.6577C167.879 15.9777 167.927 16.2377 167.959 16.4377C167.991 16.2377 168.035 15.9777 168.091 15.6577C168.147 15.3377 168.207 15.0337 168.271 14.7457L169.579 9.04566H171.091L168.883 17.8057H166.939Z';

export interface AppIconOptions {
  /** Square size in px. */
  size: number;
  /**
   * `rounded`: transparent corners, 30 % radius (favicon, `purpose: any`);
   * `full`: full-bleed square (apple-touch-icon, maskable — the platform applies its own mask).
   */
  shape: 'rounded' | 'full';
  /** Pill width as a share of the icon (S5: 32 / 40 = 0.8; maskable safe zone: ≤ 0.6). */
  pillRatio?: number;
}

export function AppIcon({ size, shape, pillRatio = 0.8 }: AppIconOptions) {
  const pillWidth = Math.round(size * pillRatio);
  const pillHeight = Math.round((pillWidth * 20) / 32);
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: ICON_COLORS.nearBlack,
        borderRadius: shape === 'rounded' ? Math.round(size * 0.3) : 0,
      }}
    >
      <svg width={pillWidth} height={pillHeight} viewBox="144 3.80566 32 20" xmlns="http://www.w3.org/2000/svg">
        <path d={PILL_PATH} fill={ICON_COLORS.accentOnDark} />
        <path d={DEV_PATH} fill={ICON_COLORS.nearBlack} />
      </svg>
    </div>
  );
}
