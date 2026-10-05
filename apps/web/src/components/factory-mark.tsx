/**
 * The mark, in one place.
 *
 * A blocky `f` on a 32-unit grid, drawn as a path rather than as a glyph so it
 * does not depend on a font being loaded. It inherits `currentColor`, so the
 * rail's inverted square and any future stamp are the same file.
 *
 * `public/favicon.svg` carries an identical path, because a favicon cannot use
 * `currentColor`. Change one, change the other.
 */
export const FactoryMark = ({ className }: { readonly className?: string }) => (
  <svg viewBox="0 0 32 32" aria-hidden className={className}>
    <path d="M10 8h13v4h-8.5v3.5H22v4h-7.5V24H10z" fill="currentColor" />
  </svg>
);
