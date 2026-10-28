/* Lesbare Schrift auf jeder Farbe: hell auf dunkel, dunkel auf hell.
   Versteht jede CSS-Farbe, die der Browser kennt (hex, rgb, hsl, oklch …). */
(function () {
  var ctx = null, cache = {};
  function rgb(c) {
    var k = String(c || "").trim();
    if (cache[k]) return cache[k];
    var m = /^#([0-9a-f]{3,8})$/i.exec(k), out = null;
    if (m) {
      var h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split("").map(function (x) { return x + x; }).join("");
      out = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    } else {
      try {
        if (!ctx) ctx = document.createElement("canvas").getContext("2d");
        ctx.fillStyle = "#010203"; ctx.fillStyle = k;
        var v = ctx.fillStyle;
        if (v !== "#010203" || k === "#010203") {
          if (v[0] === "#") return (cache[k] = rgb(v));
          var n = v.match(/[\d.]+/g);
          if (n && n.length >= 3) out = [+n[0], +n[1], +n[2]];
        }
      } catch (e) { out = null; }
    }
    return (cache[k] = out);
  }
  function lum(c) {
    var p = rgb(c); if (!p) return null;
    var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]);
  }
  function kontrast(a, b) {
    var x = lum(a), y = lum(b); if (x == null || y == null) return 21;
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  var HELL = "#ffffff", DUNKEL = "#141210";
  function auf(c) { var l = lum(c); if (l == null) return HELL; return kontrast(c, HELL) >= kontrast(c, DUNKEL) ? HELL : DUNKEL; }
  /* Behält die gewählte Schrift, solange sie gut lesbar ist (4,5:1). */
  function lesbar(ink, grund) { return kontrast(ink, grund) >= 4.5 ? ink : auf(grund); }
  window.ChronikFarbe = { kontrast: kontrast, auf: auf, lesbar: lesbar };
})();
