/* Pension calculator: Finland, Estonia and Belgium, with up to two moves between them.
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

  // Belgium: 65, 66 from February 2025, 67 from February 2030.
  function beAge(by) {
    if (by <= 1959) return 65;
    if (by <= 1963) return 66;
    return 67;
  }

  var FI_RATE = 0.244, FI_OWN = 0.073, FI_ACCRUAL = 0.015;
  var EE_BASE = 399.24, EE_YEAR_VALUE = 10.477, EE_SOCIAL_PENSION = 0.20, EE_STATE_P2 = 0.04;
  var EE_TAX = 0.22, EE_P3_SHARE = 0.15, EE_P3_CAP = 6000;
  var BE_RATE = 0.1636, BE_OWN = 0.075, BE_CEILING = 82608.94, BE_SHARE = 0.60, BE_CAREER = 45;
  var BE_P3_LOW = 1050, BE_P3_HIGH = 1350;

  // Belgian pension savings: 30 % on up to 1 050 €, or 25 % on the whole amount up to 1 350 €.
  function beRefundOf(amount) {
    if (amount <= 0) return 0;
    if (amount <= BE_P3_LOW) return 0.30 * amount;
    return 0.25 * Math.min(amount, BE_P3_HIGH);
  }

  function annuity(pot, years, rate) {
    if (years <= 0) return 0;
    if (rate < 1e-6) return pot / years / 12;
    return pot * rate / (1 - Math.pow(1 + rate, -years)) / 12;
  }

  // ---- Engine --------------------------------------------------------------

  // legs: [{ c: "FI" | "EE" | "BE", from: year }], in order. The first leg's
  // "from" is ignored. A later leg takes over from its year on.
  function countryAt(legs, year) {
    var c = legs[0].c;
    for (var i = 1; i < legs.length; i++) if (year >= legs[i].from) c = legs[i].c;
    return c;
  }

  function simulate(o, legs) {
    var ageNow = NOW - o.by;
    var ret = { FI: o.fiRule === "vm" ? fiAgeVm(o.by) : fiAgeLaw(o.by), EE: eeAge(o.by), BE: beAge(o.by) };
    var workEnd = ret[legs[legs.length - 1].c];
    var years = Math.max(0, workEnd - o.start);

    var s = {
      years: { FI: 0, EE: 0, BE: 0 }, fiAcc: 0, units: 0, beAcc: 0,
      pot: { ee2: 0, ee3: 0, be2: 0, be3: 0 }, potInv: 0,
      paid: { fi: 0, fiOwn: 0, eeSocial: 0, eeState2: 0, ee2: 0, ee3: 0, eeRefund: 0,
              be: 0, beOwn: 0, be2: 0, be3: 0, beRefund: 0 }
    };

    // Real figures from the user's own statements replace the model for past years.
    var isEst = o.fiAccNow != null && o.fiKind === "estimate";
    var hasFiRec = o.fiAccNow != null && !isEst;
    var real = { ee2: o.pot2Now, ee3: o.pot3Now, be2: o.bePot2Now, be3: o.bePot3Now };
    var injected = false;
    var inject = function () {
      Object.keys(real).forEach(function (k) { if (real[k] != null) s.pot[k] = real[k]; });
      injected = true;
    };

    for (var y = 0; y < years; y++) {
      var w = Math.min(1, years - y);
      var a = o.start + y;
      var past = a < ageNow;
      if (!injected && !past) inject();
      var country = countryAt(legs, o.by + a);
      var t = Math.pow(1 + o.g, a - ageNow);
      var grow = Math.pow(1 + o.r, w), mid = w * Math.pow(1 + o.r, w / 2);
      var put = function (k, amount) { if (!(past && real[k] != null)) s.pot[k] += amount * mid; };

      Object.keys(s.pot).forEach(function (k) { s.pot[k] *= grow; });
      s.potInv *= grow;

      if (country === "FI") {
        var salF = o.salFi * 12 * t;
        if (!(past && hasFiRec)) s.fiAcc += w * FI_ACCRUAL * salF * Math.pow(1 + 0.8 * o.g, Math.max(0, ret.FI - a - w));
        s.years.FI += w;
        s.potInv += FI_RATE * salF * mid;
        s.paid.fi += w * FI_RATE * salF;
        s.paid.fiOwn += w * FI_OWN * salF;
      } else if (country === "EE") {
        var salE = o.salEe * 12 * t;
        var inP2 = o.ee2 > 0;
        s.units += w * (0.5 + 0.5 * (o.salEe / o.eeAvg) * (inP2 ? 0.8 : 1));
        s.years.EE += w;
        var c2 = inP2 ? (o.ee2 + EE_STATE_P2) * salE : 0;
        var c3 = o.ee3 * salE;
        var refund = EE_TAX * Math.min(c3, EE_P3_SHARE * salE, EE_P3_CAP);
        put("ee2", c2);
        put("ee3", c3 + (o.refund ? refund : 0));
        s.potInv += ((EE_SOCIAL_PENSION + o.ee2) * salE + c3) * mid;
        s.paid.eeSocial += w * EE_SOCIAL_PENSION * salE;
        s.paid.eeState2 += inP2 ? w * EE_STATE_P2 * salE : 0;
        s.paid.ee2 += w * o.ee2 * salE;
        s.paid.ee3 += w * c3;
        s.paid.eeRefund += w * refund;
      } else {
        var salB = o.salBe * 12 * t;
        // Each year adds 60 % of the capped salary divided by 45; at most 45 years count.
        var room = Math.max(0, Math.min(w, BE_CAREER - s.years.BE));
        s.beAcc += room * BE_SHARE * Math.min(salB, BE_CEILING) / BE_CAREER;
        s.years.BE += w;
        var b2 = o.be2 * salB;
        var b3 = o.be3;
        var bRefund = beRefundOf(b3);
        put("be2", b2);
        put("be3", b3 + (o.beRefund ? bRefund : 0));
        s.potInv += ((BE_RATE + o.be2) * salB + b3) * mid;
        s.paid.be += w * BE_RATE * salB;
        s.paid.beOwn += w * BE_OWN * salB;
        s.paid.be2 += w * b2;
        s.paid.be3 += w * b3;
        s.paid.beRefund += w * bRefund;
      }
    }
    if (!injected) inject();
    if (hasFiRec) s.fiAcc += o.fiAccNow * 12 * Math.pow(1 + 0.8 * o.g, Math.max(0, ret.FI - ageNow));

    var lec = fiLec(o.by);
    // An official estimate already includes the coefficient and is in today's
    // euros, so it is used exactly as entered.
    var fiGross = isEst ? o.fiAccNow / lec : s.fiAcc / 12;
    var fi = fiGross * lec * (1 - o.fiCut);

    var total = s.years.FI + s.years.EE + s.years.BE;
    var baseShare = total > 0 ? s.years.EE / total : 0;
    var idx = Math.pow(1 + 0.8 * o.g, Math.max(0, ret.EE - ageNow));
    var ee1 = s.years.EE > 0 ? (EE_BASE * baseShare + s.units * EE_YEAR_VALUE) * idx * (1 - o.eeCut) : 0;

    var be1 = s.beAcc / 12 * (1 - o.beCut);

    var n = Math.max(0, o.endAge - workEnd);
    var ee2m = annuity(s.pot.ee2, n, o.rp), ee3m = annuity(s.pot.ee3, n, o.rp);
    var be2m = annuity(s.pot.be2, n, o.rp), be3m = annuity(s.pot.be3, n, o.rp);
    var inv = annuity(s.potInv, n, o.rp);
    var funded = ee2m + ee3m + be2m + be3m;

    return {
      ret: ret, workEnd: workEnd, lec: lec, baseShare: baseShare,
      fiGross: fiGross, fi: fi, ee1: ee1, be1: be1,
      ee2m: ee2m, ee3m: ee3m, be2m: be2m, be3m: be3m,
      monthly: fi + ee1 + be1 + funded,
      lifetime: fi * 12 * Math.max(0, o.endAge - ret.FI) + ee1 * 12 * Math.max(0, o.endAge - ret.EE) +
                be1 * 12 * Math.max(0, o.endAge - ret.BE) + funded * 12 * n,
      inv: inv, invLifetime: inv * 12 * n, payoutYears: n, sums: s
    };
  }

  var api = { simulate: simulate, fiAgeLaw: fiAgeLaw, fiAgeVm: fiAgeVm, fiLec: fiLec, eeAge: eeAge, beAge: beAge, annuity: annuity };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;

  // ---- Page ----------------------------------------------------------------

  var $ = function (id) { return document.getElementById(id); };
  var num = function (id) { var v = parseFloat($(id).value); return isFinite(v) ? v : 0; };
  var opt = function (id) { var v = parseFloat($(id).value); return isFinite(v) && v >= 0 ? v : null; };
  var eur = function (v) { return Math.round(v).toLocaleString("en-GB").replace(/,/g, " ") + " €"; };
  var pct = function (v) { return (Math.round(v * 10) / 10) + " %"; };
  var NAME = { FI: "Finland", EE: "Estonia", BE: "Belgium" };
  var CODES = ["FI", "EE", "BE"];
  var ageText = function (a) {
    var y = Math.floor(a + 1e-9), m = Math.round((a - y) * 12);
    if (m === 12) { y += 1; m = 0; }
    return y + " y" + (m ? " " + m + " m" : "");
  };

  var FIELDS = ["by", "start", "ca", "move", "cb", "move2", "cc", "salFi", "salEe", "salBe",
                "g", "r", "endAge", "rp",
                "fiRule", "fiAccNow", "fiKind", "fiCut",
                "ee2", "ee3", "refund", "pot2Now", "pot3Now", "eeAvg", "eeCut",
                "be2", "be3", "beRefund", "bePot2Now", "bePot3Now", "beCut"];

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

  // Collapse the three selects into the legs that actually differ.
  function readLegs() {
    var legs = [{ c: $("ca").value, from: 0 }];
    var add = function (c, from) {
      if (c === "none" || c === legs[legs.length - 1].c) return;
      legs.push({ c: c, from: from });
    };
    add($("cb").value, Math.round(num("move")));
    add($("cc").value, Math.round(num("move2")));
    return legs;
  }

  function describe(legs) {
    if (legs.length === 1) return "Whole career in " + NAME[legs[0].c];
    var text = NAME[legs[0].c] + " until " + legs[1].from;
    for (var i = 1; i < legs.length; i++) {
      text += ", then " + NAME[legs[i].c] + (i + 1 < legs.length ? " until " + legs[i + 1].from : "");
    }
    return text;
  }

  function render() {
    var o = {
      by: Math.round(num("by")), start: num("start"),
      salFi: num("salFi"), salEe: num("salEe"), salBe: num("salBe"),
      g: Math.min(4, Math.max(0, num("g"))) / 100, r: Math.min(10, Math.max(0, num("r"))) / 100,
      rp: Math.min(6, Math.max(0, num("rp"))) / 100, endAge: num("endAge"),
      fiRule: $("fiRule").value, fiCut: num("fiCut") / 100, eeCut: num("eeCut") / 100, beCut: num("beCut") / 100,
      eeAvg: Math.max(1, num("eeAvg")), ee2: num("ee2") / 100, ee3: num("ee3") / 100, refund: $("refund").checked,
      be2: num("be2") / 100, be3: Math.max(0, num("be3")), beRefund: $("beRefund").checked,
      fiAccNow: opt("fiAccNow"), fiKind: $("fiKind").value,
      pot2Now: opt("pot2Now"), pot3Now: opt("pot3Now"), bePot2Now: opt("bePot2Now"), bePot3Now: opt("bePot3Now")
    };
    var model = {};
    Object.keys(o).forEach(function (k) { model[k] = o[k]; });
    model.fiAccNow = model.pot2Now = model.pot3Now = model.bePot2Now = model.bePot3Now = null;

    var legs = readLegs();
    var label = describe(legs);
    var lastC = legs[legs.length - 1].c;
    var SAL = { FI: o.salFi, EE: o.salEe, BE: o.salBe };

    $("fiCutOut").textContent = Math.round(o.fiCut * 100);
    $("eeCutOut").textContent = Math.round(o.eeCut * 100);
    $("beCutOut").textContent = Math.round(o.beCut * 100);
    $("moveHint").textContent = label + ".";
    $("gHint").textContent = "Above inflation, so 1 is typical. Also drives pension indexation." + (num("g") > 4 ? " Capped at 4; " + num("g") + " looks like a figure that includes inflation." : "");
    var cap = o.salEe > 0 ? Math.min(15, EE_P3_CAP / (o.salEe * 12) * 100) : 0;
    $("ee3Hint").textContent = "Tax refund applies up to " + pct(cap) + " at this salary (" + eur(cap / 100 * o.salEe) + " a month).";
    $("be3Hint").textContent = "Tax reduction this year: " + eur(beRefundOf(o.be3)) + ". 30 % on up to 1 050 €, or 25 % on the whole amount up to 1 350 €.";
    $("fiAgeHint").textContent = "Born " + o.by + ": current law " + ageText(fiAgeLaw(o.by)) + ", proposal " + ageText(fiAgeVm(o.by)) + ".";

    var mine = simulate(o, legs);
    var segsOf = function (x) {
      return [["fi", x.fi, "Finland earnings-related"], ["ee1", x.ee1, "Estonia pillar I"], ["be1", x.be1, "Belgium statutory"],
              ["p2", x.ee2m + x.be2m, "Pillar II"], ["p3", x.ee3m + x.be3m, "Pillar III"]];
    };
    // Without a salary for a country on the path, its contributions are unknown.
    var noSalary = CODES.filter(function (c) { return mine.sums.years[c] > 0 && !(SAL[c] > 0); });
    var gap = noSalary.length ? "without " + noSalary.map(function (c) { return NAME[c]; }).join(" and ") + ": enter a salary there to include it" : "";
    var rows = [
      { name: "Your path", sub: label, segs: segsOf(mine), total: mine.monthly },
      { name: "Same contributions, invested", sub: gap || "pot " + eur(mine.sums.potInv) + " at " + ageText(mine.workEnd),
        segs: [["inv", mine.inv, "Invested"]], total: mine.inv }
    ];
    CODES.forEach(function (c) {
      if (legs.length === 1 && legs[0].c === c) return;
      if (!(SAL[c] > 0)) return;
      var x = simulate(model, [{ c: c, from: 0 }]);
      rows.push({ name: "Whole career in " + NAME[c], sub: "for comparison, retire at " + ageText(x.ret[c]), segs: segsOf(x), total: x.monthly });
    });
    drawRows(rows, SAL[lastC]);

    var part = { FI: mine.fi, EE: mine.ee1 + mine.ee2m + mine.ee3m, BE: mine.be1 + mine.be2m + mine.be3m };
    var paying = CODES.filter(function (c) { return part[c] > 0; });
    var v = $("verdict");
    v.textContent = "";
    var say = function (text, strong) { v.appendChild(strong ? el("strong", null, text) : document.createTextNode(text)); };
    say("Born " + o.by + ", " + label.replace(/^Whole/, "whole") + ": ");
    say(eur(mine.monthly), true);
    say(" a month once every pension is paying");
    if (paying.length > 1) {
      say(" (" + paying.map(function (c) { return NAME[c] + " " + eur(part[c]) + " from age " + ageText(mine.ret[c]); }).join(", ") + ")");
    }
    if (noSalary.length) {
      say(". The invested comparison leaves out " + noSalary.map(function (c) { return NAME[c]; }).join(" and ") + " because no salary is entered there.");
    } else {
      say(". The same contributions invested would pay ");
      say(eur(mine.inv), true);
      if (mine.monthly > 0) say(", " + (mine.inv / mine.monthly).toFixed(1) + " times as much");
      say(".");
    }

    var s = mine.sums, p = s.paid;
    var hasFi = s.years.FI > 0 || part.FI > 0, hasEe = s.years.EE > 0 || part.EE > 0, hasBe = s.years.BE > 0 || part.BE > 0;
    var starts = function (c) { return ageText(mine.ret[c]) + " (" + Math.round(o.by + mine.ret[c]) + ")"; };
    var from = function (v) { return v != null ? " (from " + eur(v) + " today)" : ""; };
    fillTable("pathTable", [
      hasFi && ["Finland", null, "head"],
      hasFi && ["Years worked", s.years.FI.toFixed(1)],
      hasFi && ["Pension starts at", starts("FI")],
      hasFi && o.fiAccNow != null && [o.fiKind === "estimate" ? "Official estimate, from your pension record" : "Accrued so far, from your pension record", eur(o.fiAccNow)],
      hasFi && ["Accrued pension at retirement", eur(mine.fiGross)],
      hasFi && ["Life expectancy coefficient", "× " + mine.lec.toFixed(3)],
      hasFi && o.fiCut > 0 && ["Further cut", "− " + Math.round(o.fiCut * 100) + " %"],
      hasFi && ["Earnings-related pension", eur(mine.fi)],
      hasEe && ["Estonia", null, "head"],
      hasEe && ["Years worked", s.years.EE.toFixed(1)],
      hasEe && ["Pension starts at", starts("EE")],
      hasEe && ["Pillar I" + (mine.baseShare < 1 ? ", base part " + Math.round(mine.baseShare * 100) + " %" : "") + (o.eeCut > 0 ? ", after " + Math.round(o.eeCut * 100) + " % cut" : ""), eur(mine.ee1)],
      hasEe && ["Pillar II, pot " + eur(s.pot.ee2) + from(o.pot2Now), eur(mine.ee2m)],
      hasEe && ["Pillar III, pot " + eur(s.pot.ee3) + from(o.pot3Now), eur(mine.ee3m)],
      hasBe && ["Belgium", null, "head"],
      hasBe && ["Years worked", s.years.BE.toFixed(1) + (s.years.BE > BE_CAREER ? " (45 count)" : "")],
      hasBe && ["Pension starts at", starts("BE")],
      hasBe && ["Statutory pension" + (o.beCut > 0 ? ", after " + Math.round(o.beCut * 100) + " % cut" : ""), eur(mine.be1)],
      hasBe && ["Pillar II, pot " + eur(s.pot.be2) + from(o.bePot2Now), eur(mine.be2m)],
      hasBe && ["Pillar III, pot " + eur(s.pot.be3) + from(o.bePot3Now), eur(mine.be3m)],
      ["Total per month", eur(mine.monthly), "total"],
      ["Received by age " + o.endAge, eur(mine.lifetime)]
    ]);

    fillTable("moneyTable", [
      ["Paid in over the career", null, "head"],
      s.years.FI > 0 && ["Finland, TyEL 24.4 %", eur(p.fi)],
      s.years.FI > 0 && ["of which from your own pay (7.30 %)", eur(p.fiOwn)],
      s.years.EE > 0 && ["Estonia, pension part of social tax (20 %)", eur(p.eeSocial)],
      s.years.EE > 0 && ["of which routed to your pillar II (4 %)", eur(p.eeState2)],
      s.years.EE > 0 && ["Estonia, your pillar II contributions", eur(p.ee2)],
      s.years.EE > 0 && ["Estonia, your pillar III contributions", eur(p.ee3)],
      s.years.EE > 0 && ["Estonia, income tax refunded on pillar III", eur(p.eeRefund)],
      s.years.BE > 0 && ["Belgium, pension contributions (16.36 %)", eur(p.be)],
      s.years.BE > 0 && ["of which from your own pay (7.5 %)", eur(p.beOwn)],
      s.years.BE > 0 && ["Belgium, employer pillar II contributions", eur(p.be2)],
      s.years.BE > 0 && ["Belgium, your pension savings", eur(p.be3)],
      s.years.BE > 0 && ["Belgium, tax reduction on pension savings", eur(p.beRefund)],
      ["Total paid in", eur(p.fi + p.eeSocial + p.ee2 + p.ee3 + p.be + p.be2 + p.be3), "total"],
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
  $("beMaxBtn").addEventListener("click", function () {
    $("be3").value = BE_P3_LOW;
    $("beRefund").checked = true;
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
