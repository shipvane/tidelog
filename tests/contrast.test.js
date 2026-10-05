'use strict';

/**
 * Colour rules for public/styles.css (SVD-22), computed from the real file.
 *
 * jsdom has no layout and no cascade worth trusting, so this does not render
 * anything: it parses the stylesheet, resolves each rule's `color` and
 * `background` through the `:root` tokens, and computes the WCAG 2 contrast
 * ratio. Every rule that sets BOTH a text colour and a solid background must
 * reach 4.5:1 (AA, normal-size text). A descendant rule (`.a .b`) that sets
 * only a text colour is checked against the background `.a` sets, since that is
 * what it sits on (Copilot on #62 found `.window-chip .dur` that way).
 *
 * What a CSS-only scan CANNOT see: nesting that exists only in the DOM app.js
 * builds. `.berth-option-specs` is written as a standalone class, but app.js
 * renders it inside `.berth-option`, whose :hover turns --teal-soft. Those pairs
 * are pinned in NESTED_PAIRS below; add one whenever a coloured text class is
 * rendered inside a coloured container.
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

function parseRules() {
  return [...RULES_CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => {
    const body = m[2];
    const color = body.match(/(?<![-\w])color:\s*([^;]+);/);
    const bg = body.match(/background(?:-color)?:\s*([^;]+);/);
    return {
      selector: m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(),
      fg: color ? resolve(color[1]) : null,
      back: bg ? resolve(bg[1]) : null,
    };
  });
}

function rulesWithTextAndBackground() {
  const rules = parseRules();
  const backgroundOf = new Map(rules.filter((r) => r.back).map((r) => [r.selector, r.back]));
  const out = [];
  for (const r of rules) {
    if (!r.fg) continue;
    let back = r.back;
    if (!back) {
      // `.a .b` with only a colour: it sits on whatever background `.a` sets.
      const parts = r.selector.split(/\s+/);
      if (parts.length > 1) back = backgroundOf.get(parts.slice(0, -1).join(' ')) || null;
    }
    if (back) out.push({ selector: r.selector, fg: r.fg, back, ratio: contrast(r.fg, back) });
  }
  return out;
}

// [rule that sets the text colour, rule that sets the background it sits on]
// for nesting the stylesheet alone does not show (see header).
const NESTED_PAIRS = [
  ['.window-chip .dur', '.window-chip'],
  ['.berth-option-specs', '.berth-option'], // at rest: on the card
  ['.berth-option:hover .berth-option-specs', '.berth-option:hover'],
];

describe('SVD-22 colour rules in public/styles.css', () => {
  test('no literal hex colours outside :root (CLAUDE.md)', () => {
    const withoutComments = RULES_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    // 3, 4, 6 and 8 digits: #rgb, #rgba, #rrggbb, #rrggbbaa (Copilot on #62).
    expect(
      withoutComments.match(/#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b/gi) || []
    ).toEqual([]);
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

  test('a descendant text colour is checked against its parent background', () => {
    const dur = rulesWithTextAndBackground().find((r) => r.selector === '.window-chip .dur');
    expect(dur).toBeDefined(); // the inherited pair is actually found
    expect(dur.ratio).toBeGreaterThanOrEqual(4.5);
  });

  test.each(NESTED_PAIRS)('%s on %s reaches 4.5:1', (textSel, bgSel) => {
    const rules = parseRules();
    const text = rules.find((r) => r.selector === textSel && r.fg);
    const bg = rules.find((r) => r.selector === bgSel);
    expect(text).toBeDefined(); // a renamed selector must fail loudly, not pass
    expect(bg).toBeDefined();
    const back = bg.back || resolve('var(--card)'); // no background set: the card
    expect(contrast(text.fg, back)).toBeGreaterThanOrEqual(4.5);
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
