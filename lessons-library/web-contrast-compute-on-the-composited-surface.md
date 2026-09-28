# Web: compute contrast with the luminance formula, on the surface the text really sits on

**Stack:** web (CSS design tokens, WCAG). Skip for non-web projects.

**Trigger:** You darken or lighten a color token to meet WCAG AA (4.5:1), write a "~N:1" ratio in a comment, or choose text color for a chip, badge, or pill with an alpha-tinted "soft" background.

**Failure mode:**
- Estimating the ratio from HSL lightness is wrong. WCAG uses relative luminance (gamma-corrected, channel-weighted); a color documented as "~5.7:1" measured 4.1:1 and still failed.
- A soft tint is an alpha color. Verified once over pure white, it holds only on white cards. The same chip on a darker page strip or nested surface composites to a darker background and can drop below 4.5:1 (here, 4.99 on white became 4.48 on the real strip). A per-page audit misses surfaces outside its page set.

**Correct behavior:**
- Compute the ratio before writing it or shipping the token:
  ```js
  const lin = c => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  ```
- Composite the tint over every surface the chip appears on (card, page, nested strip): `C = alpha * T + (1 - alpha) * S` per channel. Feed that `C` to the formula and keep the worst ratio.
- Treat a whole-document accessibility scan on the rendered app as the backstop for surfaces a page sweep skips. Fix the token; do not weaken the scan.

**Check:** For each surface this component renders on, is there a computed ratio against the composited background?

**Seen in:** recurring in design-token refreshes and dark-mode or tinted-surface work.
