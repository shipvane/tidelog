'use strict';

/**
 * Colour rules for public/styles.css (SVD-22), computed from the real file.
 *
 * jsdom has no layout and no cascade worth trusting, so this does not render
 * anything: it parses the stylesheet, resolves each rule's `color` and
 * `background` through the `:root` tokens, and computes the WCAG 2 contrast
 * ratio. Every rule that sets BOTH a text colour and a solid background must
 * reach 4.5:1 (AA, normal-size text). A rule that sets only one of them (most
 * hover states) is not checked here; its pair depends on the cascade.
 *
 * It also enforces CLAUDE.md's rule that colours come from the custom
 * properties: no literal hex outside `:root`.
 */

const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf-8');

const rootBlock = CSS.match(/:root\s*\{([^}]*)\}/)[1];
const TOKENS = Object.fromEntries(
  [...rootBlock.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])
);
const RULES_CSS = CSS.slice(CSS.indexOf('}', CSS.indexOf(':root')) + 1);

function resolve(value) {
  const v = value.trim();
  const ref = v.match(/^var\(--([\w-]+)\)$/);
  if (ref) return TOKENS[ref[1]] ? resolve(TOKENS[ref[1]]) : null;
  return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v) ? v : null; // gradients etc: unresolved
}

function luminance(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function rulesWithTextAndBackground() {
  const out = [];
  for (const m of RULES_CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const body = m[2];
    const color = body.match(/(?<![-\w])color:\s*([^;]+);/);
    const bg = body.match(/background(?:-color)?:\s*([^;]+);/);
    if (!color || !bg) continue;
    const fg = resolve(color[1]);
    const back = resolve(bg[1]);
    if (fg && back) out.push({ selector, fg, back, ratio: contrast(fg, back) });
  }
  return out;
}

describe('SVD-22 colour rules in public/styles.css', () => {
  test('no literal hex colours outside :root (CLAUDE.md)', () => {
    const withoutComments = RULES_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments.match(/#[0-9a-f]{3,6}\b/gi) || []).toEqual([]);
  });

  test('every rule with both a text colour and a background reaches 4.5:1', () => {
    const rules = rulesWithTextAndBackground();
    // Guard against the parser quietly finding nothing and passing vacuously.
    expect(rules.length).toBeGreaterThan(10);
    const failing = rules
      .filter((r) => r.ratio < 4.5)
      .map((r) => `${r.selector}: ${r.fg} on ${r.back} = ${r.ratio.toFixed(2)}:1`);
    expect(failing).toEqual([]);
  });

  test.each([
    // The pairs SVD-22 was about, pinned so a token edit cannot regress them.
    ['brass-text', 'brass-soft'],
    ['brass-text', 'card'],
    ['teal-text', 'teal-soft'],
    ['teal-text', 'card'],
    ['red', 'red-soft'],
    ['muted', 'paper'],
    ['card', 'teal'], // the #fff hovers, now a token
    ['card', 'teal-dark'],
  ])('--%s on --%s reaches 4.5:1', (fg, bg) => {
    expect(contrast(resolve(`var(--${fg})`), resolve(`var(--${bg})`))).toBeGreaterThanOrEqual(4.5);
  });
});
