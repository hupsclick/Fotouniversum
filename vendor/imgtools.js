/* imgtools – Schärfemessung per Laplace-Varianz (je höher, desto schärfer) */
(function (g) {
  'use strict';
  const c = document.createElement('canvas');
  const x = c.getContext('2d', { willReadFrequently: true });
  function sharpness(source, sw, sh, target) {
    target = target || 320;
    if (!sw || !sh) return 0;
    const w = target, h = Math.max(8, Math.round(target * sh / sw));
    c.width = w; c.height = h;
    x.drawImage(source, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) gray[j] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    let sum = 0, sum2 = 0, n = 0;
    for (let yy = 1; yy < h - 1; yy++) for (let xx = 1; xx < w - 1; xx++) {
      const i = yy * w + xx;
      const l = gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w] - 4 * gray[i];
      sum += l; sum2 += l * l; n++;
    }
    const mean = sum / n;
    return sum2 / n - mean * mean;
  }
  g.ImgTools = { sharpness };
})(window);
