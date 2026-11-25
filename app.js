/* Pension calculator: Finland and Estonia, with a move between them.
   Everything is computed in today's euros, gross. */
(function (root) {
  "use strict";

  var NOW = new Date().getFullYear();

  // ---- Country rules -------------------------------------------------------

  // Finland: lowest old-age retirement age. Exact up to 1967, then an
  // approximation of the ETK forecast (about 1.2 months per birth year).
  function fiAgeLaw(by) {
    if (by <= 1954) return 63;
    if (by <= 1961) return 63 + (by - 1954) * 0.25;
    if (by <= 1964) return 65;
    return 65 + 1 / 12 + (by - 1965) * 0.1;
  }

  // Ministry of Finance proposal, October 2026: half a year per cohort until 70,
  // reached by those born in 1976. Later cohorts are an extrapolation.
  function fiAgeVm(by) {
    var law = fiAgeLaw(by);
    if (by < 1967) return law;
    if (by > 1976) return 70 + (by - 1976) * 0.1;
    return Math.max(law, Math.min(70, 65.5 + 0.5 * (by - 1967)));
  }

  // Finland: life expectancy coefficient, approximated.
  function fiLec(by) {
    if (by <= 1947) return 1;
    if (by <= 1964) return 1 - 0.06 * (by - 1947) / 17;
    if (by <= 1976) return 0.94 - 0.004 * (by - 1964);
    return Math.max(0.82, 0.892 - 0.002 * (by - 1976));
  }

  // Estonia: 65 for those born in 1961, then about one month per birth year.
  function eeAge(by) {
    if (by <= 1961) return 65;
    return Math.min(70, 65 + (by - 1961) / 12);
  }

  var FI_RATE = 0.244, FI_OWN = 0.073, FI_ACCRUAL = 0.015;
  var EE_BASE = 399.24, EE_YEAR_VALUE = 10.477, EE_SOCIAL_PENSION = 0.20, EE_STATE_P2 = 0.04;
  var EE_TAX = 0.22, EE_P3_SHARE = 0.15, EE_P3_CAP = 6000;

  function annuity(pot, years, rate) {
    if (years <= 0) return 0;
    if (rate < 1e-6) return pot / years / 12;
    return pot * rate / (1 - Math.pow(1 + rate, -years)) / 12;
  }

  // ---- Engine --------------------------------------------------------------

  // o: by, start, salFi, salEe, g, r, rp, endAge, fiRule, fiCut, eeCut,
  //    eeAvg, ee2, ee3, refund.  path: { a, b, move } with countries "FI"/"EE".
  function simulate(o, path) {
    var ageNow = NOW - o.by;
    var fiRet = o.fiRule === "vm" ? fiAgeVm(o.by) : fiAgeLaw(o.by);
    var eeRet = eeAge(o.by);
    var workEnd = path.b === "FI" ? fiRet : eeRet;
    var years = Math.max(0, workEnd - o.start);

    var s = { fiAcc: 0, fiYears: 0, eeYears: 0, units: 0, pot2: 0, pot3: 0, potInv: 0,
              paidFi: 0, paidFiOwn: 0, paidEeSocial: 0, paidEeState2: 0, paid2: 0, paid3: 0, refunds: 0 };

    // Real figures from the user's own statements replace the model for past years.
    var isEst = o.fiAccNow != null && o.fiKind === "estimate";
    var hasFiRec = o.fiAccNow != null && !isEst, hasP2 = o.pot2Now != null, hasP3 = o.pot3Now != null;
    var injected = false;
    var inject = function () {
      if (hasP2) s.pot2 = o.pot2Now;
      if (hasP3) s.pot3 = o.pot3Now;
      injected = true;
    };

    for (var y = 0; y < years; y++) {
      var w = Math.min(1, years - y);
      var a = o.start + y;
      var past = a < ageNow;
      if (!injected && !past) inject();
      var country = (o.by + a) < path.move ? path.a : path.b;
      var t = Math.pow(1 + o.g, a - ageNow);
      var grow = Math.pow(1 + o.r, w), mid = w * Math.pow(1 + o.r, w / 2);

      s.pot2 *= grow; s.pot3 *= grow; s.potInv *= grow;

      if (country === "FI") {
        var salF = o.salFi * 12 * t;
        if (!(past && hasFiRec)) s.fiAcc += w * FI_ACCRUAL * salF * Math.pow(1 + 0.8 * o.g, Math.max(0, fiRet - a - w));
        s.fiYears += w;
        s.potInv += FI_RATE * salF * mid;
        s.paidFi += w * FI_RATE * salF;
        s.paidFiOwn += w * FI_OWN * salF;
      } else {
        var salE = o.salEe * 12 * t;
        var inP2 = o.ee2 > 0;
        s.units += w * (0.5 + 0.5 * (o.salEe / o.eeAvg) * (inP2 ? 0.8 : 1));
        s.eeYears += w;
        var c2 = inP2 ? (o.ee2 + EE_STATE_P2) * salE : 0;
        var c3 = o.ee3 * salE;
        var refund = EE_TAX * Math.min(c3, EE_P3_SHARE * salE, EE_P3_CAP);
        if (!(past && hasP2)) s.pot2 += c2 * mid;
        if (!(past && hasP3)) s.pot3 += (c3 + (o.refund ? refund : 0)) * mid;
        s.potInv += (EE_SOCIAL_PENSION + o.ee2) * salE * mid + c3 * mid;
        s.paidEeSocial += w * EE_SOCIAL_PENSION * salE;
        s.paidEeState2 += inP2 ? w * EE_STATE_P2 * salE : 0;
        s.paid2 += w * o.ee2 * salE;
        s.paid3 += w * c3;
        s.refunds += w * refund;
      }
    }

    if (!injected) inject();
    if (hasFiRec) s.fiAcc += o.fiAccNow * 12 * Math.pow(1 + 0.8 * o.g, Math.max(0, fiRet - ageNow));

    var lec = fiLec(o.by);
    // An official estimate already includes future work in Finland and the coefficient.
    // It is quoted at today's level, so it still gets wage indexation until it starts.
    var fiGross = isEst ? o.fiAccNow / lec * Math.pow(1 + 0.8 * o.g, Math.max(0, fiRet - ageNow)) : s.fiAcc / 12;
    var fi = fiGross * lec * (1 - o.fiCut);

    var total = s.fiYears + s.eeYears;
    var baseShare = total > 0 ? s.eeYears / total : 0;
    var idx = Math.pow(1 + 0.8 * o.g, Math.max(0, eeRet - ageNow));
    var ee1 = s.eeYears > 0 ? (EE_BASE * baseShare + s.units * EE_YEAR_VALUE) * idx * (1 - o.eeCut) : 0;

    var n = Math.max(0, o.endAge - workEnd);
    var ee2m = annuity(s.pot2, n, o.rp);
    var ee3m = annuity(s.pot3, n, o.rp);
    var inv = annuity(s.potInv, n, o.rp);

    var monthly = fi + ee1 + ee2m + ee3m;
    var lifetime = fi * 12 * Math.max(0, o.endAge - fiRet) +
                   ee1 * 12 * Math.max(0, o.endAge - eeRet) +
                   (ee2m + ee3m) * 12 * n;

    return {
      fiRet: fiRet, eeRet: eeRet, workEnd: workEnd, lec: lec, baseShare: baseShare,
      fiGross: fiGross, fi: fi, ee1: ee1, ee2m: ee2m, ee3m: ee3m,
      monthly: monthly, lifetime: lifetime,
      inv: inv, invLifetime: inv * 12 * n, payoutYears: n, sums: s
    };
  }

  var api = { simulate: simulate, fiAgeLaw: fiAgeLaw, fiAgeVm: fiAgeVm, fiLec: fiLec, eeAge: eeAge, annuity: annuity };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;

  // ---- Page ----------------------------------------------------------------

  var $ = function (id) { return document.getElementById(id); };
  var num = function (id) { var v = parseFloat($(id).value); return isFinite(v) ? v : 0; };
  var opt = function (id) { var v = parseFloat($(id).value); return isFinite(v) && v >= 0 ? v : null; };
  var eur = function (v) { return Math.round(v).toLocaleString("en-GB").replace(/,/g, " ") + " €"; };
  var pct = function (v) { return (Math.round(v * 10) / 10) + " %"; };
  var NAME = { FI: "Finland", EE: "Estonia" };
  var ageText = function (a) {
    var y = Math.floor(a + 1e-9), m = Math.round((a - y) * 12);
    if (m === 12) { y += 1; m = 0; }
    return y + " y" + (m ? " " + m + " m" : "");
  };

  var FIELDS = ["by", "start", "ca", "move", "cb", "salFi", "salEe", "g", "r", "endAge", "rp",
                "fiRule", "fiCut", "ee2", "ee3", "refund", "eeAvg", "eeCut", "fiAccNow", "fiKind", "pot2Now", "pot3Now"];

  function loadFromUrl() {
    var q = new URLSearchParams(root.location.search);
    FIELDS.forEach(function (id) {
      if (!q.has(id)) return;
      var el = $(id), v = q.get(id);
      if (el.type === "checkbox") { el.checked = v === "1"; return; }
      if (el.tagName === "SELECT") {
        for (var i = 0; i < el.options.length; i++) if (el.options[i].value === v) el.value = v;
        return;
      }
      if (isFinite(parseFloat(v))) el.value = parseFloat(v);
    });
  }

  function saveToUrl() {
    var q = new URLSearchParams();
    FIELDS.forEach(function (id) {
      var el = $(id);
      q.set(id, el.type === "checkbox" ? (el.checked ? "1" : "0") : el.value);
    });
    try { root.history.replaceState(null, "", "?" + q.toString()); } catch (e) { /* file:// */ }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function drawRows(rows, salary) {
    var box = $("rows");
    box.textContent = "";
    var max = Math.max.apply(null, rows.map(function (x) { return x.total; }).concat([1]));
    rows.forEach(function (x) {
      var row = el("div", "row");
      var name = el("div", "name", x.name);
      name.appendChild(el("span", "sub", x.sub));
      var bar = el("div", "bar");
      x.segs.forEach(function (sg) {
        if (sg[1] <= 0) return;
        var seg = el("div", "seg " + sg[0]);
        seg.style.width = (sg[1] / max * 100).toFixed(2) + "%";
        seg.title = sg[2] + ": " + eur(sg[1]);
        bar.appendChild(seg);
      });
      var val = el("div", "val", eur(x.total));
      val.appendChild(el("small", null, (salary > 0 ? Math.round(x.total / salary * 100) : 0) + " % of salary"));
      row.appendChild(name); row.appendChild(bar); row.appendChild(val);
      box.appendChild(row);
    });
  }

  function fillTable(id, lines) {
    var table = $(id);
    table.textContent = "";
    lines.forEach(function (l) {
      if (!l) return;
      var tr = el("tr", l[2] || null);
      tr.appendChild(el("td", null, l[0]));
      tr.appendChild(el("td", null, l[1] == null ? "" : l[1]));
      table.appendChild(tr);
    });
  }

  function render() {
    var o = {
      by: Math.round(num("by")), start: num("start"),
      salFi: num("salFi"), salEe: num("salEe"),
      g: num("g") / 100, r: num("r") / 100, rp: num("rp") / 100, endAge: num("endAge"),
      fiRule: $("fiRule").value, fiCut: num("fiCut") / 100, eeCut: num("eeCut") / 100,
      eeAvg: Math.max(1, num("eeAvg")), ee2: num("ee2") / 100, ee3: num("ee3") / 100,
      refund: $("refund").checked,
      fiAccNow: opt("fiAccNow"), fiKind: $("fiKind").value, pot2Now: opt("pot2Now"), pot3Now: opt("pot3Now")
    };
    var model = {};
    Object.keys(o).forEach(function (k) { model[k] = o[k]; });
    model.fiAccNow = model.pot2Now = model.pot3Now = null;
    var path = { a: $("ca").value, b: $("cb").value, move: Math.round(num("move")) };
    var moved = path.a !== path.b;

    $("fiCutOut").textContent = Math.round(o.fiCut * 100);
    $("eeCutOut").textContent = Math.round(o.eeCut * 100);
    $("moveHint").textContent = moved
      ? "You were " + (path.move - o.by) + " in " + path.move + ". " + NAME[path.a] + " before, " + NAME[path.b] + " from that year on."
      : "Same country before and after, so the move year is ignored.";
    var cap = o.salEe > 0 ? Math.min(15, EE_P3_CAP / (o.salEe * 12) * 100) : 0;
    $("ee3Hint").textContent = "Tax refund applies up to " + pct(cap) + " at this salary (" + eur(cap / 100 * o.salEe) + " a month).";
    $("fiAgeHint").textContent = "Born " + o.by + ": current law " + ageText(fiAgeLaw(o.by)) + ", proposal " + ageText(fiAgeVm(o.by)) + ".";

    var mine = simulate(o, path);
    var allFi = simulate(model, { a: "FI", b: "FI", move: 0 });
    var allEe = simulate(model, { a: "EE", b: "EE", move: 0 });
    var lastSalary = path.b === "FI" ? o.salFi : o.salEe;
    var label = moved ? NAME[path.a] + " until " + path.move + ", then " + NAME[path.b] : "Whole career in " + NAME[path.a];

    var segsOf = function (x) {
      return [["fi", x.fi, "Finland earnings-related"], ["ee1", x.ee1, "Estonia pillar I"],
              ["p2", x.ee2m, "Estonia pillar II"], ["p3", x.ee3m, "Estonia pillar III"]];
    };
    var rows = [
      { name: "Your path", sub: label, segs: segsOf(mine), total: mine.monthly },
      { name: "Same contributions, invested", sub: "pot " + eur(mine.sums.potInv) + " at " + ageText(mine.workEnd),
        segs: [["inv", mine.inv, "Invested"]], total: mine.inv }
    ];
    if (moved || path.a !== "FI") rows.push({ name: "Whole career in Finland", sub: "for comparison, retire at " + ageText(allFi.fiRet), segs: segsOf(allFi), total: allFi.monthly });
    if (moved || path.a !== "EE") rows.push({ name: "Whole career in Estonia", sub: "for comparison, retire at " + ageText(allEe.eeRet), segs: segsOf(allEe), total: allEe.monthly });
    drawRows(rows, lastSalary);

    var v = $("verdict");
    v.textContent = "";
    var say = function (text, strong) { v.appendChild(strong ? el("strong", null, text) : document.createTextNode(text)); };
    say("Born " + o.by + ", " + label.charAt(0).toLowerCase() + label.slice(1) + ": ");
    say(eur(mine.monthly), true);
    say(" a month once every pension is paying");
    if (mine.fi > 0 && mine.ee1 + mine.ee2m + mine.ee3m > 0) {
      say(" (Finland " + eur(mine.fi) + " from age " + ageText(mine.fiRet) + ", Estonia " + eur(mine.ee1 + mine.ee2m + mine.ee3m) + " from age " + ageText(mine.eeRet) + ")");
    }
    say(". The same contributions invested would pay ");
    say(eur(mine.inv), true);
    if (mine.monthly > 0) say(", " + (mine.inv / mine.monthly).toFixed(1) + " times as much");
    say(".");

    var s = mine.sums;
    var hasFi = s.fiYears > 0 || mine.fi > 0;
    var hasEe = s.eeYears > 0 || mine.ee2m + mine.ee3m > 0;
    fillTable("pathTable", [
      hasFi && ["Finland", null, "head"],
      hasFi && ["Years worked", s.fiYears.toFixed(1)],
      hasFi && ["Pension starts at", ageText(mine.fiRet) + " (" + Math.round(o.by + mine.fiRet) + ")"],
      hasFi && o.fiAccNow != null && [o.fiKind === "estimate" ? "Official estimate, from your pension record" : "Accrued so far, from your pension record", eur(o.fiAccNow)],
      hasFi && ["Accrued pension at retirement", eur(mine.fiGross)],
      hasFi && ["Life expectancy coefficient", "× " + mine.lec.toFixed(3)],
      hasFi && o.fiCut > 0 && ["Further cut", "− " + Math.round(o.fiCut * 100) + " %"],
      hasFi && ["Earnings-related pension", eur(mine.fi)],
      hasEe && ["Estonia", null, "head"],
      hasEe && ["Years worked", s.eeYears.toFixed(1)],
      hasEe && ["Pension starts at", ageText(mine.eeRet) + " (" + Math.round(o.by + mine.eeRet) + ")"],
      hasEe && ["Pillar I" + (mine.baseShare < 1 ? ", base part " + Math.round(mine.baseShare * 100) + " %" : "") + (o.eeCut > 0 ? ", after " + Math.round(o.eeCut * 100) + " % cut" : ""), eur(mine.ee1)],
      hasEe && ["Pillar II, pot " + eur(s.pot2) + (o.pot2Now != null ? " (from " + eur(o.pot2Now) + " today)" : ""), eur(mine.ee2m)],
      hasEe && ["Pillar III, pot " + eur(s.pot3) + (o.pot3Now != null ? " (from " + eur(o.pot3Now) + " today)" : ""), eur(mine.ee3m)],
      ["Total per month", eur(mine.monthly), "total"],
      ["Received by age " + o.endAge, eur(mine.lifetime)]
    ]);

    fillTable("moneyTable", [
      ["Paid in over the career", null, "head"],
      s.fiYears > 0 && ["Finland, TyEL 24.4 %", eur(s.paidFi)],
      s.fiYears > 0 && ["of which from your own pay (7.30 %)", eur(s.paidFiOwn)],
      s.eeYears > 0 && ["Estonia, pension part of social tax (20 %)", eur(s.paidEeSocial)],
      s.eeYears > 0 && ["of which routed to your pillar II (4 %)", eur(s.paidEeState2)],
      s.eeYears > 0 && ["Your pillar II contributions", eur(s.paid2)],
      s.eeYears > 0 && ["Your pillar III contributions", eur(s.paid3)],
      s.eeYears > 0 && ["Income tax refunded on pillar III", eur(s.refunds)],
      ["Total paid in", eur(s.paidFi + s.paidEeSocial + s.paid2 + s.paid3), "total"],
      ["If all of it had been invested", null, "head"],
      ["Pot at " + ageText(mine.workEnd), eur(s.potInv)],
      ["Per month until age " + o.endAge, eur(mine.inv), "total"],
      ["Received by age " + o.endAge, eur(mine.invLifetime)]
    ]);

    saveToUrl();
  }

  $("maxBtn").addEventListener("click", function () {
    var sal = num("salEe");
    $("ee2").value = "6";
    $("ee3").value = sal > 0 ? (Math.floor(Math.min(15, EE_P3_CAP / (sal * 12) * 100) * 10) / 10) : 0;
    $("refund").checked = true;
    render();
  });
  $("copyBtn").addEventListener("click", function () {
    var done = function () { $("copyBtn").textContent = "Link copied"; setTimeout(function () { $("copyBtn").textContent = "Copy link to this scenario"; }, 1800); };
    if (navigator.clipboard) navigator.clipboard.writeText(root.location.href).then(done, function () {});
  });
  loadFromUrl();
  Array.prototype.forEach.call(document.querySelectorAll("input, select"), function (n) {
    n.addEventListener("input", render);
    n.addEventListener("change", render);
  });
  render();
})(typeof window !== "undefined" ? window : this);
