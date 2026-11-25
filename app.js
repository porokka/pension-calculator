/* Cross-border pension calculator: Finland, Estonia, Belgium and Switzerland,
   with a chain of moves between them. Everything is in today's euros, per month. */
(function (root) {
  "use strict";

  var NOW = new Date().getFullYear();

  // ---- Retirement ages -----------------------------------------------------

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

  // Switzerland: reference age 65.
  function chAge() { return 65; }

  // ---- Contribution and benefit rules --------------------------------------

  var FI_RATE = 0.244, FI_OWN = 0.073, FI_ACCRUAL = 0.015;
  var EE_BASE = 399.24, EE_YEAR_VALUE = 10.477, EE_SOCIAL_PENSION = 0.20, EE_STATE_P2 = 0.04;
  var EE_TAX = 0.22, EE_P3_SHARE = 0.15, EE_P3_CAP = 6000, EE_PENSION_EXEMPT = 776;
  var BE_RATE = 0.1636, BE_OWN = 0.075, BE_CEILING = 82608.94, BE_SHARE = 0.60, BE_CAREER = 45;
  var BE_P3_LOW = 1050, BE_P3_HIGH = 1350;
  // Switzerland, in francs (2026).
  var CH_AHV_RATE = 0.087, CH_AHV_MIN = 1260, CH_AHV_YEARS = 44;
  var CH_BVG_ENTRY = 22680, CH_BVG_DEDUCT = 26460, CH_BVG_MAX = 90720, CH_BVG_MIN_COORD = 3780;
  var CH_3A_MAX = 7258, CH_3A_SAVING = 0.25;

  // Belgian pension savings: 30 % on up to 1 050 €, or 25 % on the whole amount up to 1 350 €.
  function beRefundOf(amount) {
    if (amount <= 0) return 0;
    if (amount <= BE_P3_LOW) return 0.30 * amount;
    return 0.25 * Math.min(amount, BE_P3_HIGH);
  }

  // Swiss first pillar: monthly pension in francs from average yearly income.
  function ahvScale(avg) {
    var m = avg <= 36 * CH_AHV_MIN ? 0.74 * CH_AHV_MIN + avg * 13 / 600 : 1.04 * CH_AHV_MIN + avg * 8 / 600;
    return Math.max(CH_AHV_MIN, Math.min(2 * CH_AHV_MIN, m));
  }

  // Swiss second pillar: retirement credit as a share of the coordinated salary.
  function bvgRate(age) {
    if (age < 25) return 0;
    if (age < 35) return 0.07;
    if (age < 45) return 0.10;
    if (age < 55) return 0.15;
    return 0.18;
  }

  // ---- Tax on pension income -----------------------------------------------
  // Effective rates for a single pensioner with no other income. Approximate.

  // Finland 2026, average municipal and church tax, euros per month.
  var TAX_FI = [[1000, 0], [1250, 0.05], [1500, 0.098], [2000, 0.174], [2500, 0.213], [3000, 0.241],
                [4000, 0.307], [5000, 0.345], [7000, 0.395], [10000, 0.44]];
  // Belgium 2026: withholding tax, 3.55 % health contribution, solidarity. Euros per month.
  var TAX_BE = [[1500, 0], [1700, 0.03], [1882, 0.074], [2500, 0.182], [3000, 0.241],
                [4000, 0.31], [5000, 0.36], [7000, 0.415]];
  // Switzerland, a mid-tax canton, francs per year.
  var TAX_CH = [[20000, 0.015], [30000, 0.05], [50000, 0.095], [70000, 0.13], [100000, 0.175],
                [150000, 0.23], [250000, 0.29]];
  var BE_P2_TAX = 0.165, BE_P3_TAX = 0.08, CH_3A_TAX = 0.06;

  function rateAt(table, x) {
    if (x <= table[0][0]) return table[0][1];
    for (var i = 1; i < table.length; i++) {
      if (x <= table[i][0]) {
        var a = table[i - 1], b = table[i];
        return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
      }
    }
    return table[table.length - 1][1];
  }

  // Tax on gains when a private investment pot is drawn down, by country of residence.
  // monthly: the withdrawal, share: the part of it that is gain.
  function gainsTax(country, monthly, share) {
    var gain = monthly * 12 * Math.max(0, Math.min(1, share));
    var tax = 0;
    if (country === "FI") tax = 0.30 * Math.min(gain, 30000) + 0.34 * Math.max(0, gain - 30000);
    else if (country === "EE") tax = 0.22 * gain;
    else if (country === "BE") tax = 0.10 * Math.max(0, gain - 10000);
    return tax / 12;
  }

  function annuity(pot, years, rate) {
    if (years <= 0) return 0;
    if (rate < 1e-6) return pot / years / 12;
    return pot * rate / (1 - Math.pow(1 + rate, -years)) / 12;
  }

  // ---- Engine --------------------------------------------------------------

  // legs: [{ c: "FI" | "EE" | "BE" | "CH", from: year }], in order. The first
  // leg's "from" is ignored. A later leg takes over from its year on.
  function countryAt(legs, year) {
    var c = legs[0].c;
    for (var i = 1; i < legs.length; i++) if (year >= legs[i].from) c = legs[i].c;
    return c;
  }

  function simulate(o, legs) {
    var ageNow = NOW - o.by;
    var chf = o.chf > 0 ? o.chf : 1.07;                 // euros per franc
    var chInt = o.chInt != null ? o.chInt : 0.01;
    var chConv = o.chConv != null ? o.chConv : 0.06;
    var ret = { FI: o.fiRule === "vm" ? fiAgeVm(o.by) : fiAgeLaw(o.by), EE: eeAge(o.by), BE: beAge(o.by), CH: chAge(o.by) };
    var home = legs[legs.length - 1].c;
    var workEnd = ret[home];
    var years = Math.max(0, workEnd - o.start);

    var s = {
      years: { FI: 0, EE: 0, BE: 0, CH: 0 }, fiAcc: 0, units: 0, beAcc: 0, chIncome: 0, ch2: 0,
      pot: { ee2: 0, ee3: 0, be2: 0, be3: 0, ch3: 0 }, potInv: 0, invBasis: 0, own: 0, ownBasis: 0,
      paid: { fi: 0, fiOwn: 0, eeSocial: 0, eeState2: 0, ee2: 0, ee3: 0, eeRefund: 0,
              be: 0, beOwn: 0, be2: 0, be3: 0, beRefund: 0,
              ch: 0, chOwn: 0, ch2: 0, ch3: 0, chRefund: 0 }
    };

    // Real figures from the user's own statements replace the model for past years.
    var isEst = o.fiAccNow != null && o.fiKind === "estimate";
    var hasFiRec = o.fiAccNow != null && !isEst;
    var real = { ee2: o.pot2Now, ee3: o.pot3Now, be2: o.bePot2Now, be3: o.bePot3Now, ch3: o.chPot3Now };
    var hasCh2 = o.chPot2Now != null;
    var injected = false;
    var inject = function () {
      Object.keys(real).forEach(function (k) { if (real[k] != null) s.pot[k] = real[k]; });
      if (hasCh2) s.ch2 = o.chPot2Now;
      s.own = o.ownNow || 0;
      s.ownBasis = o.ownNow || 0;
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
      var invest = function (amount) { s.potInv += amount * mid; s.invBasis += amount * w; };

      Object.keys(s.pot).forEach(function (k) { s.pot[k] *= grow; });
      s.potInv *= grow;
      s.ch2 *= Math.pow(1 + chInt, w);
      // The user's own investments: today's value plus what they keep adding.
      s.own *= grow;
      if (!past) { s.own += (o.ownMonthly || 0) * 12 * mid; s.ownBasis += (o.ownMonthly || 0) * 12 * w; }

      if (country === "FI") {
        var salF = o.salFi * 12 * t;
        if (!(past && hasFiRec)) s.fiAcc += w * FI_ACCRUAL * salF * Math.pow(1 + 0.8 * o.g, Math.max(0, ret.FI - a - w));
        s.years.FI += w;
        invest(FI_RATE * salF);
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
        invest((EE_SOCIAL_PENSION + o.ee2) * salE + c3);
        s.paid.eeSocial += w * EE_SOCIAL_PENSION * salE;
        s.paid.eeState2 += inP2 ? w * EE_STATE_P2 * salE : 0;
        s.paid.ee2 += w * o.ee2 * salE;
        s.paid.ee3 += w * c3;
        s.paid.eeRefund += w * refund;
      } else if (country === "BE") {
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
        invest((BE_RATE + o.be2) * salB + b3);
        s.paid.be += w * BE_RATE * salB;
        s.paid.beOwn += w * BE_OWN * salB;
        s.paid.be2 += w * b2;
        s.paid.be3 += w * b3;
        s.paid.beRefund += w * bRefund;
      } else {
        var salC = o.salCh * 12 * t;
        var francs = salC / chf;
        s.chIncome += w * o.salCh * 12 / chf;            // at today's wage level
        s.years.CH += w;
        // Second pillar: age credits on the salary between the deduction and the cap.
        var coord = francs > CH_BVG_ENTRY ? Math.max(CH_BVG_MIN_COORD, Math.min(francs, CH_BVG_MAX) - CH_BVG_DEDUCT) : 0;
        var credit = bvgRate(a) * coord * chf;
        if (!(past && hasCh2)) s.ch2 += credit * w * Math.pow(1 + chInt, w / 2);
        var k3 = o.ch3 || 0;
        var kRefund = CH_3A_SAVING * Math.min(k3, CH_3A_MAX * chf);
        put("ch3", k3 + (o.chRefund ? kRefund : 0));
        invest(CH_AHV_RATE * salC + credit + k3);
        s.paid.ch += w * CH_AHV_RATE * salC;
        s.paid.chOwn += w * CH_AHV_RATE / 2 * salC;
        s.paid.ch2 += w * credit;
        s.paid.ch3 += w * k3;
        s.paid.chRefund += w * kRefund;
      }
    }
    if (!injected) inject();
    if (hasFiRec) s.fiAcc += o.fiAccNow * 12 * Math.pow(1 + 0.8 * o.g, Math.max(0, ret.FI - ageNow));

    // ---- Gross amounts per month
    var lec = fiLec(o.by);
    // An official estimate already includes the coefficient and is in today's
    // euros, so it is used exactly as entered.
    var fiGross = isEst ? o.fiAccNow / lec : s.fiAcc / 12;
    var fi = fiGross * lec * (1 - o.fiCut);

    var total = s.years.FI + s.years.EE + s.years.BE + s.years.CH;
    var baseShare = total > 0 ? s.years.EE / total : 0;
    var idx = Math.pow(1 + 0.8 * o.g, Math.max(0, ret.EE - ageNow));
    var ee1 = s.years.EE > 0 ? (EE_BASE * baseShare + s.units * EE_YEAR_VALUE) * idx * (1 - o.eeCut) : 0;

    var be1 = s.beAcc / 12 * (1 - (o.beCut || 0));

    // Swiss first pillar: scale pension, pro rata for missing years, 13 payments a year.
    var chIdx = Math.pow(1 + 0.5 * o.g, Math.max(0, ret.CH - ageNow));
    var ch1 = s.years.CH > 0
      ? ahvScale(s.chIncome / s.years.CH) * Math.min(1, s.years.CH / CH_AHV_YEARS) * 13 / 12 * chf * chIdx * (1 - (o.chCut || 0))
      : 0;
    var ch2m = s.ch2 * chConv / 12;

    var n = Math.max(0, o.endAge - workEnd);
    var m = {};
    Object.keys(s.pot).forEach(function (k) { m[k] = annuity(s.pot[k], n, o.rp); });
    var ownM = annuity(s.own, n, o.rp);
    var invM = annuity(s.potInv, n, o.rp);

    // ---- Tax. Each country's pension is taxed under that country's own rules.
    var chRate = rateAt(TAX_CH, (ch1 + ch2m) * 12 / chf);
    var ownShare = s.own > 0 ? 1 - s.ownBasis / s.own : 0;
    var invShare = s.potInv > 0 ? 1 - s.invBasis / s.potInv : 0;

    var items = [];
    var add = function (key, c, cls, label, gross, tax, start) {
      if (gross > 0) items.push({ key: key, c: c, cls: cls, label: label, gross: gross, tax: tax, net: gross - tax, start: start });
    };
    add("fi", "FI", "fi", "Finland earnings-related", fi, fi * rateAt(TAX_FI, fi), ret.FI);
    add("ee1", "EE", "ee1", "Estonia pillar I", ee1, EE_TAX * Math.max(0, ee1 - EE_PENSION_EXEMPT), ret.EE);
    add("be1", "BE", "be1", "Belgium statutory", be1, be1 * rateAt(TAX_BE, be1), ret.BE);
    add("ch1", "CH", "ch1", "Switzerland pillar 1", ch1, ch1 * chRate, ret.CH);
    add("ee2", "EE", "p2", "Estonia pillar II", m.ee2, 0, workEnd);
    add("be2", "BE", "p2", "Belgium pillar II", m.be2, m.be2 * BE_P2_TAX, workEnd);
    add("ch2", "CH", "p2", "Switzerland pillar 2", ch2m, ch2m * chRate, ret.CH);
    add("ee3", "EE", "p3", "Estonia pillar III", m.ee3, 0, workEnd);
    add("be3", "BE", "p3", "Belgium pillar III", m.be3, m.be3 * BE_P3_TAX, workEnd);
    add("ch3", "CH", "p3", "Switzerland pillar 3a", m.ch3, m.ch3 * CH_3A_TAX, workEnd);
    add("own", null, "own", "Own investments", ownM, gainsTax(home, ownM, ownShare), workEnd);

    var sum = function (f) { return items.reduce(function (acc, it) { return acc + f(it); }, 0); };
    var span = function (it) { return 12 * Math.max(0, o.endAge - it.start); };
    var invTax = gainsTax(home, invM, invShare);
    var ownItem = items.filter(function (it) { return it.key === "own"; })[0] || { gross: 0, tax: 0, net: 0 };

    return {
      ret: ret, workEnd: workEnd, home: home, lec: lec, baseShare: baseShare, fiGross: fiGross,
      items: items, pots: m, payoutYears: n,
      gross: sum(function (it) { return it.gross; }),
      tax: sum(function (it) { return it.tax; }),
      net: sum(function (it) { return it.net; }),
      lifetimeGross: sum(function (it) { return it.gross * span(it); }),
      lifetimeNet: sum(function (it) { return it.net * span(it); }),
      inv: { gross: invM, tax: invTax, net: invM - invTax, own: ownItem,
             totalGross: invM + ownItem.gross, totalNet: invM - invTax + ownItem.net },
      sums: s
    };
  }

  var api = { simulate: simulate, fiAgeLaw: fiAgeLaw, fiAgeVm: fiAgeVm, fiLec: fiLec, eeAge: eeAge, beAge: beAge,
              ahvScale: ahvScale, rateAt: rateAt, annuity: annuity };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;

  // ---- Page ----------------------------------------------------------------

  var $ = function (id) { return document.getElementById(id); };
  var num = function (id) { var v = parseFloat($(id).value); return isFinite(v) ? v : 0; };
  var opt = function (id) { var v = parseFloat($(id).value); return isFinite(v) && v >= 0 ? v : null; };
  var eur = function (v) { return Math.round(v).toLocaleString("en-GB").replace(/,/g, " ") + " €"; };
  var pct = function (v) { return (Math.round(v * 10) / 10) + " %"; };
  var NAME = { FI: "Finland", EE: "Estonia", BE: "Belgium", CH: "Switzerland" };
  var CODES = ["FI", "EE", "BE", "CH"];
  var ORDER = ["fi", "ee1", "be1", "ch1", "p2", "p3", "own", "inv"];
  var CLS_LABEL = { fi: "Finland earnings-related", ee1: "Estonia pillar I", be1: "Belgium statutory", ch1: "Switzerland pillar 1",
                    p2: "Pillar II", p3: "Pillar III", own: "Own investments", inv: "Invested" };
  var ageText = function (a) {
    var y = Math.floor(a + 1e-9), mo = Math.round((a - y) * 12);
    if (mo === 12) { y += 1; mo = 0; }
    return y + " y" + (mo ? " " + mo + " m" : "");
  };

  var FIELDS = ["view", "by", "start", "salFi", "salEe", "salBe", "salCh",
                "g", "r", "endAge", "rp", "ownNow", "ownMonthly",
                "fiRule", "fiAccNow", "fiKind", "fiCut",
                "ee2", "ee3", "refund", "pot2Now", "pot3Now", "eeAvg", "eeCut",
                "be2", "be3", "beRefund", "bePot2Now", "bePot3Now", "beCut",
                "chf", "chInt", "chConv", "ch3", "chRefund", "chPot2Now", "chPot3Now", "chCut"];

  // The career is a chain: a first country, then any number of moves.
  var MAX_LEGS = 6;
  var chain = [{ c: "FI", from: 0 }, { c: "EE", from: 2023 }];

  function parsePath(text) {
    var out = [];
    text.split(":").forEach(function (part) {
      var bits = part.split(","), year = parseInt(bits[1], 10);
      if (CODES.indexOf(bits[0]) < 0) return;
      out.push({ c: bits[0], from: out.length === 0 ? 0 : (isFinite(year) ? year : NOW) });
    });
    return out.length ? out.slice(0, MAX_LEGS) : null;
  }

  function pathText() {
    return chain.map(function (l, i) { return i === 0 ? l.c : l.c + "," + l.from; }).join(":");
  }

  function loadFromUrl() {
    var q = new URLSearchParams(root.location.search);
    var parsed = q.has("path") ? parsePath(q.get("path")) : null;
    if (!parsed && q.has("ca")) {
      // Links made before the chain existed.
      parsed = parsePath(q.get("ca") + ":" + q.get("cb") + "," + q.get("move") +
                         (q.get("cc") && q.get("cc") !== "none" ? ":" + q.get("cc") + "," + q.get("move2") : ""));
    }
    if (parsed) chain = parsed;
    FIELDS.forEach(function (id) {
      if (!q.has(id)) return;
      var node = $(id), v = q.get(id);
      if (node.type === "checkbox") { node.checked = v === "1"; return; }
      if (node.tagName === "SELECT") {
        for (var i = 0; i < node.options.length; i++) if (node.options[i].value === v) node.value = v;
        return;
      }
      if (isFinite(parseFloat(v))) node.value = parseFloat(v);
    });
  }

  function saveToUrl() {
    var q = new URLSearchParams();
    q.set("path", pathText());
    FIELDS.forEach(function (id) {
      var node = $(id);
      q.set(id, node.type === "checkbox" ? (node.checked ? "1" : "0") : node.value);
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
        seg.title = CLS_LABEL[sg[0]] + ": " + eur(sg[1]);
        bar.appendChild(seg);
      });
      var val = el("div", "val", eur(x.total));
      val.appendChild(el("small", null, (salary > 0 ? Math.round(x.total / salary * 100) : 0) + " % of gross salary"));
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

  // Collapse the chain into the legs that actually differ.
  function readLegs() {
    var legs = [{ c: chain[0].c, from: 0 }];
    for (var i = 1; i < chain.length; i++) {
      if (chain[i].c !== legs[legs.length - 1].c) legs.push({ c: chain[i].c, from: Math.round(chain[i].from) });
    }
    return legs;
  }

  function countrySelect(id, value) {
    var sel = document.createElement("select");
    sel.id = id;
    CODES.forEach(function (c) { var op = el("option", null, NAME[c]); op.value = c; sel.appendChild(op); });
    sel.value = value;
    return sel;
  }

  function buildChain() {
    var box = $("chain");
    box.textContent = "";
    chain.forEach(function (leg, i) {
      var sel = countrySelect("leg" + i + "C", leg.c);
      sel.addEventListener("change", function () { leg.c = sel.value; render(); });
      if (i === 0) {
        var first = el("div", "field");
        var lab = el("label", null, "Worked first in");
        lab.htmlFor = sel.id;
        first.appendChild(lab); first.appendChild(sel);
        box.appendChild(first);
        return;
      }
      var row = el("div", "leg");
      var yearField = el("div", "field"), yearLabel = el("label", null, "Moved in");
      var year = document.createElement("input");
      year.type = "number"; year.id = "leg" + i + "Y"; year.min = 1960; year.max = 2090; year.step = 1; year.value = leg.from;
      yearLabel.htmlFor = year.id;
      year.addEventListener("input", function () {
        var v = parseInt(year.value, 10);
        if (isFinite(v)) { leg.from = v; render(); }
      });
      yearField.appendChild(yearLabel); yearField.appendChild(year);
      var toField = el("div", "field"), toLabel = el("label", null, "to");
      toLabel.htmlFor = sel.id;
      toField.appendChild(toLabel); toField.appendChild(sel);
      var remove = el("button", "quiet remove", "Remove");
      remove.type = "button";
      remove.setAttribute("aria-label", "Remove move " + i);
      remove.addEventListener("click", function () { chain.splice(i, 1); buildChain(); render(); });
      row.appendChild(yearField); row.appendChild(toField); row.appendChild(remove);
      box.appendChild(row);
    });
    $("addMove").hidden = chain.length >= MAX_LEGS;
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
    var clamp = function (id, lo, hi) { return Math.min(hi, Math.max(lo, num(id))); };
    var o = {
      by: Math.round(num("by")), start: num("start"),
      salFi: num("salFi"), salEe: num("salEe"), salBe: num("salBe"), salCh: num("salCh"),
      g: clamp("g", 0, 4) / 100, r: clamp("r", 0, 10) / 100, rp: clamp("rp", 0, 6) / 100, endAge: num("endAge"),
      ownNow: opt("ownNow"), ownMonthly: Math.max(0, num("ownMonthly")),
      fiRule: $("fiRule").value, fiCut: num("fiCut") / 100, eeCut: num("eeCut") / 100,
      beCut: num("beCut") / 100, chCut: num("chCut") / 100,
      eeAvg: Math.max(1, num("eeAvg")), ee2: num("ee2") / 100, ee3: num("ee3") / 100, refund: $("refund").checked,
      be2: num("be2") / 100, be3: Math.max(0, num("be3")), beRefund: $("beRefund").checked,
      chf: clamp("chf", 0.5, 2), chInt: clamp("chInt", 0, 5) / 100, chConv: clamp("chConv", 3, 8) / 100,
      ch3: Math.max(0, num("ch3")), chRefund: $("chRefund").checked,
      fiAccNow: opt("fiAccNow"), fiKind: $("fiKind").value,
      pot2Now: opt("pot2Now"), pot3Now: opt("pot3Now"), bePot2Now: opt("bePot2Now"), bePot3Now: opt("bePot3Now"),
      chPot2Now: opt("chPot2Now"), chPot3Now: opt("chPot3Now")
    };
    var net = $("view").value !== "gross";
    var pick = function (it) { return net ? it.net : it.gross; };

    var legs = readLegs();
    var label = describe(legs);
    var lastC = legs[legs.length - 1].c;
    var SAL = { FI: o.salFi, EE: o.salEe, BE: o.salBe, CH: o.salCh };

    $("fiCutOut").textContent = Math.round(o.fiCut * 100);
    $("eeCutOut").textContent = Math.round(o.eeCut * 100);
    $("beCutOut").textContent = Math.round(o.beCut * 100);
    $("chCutOut").textContent = Math.round(o.chCut * 100);
    var unordered = chain.some(function (l, i) { return i > 1 && l.from <= chain[i - 1].from; });
    $("moveHint").textContent = label + "." + (unordered ? " Move years should increase down the list." : "");
    $("gHint").textContent = "Above inflation, so 1 is typical. Also drives pension indexation." + (num("g") > 4 ? " Capped at 4; " + num("g") + " looks like a figure that includes inflation." : "");

    // Only the countries on the path are shown, and only their figures count.
    var on = {};
    legs.forEach(function (l) { on[l.c] = true; });
    CODES.forEach(function (c) { $("grp" + c).hidden = !on[c]; $("wrap" + c).hidden = !on[c]; });
    if (!on.FI) o.fiAccNow = null;
    if (!on.EE) o.pot2Now = o.pot3Now = null;
    if (!on.BE) o.bePot2Now = o.bePot3Now = null;
    if (!on.CH) o.chPot2Now = o.chPot3Now = null;

    var model = {};
    Object.keys(o).forEach(function (k) { model[k] = o[k]; });
    model.fiAccNow = model.pot2Now = model.pot3Now = model.bePot2Now = model.bePot3Now = model.chPot2Now = model.chPot3Now = null;

    var cap = o.salEe > 0 ? Math.min(15, EE_P3_CAP / (o.salEe * 12) * 100) : 0;
    $("ee3Hint").textContent = "Tax refund applies up to " + pct(cap) + " at this salary (" + eur(cap / 100 * o.salEe) + " a month).";
    $("be3Hint").textContent = "Tax reduction this year: " + eur(beRefundOf(o.be3)) + ". 30 % on up to 1 050 €, or 25 % on the whole amount up to 1 350 €.";
    $("ch3Hint").textContent = "Deductible up to " + eur(CH_3A_MAX * o.chf) + " a year (7 258 francs). The tax saved is assumed to be 25 % of the payment.";
    $("fiAgeHint").textContent = "Born " + o.by + ": current law " + ageText(fiAgeLaw(o.by)) + ", proposal " + ageText(fiAgeVm(o.by)) + ".";

    var mine = simulate(o, legs);
    var segsOf = function (x) {
      var by = {};
      x.items.forEach(function (it) { by[it.cls] = (by[it.cls] || 0) + pick(it); });
      return ORDER.filter(function (c) { return by[c] > 0; }).map(function (c) { return [c, by[c]]; });
    };
    var totalOf = function (x) { return net ? x.net : x.gross; };

    // Without a salary for a country on the path, its contributions are unknown.
    var noSalary = CODES.filter(function (c) { return mine.sums.years[c] > 0 && !(SAL[c] > 0); });
    var gap = noSalary.length ? "without " + noSalary.map(function (c) { return NAME[c]; }).join(" and ") + ": enter a salary there to include it" : "";
    var invTotal = net ? mine.inv.totalNet : mine.inv.totalGross;
    var rows = [
      { name: "Your path", sub: label, segs: segsOf(mine), total: totalOf(mine) },
      { name: "Same contributions, invested", sub: gap || "pot " + eur(mine.sums.potInv + mine.sums.own) + " at " + ageText(mine.workEnd),
        segs: [["inv", net ? mine.inv.net : mine.inv.gross], ["own", pick(mine.inv.own)]], total: invTotal }
    ];
    CODES.forEach(function (c) {
      if (legs.length === 1 || !on[c]) return;
      if (!(SAL[c] > 0)) return;
      var x = simulate(model, [{ c: c, from: 0 }]);
      rows.push({ name: "Whole career in " + NAME[c], sub: "for comparison, retire at " + ageText(x.ret[c]), segs: segsOf(x), total: totalOf(x) });
    });
    drawRows(rows, SAL[lastC]);
    $("chartTitle").textContent = net ? "Monthly pension at retirement, after tax" : "Monthly pension at retirement, before tax";

    var part = {};
    mine.items.forEach(function (it) { if (it.c) part[it.c] = (part[it.c] || 0) + pick(it); });
    var paying = CODES.filter(function (c) { return part[c] > 0; });
    var v = $("verdict");
    v.textContent = "";
    var say = function (text, strong) { v.appendChild(strong ? el("strong", null, text) : document.createTextNode(text)); };
    say("Born " + o.by + ", " + label.replace(/^Whole/, "whole") + ": ");
    say(eur(totalOf(mine)), true);
    say(" a month " + (net ? "after tax" : "before tax") + " once every pension is paying");
    var bits = paying.map(function (c) { return NAME[c] + " " + eur(part[c]) + " from age " + ageText(mine.ret[c]); });
    if (mine.inv.own.gross > 0) bits.push("your own investments " + eur(pick(mine.inv.own)));
    if (bits.length > 1) say(" (" + bits.join(", ") + ")");
    if (net && mine.gross > 0) say(". Tax takes " + eur(mine.tax) + " of " + eur(mine.gross) + ", or " + pct(mine.tax / mine.gross * 100));
    if (noSalary.length) {
      say(". The invested comparison leaves out " + noSalary.map(function (c) { return NAME[c]; }).join(" and ") + " because no salary is entered there.");
    } else {
      say(". The same contributions invested would pay ");
      say(eur(invTotal), true);
      if (totalOf(mine) > 0) say(", " + (invTotal / totalOf(mine)).toFixed(1) + " times as much");
      say(".");
    }

    var s = mine.sums, p = s.paid;
    var has = {};
    CODES.forEach(function (c) { has[c] = s.years[c] > 0 || part[c] > 0; });
    var item = function (key) { return mine.items.filter(function (it) { return it.key === key; })[0]; };
    var starts = function (c) { return ageText(mine.ret[c]) + " (" + Math.round(o.by + mine.ret[c]) + ")"; };
    var from = function (val) { return val != null ? " (from " + eur(val) + " today)" : ""; };
    // One line for the gross amount and, when tax applies, one for the tax.
    var money = function (key, text) {
      var it = item(key);
      if (!it) return [];
      var out = [[text, eur(it.gross)]];
      if (it.tax > 0.5) out.push(["tax, " + pct(it.tax / it.gross * 100), "− " + eur(it.tax)]);
      return out;
    };
    var section = function (c, lines) { return has[c] ? [[NAME[c], null, "head"], ["Years worked", s.years[c].toFixed(1)], ["Pension starts at", starts(c)]].concat(lines) : []; };
    var lines = []
      .concat(section("FI", [
        o.fiAccNow != null && [o.fiKind === "estimate" ? "Official estimate, from your pension record" : "Accrued so far, from your pension record", eur(o.fiAccNow)],
        ["Accrued pension at retirement", eur(mine.fiGross)],
        ["Life expectancy coefficient", "× " + mine.lec.toFixed(3)],
        o.fiCut > 0 && ["Further cut", "− " + Math.round(o.fiCut * 100) + " %"]
      ].concat(money("fi", "Earnings-related pension"))))
      .concat(section("EE", []
        .concat(money("ee1", "Pillar I" + (mine.baseShare < 1 ? ", base part " + Math.round(mine.baseShare * 100) + " %" : "") + (o.eeCut > 0 ? ", after " + Math.round(o.eeCut * 100) + " % cut" : "")))
        .concat(money("ee2", "Pillar II, pot " + eur(s.pot.ee2) + from(o.pot2Now)))
        .concat(money("ee3", "Pillar III, pot " + eur(s.pot.ee3) + from(o.pot3Now)))))
      .concat(section("BE", []
        .concat(money("be1", "Statutory pension" + (s.years.BE > BE_CAREER ? ", 45 years count" : "") + (o.beCut > 0 ? ", after " + Math.round(o.beCut * 100) + " % cut" : "")))
        .concat(money("be2", "Pillar II, pot " + eur(s.pot.be2) + from(o.bePot2Now)))
        .concat(money("be3", "Pillar III, pot " + eur(s.pot.be3) + from(o.bePot3Now)))))
      .concat(section("CH", []
        .concat(money("ch1", "Pillar 1 (AHV), " + Math.min(CH_AHV_YEARS, s.years.CH).toFixed(1) + " of 44 years" + (o.chCut > 0 ? ", after " + Math.round(o.chCut * 100) + " % cut" : "")))
        .concat(money("ch2", "Pillar 2, capital " + eur(s.ch2) + from(o.chPot2Now)))
        .concat(money("ch3", "Pillar 3a, pot " + eur(s.pot.ch3) + from(o.chPot3Now)))));
    if (s.own > 0) {
      lines = lines.concat([
        ["Your own investments", null, "head"],
        o.ownNow != null && ["Value today", eur(o.ownNow)],
        o.ownMonthly > 0 && ["Added from now on", eur(o.ownMonthly) + " a month"],
        ["Pot at " + ageText(mine.workEnd), eur(s.own)]
      ]).concat(money("own", "Per month until age " + o.endAge));
    }
    lines = lines.concat([
      ["Total per month, before tax", eur(mine.gross), "total"],
      ["Tax", "− " + eur(mine.tax)],
      ["Total per month, after tax", eur(mine.net), "total"],
      ["Received by age " + o.endAge + ", after tax", eur(mine.lifetimeNet)]
    ]);
    fillTable("pathTable", lines);

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
      s.years.CH > 0 && ["Switzerland, pillar 1 contributions (8.7 %)", eur(p.ch)],
      s.years.CH > 0 && ["of which from your own pay (4.35 %)", eur(p.chOwn)],
      s.years.CH > 0 && ["Switzerland, pillar 2 credits (you and employer)", eur(p.ch2)],
      s.years.CH > 0 && ["Switzerland, your pillar 3a payments", eur(p.ch3)],
      s.years.CH > 0 && ["Switzerland, tax saved on pillar 3a", eur(p.chRefund)],
      ["Total paid in", eur(s.invBasis), "total"],
      ["If all of it had been invested", null, "head"],
      ["Pot at " + ageText(mine.workEnd), eur(s.potInv)],
      ["Per month until age " + o.endAge + ", before tax", eur(mine.inv.gross)],
      ["Tax on the gains, as a resident of " + NAME[mine.home], "− " + eur(mine.inv.tax)],
      mine.inv.own.gross > 0 && ["Your own investments, after tax", eur(mine.inv.own.net)],
      ["Per month, after tax", eur(mine.inv.totalNet), "total"],
      ["Received by age " + o.endAge + ", after tax", eur(mine.inv.totalNet * 12 * mine.payoutYears)]
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
  $("chMaxBtn").addEventListener("click", function () {
    $("ch3").value = Math.floor(CH_3A_MAX * Math.min(2, Math.max(0.5, num("chf"))));
    $("chRefund").checked = true;
    render();
  });
  $("copyBtn").addEventListener("click", function () {
    var done = function () { $("copyBtn").textContent = "Link copied"; setTimeout(function () { $("copyBtn").textContent = "Copy link to this scenario"; }, 1800); };
    if (navigator.clipboard) navigator.clipboard.writeText(root.location.href).then(done, function () {});
  });
  $("addMove").addEventListener("click", function () {
    var last = chain[chain.length - 1];
    var used = chain.map(function (l) { return l.c; });
    var fresh = CODES.filter(function (c) { return used.indexOf(c) < 0; });
    var next = fresh.length ? fresh[0] : CODES.filter(function (c) { return c !== last.c; })[0];
    chain.push({ c: next, from: Math.max((last.from || 0) + 1, NOW + 1) });
    buildChain();
    render();
  });
  loadFromUrl();
  Array.prototype.forEach.call(document.querySelectorAll("input, select"), function (n) {
    n.addEventListener("input", render);
    n.addEventListener("change", render);
  });
  buildChain();
  render();
})(typeof window !== "undefined" ? window : this);
