// Usage: node md_cases.js  — prints rendered HTML for representative inputs.
'use strict';
const path = require('path');
const www = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'www');
globalThis.katex = require(path.join(www, 'vendor', 'katex', 'katex.min.js'));
require(path.join(www, 'js', 'md.js'));
const md = globalThis.QB.md;
const cases = [
  "Which statement is **at a specific point in time**?",
  "AI is driving the most significant ______ cycle in our lifetime.",
  "[Calc] Using CD = k1 × λ / NA with k1 = 0.3, what is it?",
  "Gross margin $\\left(\\frac{\\text{Sales} - \\text{COGS}}{\\text{Sales}}\\right)$?",
  "Price is \\$5 and \\$10 total",
  "Inline `code $x$` and *em* and _em2_ and snake_case_name and __bold__",
  "Line one  \nLine two\nsoft",
  "- item 1\n- item **2**\n\n1. one\n2. two",
  "| a | b |\n|---|:-:|\n| 1 | $x^2$ |",
  "$$\\sum_{i=1}^n x_i$$",
  "<script>alert(1)</script> & stuff",
  "Bad math $\\frac{1$",
  "Use \\(a+b\\) inline",
  "# Heading\ntext\n\n---\n> quote",
  "x * y * z and 2*3*4",
  "Link [docs](https://example.com) and [js](javascript:alert(1))",
];
for (const c of cases) {
  console.log('IN :', JSON.stringify(c));
  console.log('OUT:', md.render(c).replace(/<span class="katex">[\s\S]*?<\/span><\/span><\/span>(<\/span>)*/g, '[KATEX]').slice(0, 400));
}
console.log('INLINE:', md.renderInline('Option with $x_1$ and **b**'));
console.log('PLAIN:', md.plain('**Bold** $x$ and `c`', 10));
