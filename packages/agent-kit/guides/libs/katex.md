# Math with KaTeX (`@studio/lab-kit/math`)

```ts
import { renderMath, tex } from "@studio/lab-kit/math";
renderMath();                         // typesets $inline$ and $$display$$ math already in the page
readout.innerHTML = tex(String.raw`R = \frac{v^2 \sin 2\theta}{g}`);
readout.innerHTML = tex(String.raw`\int_0^1 x^2\,dx`, true);   // display mode
```

- Call `renderMath()` once after the page markup exists. For text you insert later, call `renderMath(thatElement)` or use `tex()`.
- Use `String.raw` for TeX in code so backslashes survive.
- KaTeX supports most of LaTeX math (fractions, matrices, `\begin{aligned}`, `\vec`, `\text{}`), not packages like TikZ.
- Fonts are inlined automatically; do not load any font files.
