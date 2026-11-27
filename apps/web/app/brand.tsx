/**
 * The Daidai wordmark, constructed from circles and strokes of one weight: every letter in "daidai" is a bowl, a stem, or
 * both, so the mark is drawn rather than typeset. The two i-dots are the only colour. Presentation only; no client code.
 */
const R = 33, BOTTOM = 40, ASCENDER = -86, XHEIGHT = -40;
const GLYPHS: readonly (readonly ['d' | 'a' | 'i', number])[] = [['d', 40], ['a', 135], ['i', 206], ['d', 268], ['a', 363], ['i', 434]];

export function BrandWordmark({ onInk = false, className = '' }: { onInk?: boolean; className?: string }) {
  const letter = { stroke: onInk ? 'var(--color-paper)' : 'var(--color-ink)', strokeWidth: 14, fill: 'none' } as const;
  const dot = { fill: onInk ? 'var(--color-brass)' : 'var(--color-brass-deep)' } as const;
  return <svg className={'brand-wordmark' + (className ? ' ' + className : '')} viewBox="0 -88 441 130" role="img" aria-label="Daidai" focusable="false">
    {GLYPHS.map(([ch, x], n) => ch === 'i'
      ? <g key={n}><path d={`M${x} ${XHEIGHT}V${BOTTOM}`} style={letter} /><circle cx={x} cy={-62} r={9} style={dot} /></g>
      : <g key={n}><circle cx={x} cy={0} r={R} style={letter} /><path d={`M${x + R} ${ch === 'd' ? ASCENDER : XHEIGHT}V${BOTTOM}`} style={letter} /></g>)}
  </svg>;
}
