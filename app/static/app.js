(() => {
  "use strict";

  const TRADE_LABEL = {
    millwright: "Millwright", electrician: "Electrician", pipefitter: "Pipefitter", laborer: "Laborer",
  };
  const LEVER_LABEL = {
    baseline: "As planned",
    plus_hookup_crews: "+1 electrician & pipefitter crew",
    half_handoff: "Half the handoff time",
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const els = {
    form: $("#form"), fields: $("#fields"), results: $("#results"), error: $("#error"),
    meta: $("#meta"), recommend: $("#recommend"), cards: $("#cards"),
    runBtn: $("#run-btn"), resetBtn: $("#reset-btn"), csvBtn: $("#csv-btn"),
    shareBtn: $("#share-btn"), themeBtn: $("#theme-btn"),
  };

  let defaults = null;   // /api/defaults payload
  let model = null;      // the inputs object the form was built from
  let last = null;       // last successful /api/simulate response
  let view = "cdf";
  let inflight = null;
  let debounce = null;
  const charts = {};

  // ---------- helpers ----------
  const money = (n) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const moneyCompact = (n) => {
    if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
    if (Math.abs(n) >= 1e4) return "$" + (n / 1e3).toFixed(1) + "K";
    return money(n);
  };
  const pct = (x, d = 0) => (x * 100).toFixed(d) + "%";
  const wk = (x) => x.toFixed(1);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const color = (i) => css(`--series-${(i % 3) + 1}`);

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "style") Object.assign(node.style, v);
      else if (k === "dataset") Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
  function setPath(obj, path, value) {
    const keys = path.split(".");
    let o = obj;
    for (const k of keys.slice(0, -1)) o = o[k];
    o[keys[keys.length - 1]] = value;
  }

  const ICON_OK = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 12.5l2.7 2.7L16 9.8"/></svg>';
  const ICON_WARN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>';
  const icon = (svg, cls) => { const s = el("span", { class: cls }); s.innerHTML = svg; return s; };

  // ---------- form ----------
  function numField(path, label, opts = {}) {
    const input = el("input", {
      type: "number", inputmode: "decimal", required: true,
      min: opts.min, max: opts.max, step: opts.step ?? "any",
      dataset: { path, scale: opts.scale ?? 1, int: opts.int ? "1" : "" },
      "aria-label": opts.aria || label,
    });
    return el("label", { class: "field" }, el("span", { text: label }), input, opts.hint && el("small", { text: opts.hint }));
  }

  function trio(path, label, opts) {
    const names = ["Min", "Likely", "Max"];
    return el("div", { class: "field" },
      el("span", { class: "trio-label", text: label }),
      el("div", { class: "row cols-3" },
        names.map((n, i) => numField(`${path}.${i}`, n, { ...opts, hint: null, aria: `${label}, ${n.toLowerCase()}` }))),
      opts.hint && el("small", { text: opts.hint }));
  }

  function buildForm(inputs) {
    model = structuredClone(inputs);
    const ref = defaults.reference;
    const trades = ref.trades;

    const program = el("fieldset", {}, el("legend", { text: "Program" }),
      el("div", { class: "row cols-2" },
        numField("n_tools", "Tools to install", { min: 1, max: defaults.limits.max_tools, step: 1, int: true }),
        numField("tools_per_week", "Delivered per week", { min: 1, max: 20, step: 1, int: true })),
      numField("target_buffer_weeks", "Finish within, weeks after final delivery", { min: 0, max: 52 }),
      numField("min_on_time", "Required on-time confidence, %", { min: 1, max: 100, scale: 100,
        hint: "The recommendation is the cheapest strategy that clears this bar." }));

    const risk = el("fieldset", {}, el("legend", { text: "Risk" }),
      trio("delivery_slip_days", "Late OEM delivery, days", { min: 0, max: 60 }),
      trio("duration_risk", "Task duration vs. plan, ×", { min: 0.05, max: 5,
        hint: "1.0 = planned hours. Right-skewed because overruns are more common than underruns." }));

    const crewSizes = trades.map((t) => `${TRADE_LABEL[t].toLowerCase()} ${ref.crew_size[t]}`).join(", ");
    const crews = el("fieldset", {}, el("legend", { text: "Crews available" }),
      el("div", { class: "row cols-2" },
        trades.map((t) => numField(`crews.${t}`, TRADE_LABEL[t], { min: 1, max: 20, step: 1, int: true }))),
      el("small", { class: "hint", style: { padding: "0 0 10px", display: "block" }, text: `People per crew: ${crewSizes}.` }));

    const strategyCards = model.strategies.map((s, i) => el("div", { class: "strategy-card" },
      el("div", { class: "key" },
        el("span", { class: "swatch", style: { background: `var(--series-${(i % 3) + 1})` } }),
        el("input", { type: "text", required: true, maxlength: 60, dataset: { path: `strategies.${i}.label`, text: "1" },
          "aria-label": `Strategy ${i + 1} name` })),
      numField(`strategies.${i}.markup_pct`, "Total markup on labor, %", { min: 0, max: 200 }),
      trio(`strategies.${i}.handoff_hours`, "Handoff gap between trades, hours", { min: 0, max: 200 }),
      el("div", { class: "field" },
        el("span", { class: "trio-label", text: "Extra crews on top of the base" }),
        el("div", { class: "row cols-4" },
          trades.map((t) => numField(`strategies.${i}.extra_crews.${t}`, TRADE_LABEL[t].slice(0, 4) + ".",
            { min: 0, max: 10, step: 1, int: true, aria: `${s.label}: extra ${TRADE_LABEL[t]} crews` }))))));

    const strategies = el("details", { class: "group", open: true },
      el("summary", { text: "Strategies" }), strategyCards);

    const sim = el("details", { class: "group" },
      el("summary", { text: "Simulation" }),
      el("div", { class: "row cols-2" },
        numField("n_runs", "Runs per strategy", { min: 100, max: defaults.limits.max_runs, step: 1, int: true }),
        numField("seed", "Random seed", { min: 0, max: 4294967295, step: 1, int: true })));

    els.fields.replaceChildren(program, risk, crews, strategies, sim);

    for (const input of els.fields.querySelectorAll("input[data-path]")) {
      const v = getPath(model, input.dataset.path);
      if (input.dataset.text) input.value = v ?? "";
      else input.value = v == null ? 0 : +(v * Number(input.dataset.scale)).toFixed(6);
    }
  }

  function readForm() {
    const out = structuredClone(model);
    let ok = true;
    for (const input of els.fields.querySelectorAll("input[data-path]")) {
      input.classList.remove("invalid");
      let value;
      if (input.dataset.text) {
        value = input.value.trim();
        if (!value) ok = markInvalid(input);
      } else {
        value = input.valueAsNumber;
        if (!Number.isFinite(value) || !input.checkValidity() ||
            (input.dataset.int && !Number.isInteger(value))) {
          ok = markInvalid(input);
        }
        value = value / Number(input.dataset.scale);
      }
      setPath(out, input.dataset.path, value);
    }
    const trios = ["delivery_slip_days", "duration_risk", ...out.strategies.map((_, i) => `strategies.${i}.handoff_hours`)];
    for (const path of trios) {
      const [lo, mode, hi] = getPath(out, path);
      if (!(lo <= mode && mode <= hi)) {
        for (let i = 0; i < 3; i++) markInvalid(els.fields.querySelector(`[data-path="${path}.${i}"]`));
        ok = false;
      }
    }
    return ok ? out : null;
  }

  function markInvalid(input) {
    input.classList.add("invalid");
    return false;
  }

  // ---------- share link ----------
  const b64url = {
    encode: (obj) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(obj))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    decode: (s) => JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)))),
  };

  function inputsFromHash() {
    const m = location.hash.match(/^#s=([A-Za-z0-9_-]+)$/);
    if (!m) return null;
    try {
      const obj = b64url.decode(m[1]);
      const keys = Object.keys(defaults.inputs);
      if (!obj || typeof obj !== "object" || !keys.every((k) => k in obj) || !Array.isArray(obj.strategies)) return null;
      return obj;
    } catch { return null; }
  }

  function writeHash(inputs) {
    const same = JSON.stringify(inputs) === JSON.stringify(defaults.inputs);
    const url = same ? location.pathname : `${location.pathname}#s=${b64url.encode(inputs)}`;
    history.replaceState(null, "", url);
  }

  // ---------- run ----------
  function formatError(body) {
    if (typeof body?.detail === "string") return body.detail;
    if (Array.isArray(body?.detail)) {
      return body.detail.map((d) => {
        const where = (d.loc || []).slice(1).join(" › ");
        return where ? `${where}: ${d.msg}` : d.msg;
      }).join("\n");
    }
    return "The simulation failed. Check the inputs and try again.";
  }

  function showError(msg) {
    els.error.textContent = msg;
    els.error.hidden = false;
  }

  async function run() {
    clearTimeout(debounce);
    const inputs = readForm();
    if (!inputs) {
      showError("Some inputs are out of range. Fix the highlighted fields (each Min ≤ Likely ≤ Max).");
      return;
    }
    inflight?.abort();
    const ctl = new AbortController();
    inflight = ctl;
    els.results.classList.add("loading");
    els.runBtn.disabled = true;
    try {
      const res = await fetch("/api/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inputs),
        signal: ctl.signal,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(formatError(body));
      last = body;
      els.error.hidden = true;
      writeHash(inputs);
      render();
    } catch (err) {
      if (err.name === "AbortError") return;
      showError(err.message || String(err));
    } finally {
      if (inflight === ctl) {
        inflight = null;
        els.results.classList.remove("loading");
        els.runBtn.disabled = false;
      }
    }
  }

  // ---------- render ----------
  function render() {
    if (!last) return;
    const r = last;
    const bar = pct(r.min_on_time);
    els.meta.textContent =
      `${r.n_tools} tools · final delivery in week ${r.last_delivery_week} · commitment: every tool qualified by week ${wk(r.target_weeks)} · ` +
      `${r.n_runs.toLocaleString()} runs per strategy · ${r.elapsed_ms.toLocaleString()} ms`;

    renderRecommendation(r, bar);
    renderCards(r, bar);
    renderLegends(r);
    renderCharts(r);
    renderLevers(r);
    renderTable(r);
  }

  function renderRecommendation(r, bar) {
    const rec = r.strategies.find((s) => s.key === r.recommended);
    const base = r.strategies.find((s) => s.key === r.baseline_key);
    const meets = rec.on_time_prob >= r.min_on_time;
    let title, text;
    if (meets) {
      title = `Recommended: ${rec.label}`;
      const savings = rec.key !== base.key && rec.savings_vs_first > 0
        ? `, ${pct(rec.savings_vs_first, 1)} below ${base.label.toLowerCase()}` : "";
      text = `The cheapest strategy with at least a ${bar} chance of finishing by week ${wk(r.target_weeks)}. ` +
        `P50 cost ${money(rec.p50_cost_per_tool)} per tool${savings}, with a ${pct(rec.on_time_prob)} chance of finishing on time.`;
    } else {
      title = `No strategy reaches ${bar} on-time confidence`;
      text = `The most reliable is ${rec.label}, at ${pct(rec.on_time_prob)}. ` +
        `Try more crews, shorter handoffs, a longer buffer, or a lower confidence bar.`;
    }
    els.recommend.className = `recommend card${meets ? "" : " warn"}`;
    els.recommend.replaceChildren(
      icon(meets ? ICON_OK : ICON_WARN, `icon status ${meets ? "good" : "bad"}`),
      el("div", {}, el("h2", { text: title }), el("p", { text })));
    els.recommend.hidden = false;
  }

  function renderCards(r, bar) {
    const base = r.strategies.find((s) => s.key === r.baseline_key);
    els.cards.replaceChildren(...r.strategies.map((s, i) => {
      const meets = s.on_time_prob >= r.min_on_time;
      let delta;
      if (s.key === base.key) delta = el("span", { class: "delta", text: "Baseline for cost comparison" });
      else {
        const better = s.savings_vs_first > 0;
        delta = el("span", { class: `delta ${better ? "good" : "bad"}`,
          text: `${better ? "▼" : "▲"} ${pct(Math.abs(s.savings_vs_first), 1)} ${better ? "below" : "above"} ${base.label.toLowerCase()}` });
      }
      return el("article", { class: `card stat-card${s.key === r.recommended && meets ? " best" : ""}` },
        el("div", { class: "name" },
          el("span", { class: "swatch", style: { background: color(i) } }),
          el("span", { text: s.label }),
          s.key === r.recommended && meets && el("span", { class: "badge-best", text: "Recommended" })),
        s.summary && el("p", { class: "desc", text: s.summary }),
        el("div", {},
          el("div", { class: "hero-value", text: money(s.p50_cost_per_tool) }),
          el("div", { class: "hero-label", text: `P50 cost per tool · ${moneyCompact(s.p50_total_cost)} program` }),
          delta),
        el("div", { class: "stat-row" },
          el("div", {},
            el("div", { class: "v", text: `${wk(s.p80_weeks)} wk` }),
            el("div", { class: "l", text: "P80 time to finish" })),
          el("div", {},
            el("div", { class: "v", text: pct(s.on_time_prob) }),
            el("div", { class: "l", text: "On-time chance" }),
            el("span", { class: `status ${meets ? "good" : "bad"}` },
              meets ? "✓" : "✕", meets ? ` Meets ${bar}` : ` Below ${bar}`))));
    }));
  }

  function renderLegends(r) {
    const items = (key) => r.strategies.map((s, i) =>
      el("li", {}, el("span", { class: key, style: { background: color(i) } }), s.label));
    $("#legend-dist").replaceChildren(...items("line-key"),
      el("li", {}, el("span", { class: "dash-key" }), `Target, week ${wk(r.target_weeks)}`));
    $("#legend-tradeoff").replaceChildren(...items("swatch"));
    $("#legend-util").replaceChildren(...items("swatch"));
  }

  // ---------- charts ----------
  const targetLine = {
    id: "targetLine",
    afterDatasetsDraw(chart, _args, opts) {
      if (opts.x == null) return;
      const { ctx, chartArea: a, scales: { x } } = chart;
      const px = x.getPixelForValue(opts.x);
      if (px < a.left || px > a.right) return;
      ctx.save();
      ctx.strokeStyle = css("--muted");
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
      ctx.setLineDash([]);
      if (opts.label) {
        ctx.font = `12px ${css("--font")}`;
        const w = ctx.measureText(opts.label).width;
        const left = px + 8 + w > a.right;
        const tx = left ? px - 8 - w : px + 8;
        ctx.fillStyle = css("--surface");           // chip so curves don't run through the text
        ctx.fillRect(tx - 4, a.top + 3, w + 8, 18);
        ctx.fillStyle = css("--text-2");
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(opts.label, tx, a.top + 12);
      }
      ctx.restore();
    },
  };

  const crosshair = {
    id: "crosshair",
    afterDraw(chart, _args, opts) {
      if (!opts.enabled) return;
      const active = chart.tooltip?.getActiveElements?.() || [];
      if (!active.length) return;
      const { ctx, chartArea: a } = chart;
      const px = active[0].element.x;
      ctx.save();
      ctx.strokeStyle = css("--axis");
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
      ctx.restore();
    },
  };

  const pointLabels = {
    id: "pointLabels",
    afterDatasetsDraw(chart, _args, opts) {
      if (!opts.enabled) return;
      const { ctx, chartArea: a } = chart;
      ctx.save();
      ctx.font = `12px ${css("--font")}`;
      ctx.fillStyle = css("--text-2");
      ctx.textBaseline = "middle";
      chart.data.datasets.forEach((ds, i) => {
        const pt = chart.getDatasetMeta(i).data[0];
        if (!pt) return;
        const w = ctx.measureText(ds.label).width;
        const right = pt.x + 12 + w <= a.right;
        const tx = right ? pt.x + 12 : pt.x - 12 - w;
        ctx.fillStyle = css("--surface");           // chip so the target line doesn't cross the text
        ctx.fillRect(tx - 3, pt.y - 9, w + 6, 18);
        ctx.fillStyle = css("--text-2");
        ctx.textAlign = "left";
        ctx.fillText(ds.label, tx, pt.y);
      });
      ctx.restore();
    },
  };

  function baseOptions() {
    const grid = css("--grid"), axis = css("--axis"), muted = css("--muted");
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { top: 4, right: 8 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: css("--surface"),
          borderColor: css("--border"),
          borderWidth: 1,
          titleColor: css("--text-2"),
          titleFont: { weight: "500" },
          bodyColor: css("--text"),
          bodyFont: { weight: "600" },
          padding: 10,
          cornerRadius: 8,
          boxPadding: 6,
          usePointStyle: true,
          caretSize: 0,
        },
      },
      scales: {
        x: { grid: { color: grid, drawTicks: false }, border: { color: axis }, ticks: { color: muted, padding: 6 } },
        y: { grid: { color: grid, drawTicks: false }, border: { display: false }, ticks: { color: muted, padding: 8 } },
      },
    };
  }

  const lineKey = (ctx) => ({ pointStyle: "line", rotation: 0 });
  const lineColor = (ctx) => ({ borderColor: ctx.dataset.borderColor, backgroundColor: ctx.dataset.borderColor });

  function draw(id, config) {
    charts[id]?.destroy();
    charts[id] = new Chart(document.getElementById(id), config);
  }

  function renderCharts(r) {
    if (!window.Chart) return;
    Chart.defaults.font.family = css("--font");
    Chart.defaults.font.size = 12;
    Chart.defaults.color = css("--muted");
    drawDistribution(r);
    drawTradeoff(r);
    drawUtilization(r);
  }

  function drawDistribution(r) {
    const opts = baseOptions();
    const isCdf = view === "cdf";
    const xs = isCdf ? r.grid : r.hist_edges.slice(0, -1).map((e, j) => (e + r.hist_edges[j + 1]) / 2);
    const datasets = r.strategies.map((s, i) => {
      const c = color(i);
      const ys = isCdf ? s.cdf : s.hist;
      return {
        label: s.label,
        data: xs.map((x, j) => ({ x, y: ys[j] * 100 })),
        borderColor: c,
        backgroundColor: c + "1a",
        fill: !isCdf,
        borderWidth: 2,
        borderJoinStyle: "round",
        borderCapStyle: "round",
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBorderWidth: 2,
        pointHoverBorderColor: css("--surface"),
        pointHoverBackgroundColor: c,
        tension: isCdf ? 0 : 0.25,
      };
    });
    opts.interaction = { mode: "index", intersect: false };
    opts.scales.x.type = "linear";
    opts.scales.x.min = xs[0];
    opts.scales.x.max = xs[xs.length - 1];
    opts.scales.x.title = { display: true, text: "Weeks from first delivery", color: css("--text-2") };
    opts.scales.x.ticks.callback = (v) => (Number.isInteger(v * 2) ? v : "");
    opts.scales.y.min = 0;
    if (isCdf) opts.scales.y.max = 100;
    opts.scales.y.ticks.callback = (v) => v + "%";
    opts.scales.y.title = { display: true, text: isCdf ? "Runs finished" : "Share of runs", color: css("--text-2") };
    Object.assign(opts.plugins.tooltip, {
      callbacks: {
        title: (items) => `Week ${items[0].parsed.x.toFixed(2)}`,
        label: (c) => `${c.parsed.y.toFixed(1)}%  ${c.dataset.label}`,
        labelPointStyle: lineKey,
        labelColor: lineColor,
      },
    });
    opts.plugins.targetLine = { x: r.target_weeks, label: `Target ${wk(r.target_weeks)}` };
    opts.plugins.crosshair = { enabled: true };
    $("#dist-sub").textContent = isCdf
      ? "Share of simulated runs with every tool qualified by each week. Read each curve where it crosses the dashed target."
      : "How finish weeks spread across runs. A narrow peak left of the target means a reliable plan.";
    draw("chart-dist", { type: "line", data: { datasets }, options: opts, plugins: [targetLine, crosshair] });
  }

  function drawTradeoff(r) {
    const opts = baseOptions();
    const datasets = r.strategies.map((s, i) => ({
      label: s.label,
      data: [{ x: s.p80_weeks, y: s.p80_cost_per_tool }],
      backgroundColor: color(i),
      pointRadius: 6,
      pointHoverRadius: 8,
      pointHitRadius: 14,
      pointBorderColor: css("--surface"),
      pointBorderWidth: 2,
      pointHoverBorderColor: css("--surface"),
      pointHoverBorderWidth: 2,
    }));
    const xsAll = r.strategies.map((s) => s.p80_weeks).concat(r.target_weeks);
    const ysAll = r.strategies.map((s) => s.p80_cost_per_tool);
    const xr = Math.max(...xsAll) - Math.min(...xsAll) || 1;
    const yr = Math.max(...ysAll) - Math.min(...ysAll) || Math.max(...ysAll) * 0.05;
    opts.scales.x.type = "linear";
    opts.scales.x.bounds = "ticks";            // snap the axis ends to clean tick values
    opts.scales.y.bounds = "ticks";
    opts.scales.x.suggestedMin = Math.min(...xsAll) - xr * 0.25;
    opts.scales.x.suggestedMax = Math.max(...xsAll) + xr * 0.6;
    opts.scales.x.title = { display: true, text: "P80 weeks to finish", color: css("--text-2") };
    opts.scales.x.ticks.callback = (v) => (+v).toFixed(1);
    opts.scales.x.ticks.maxTicksLimit = 6;
    opts.scales.y.suggestedMin = Math.min(...ysAll) - yr * 0.3;
    opts.scales.y.suggestedMax = Math.max(...ysAll) + yr * 0.3;
    opts.scales.y.ticks.callback = (v) => moneyCompact(v);
    opts.scales.y.ticks.maxTicksLimit = 6;
    opts.scales.y.title = { display: true, text: "P80 cost per tool", color: css("--text-2") };
    opts.interaction = { mode: "nearest", intersect: true };
    Object.assign(opts.plugins.tooltip, {
      callbacks: {
        title: (items) => items[0].dataset.label,
        label: (c) => `${money(c.parsed.y)} per tool · ${c.parsed.x.toFixed(2)} wk`,
      },
    });
    opts.plugins.targetLine = { x: r.target_weeks, label: "Target" };
    opts.plugins.pointLabels = { enabled: true };
    draw("chart-tradeoff", { type: "scatter", data: { datasets }, options: opts, plugins: [targetLine, pointLabels] });
  }

  function drawUtilization(r) {
    const opts = baseOptions();
    const trades = defaults.reference.trades;
    const datasets = r.strategies.map((s, i) => ({
      label: s.label,
      data: trades.map((t) => (s.utilization[t] ?? 0) * 100),
      crews: trades.map((t) => s.crews[t]),
      backgroundColor: color(i),
      hoverBackgroundColor: color(i) + "cc",
      borderRadius: 4,
      borderSkipped: "start",
      maxBarThickness: 12,
      categoryPercentage: 0.78,
      barPercentage: 0.86,
    }));
    opts.indexAxis = "y";
    opts.scales.x.min = 0;
    opts.scales.x.max = 100;
    opts.scales.x.ticks.callback = (v) => v + "%";
    opts.scales.y.grid = { display: false };
    opts.scales.y.ticks.color = css("--text-2");
    opts.interaction = { mode: "index", axis: "y", intersect: false };
    Object.assign(opts.plugins.tooltip, {
      usePointStyle: false,
      callbacks: {
        label: (c) => `${c.parsed.x.toFixed(0)}%  ${c.dataset.label} · ${c.dataset.crews[c.dataIndex]} crews`,
      },
    });
    draw("chart-util", {
      type: "bar",
      data: { labels: trades.map((t) => TRADE_LABEL[t] || t), datasets },
      options: opts,
    });
  }

  // ---------- tables ----------
  function nameCell(s, i) {
    return el("td", {}, el("span", { class: "cell-name" },
      el("span", { class: "swatch", style: { background: color(i) } }), s.label));
  }

  function renderLevers(r) {
    const levers = Object.keys(LEVER_LABEL);
    const head = el("thead", {}, el("tr", {}, el("th", { text: "Strategy" }),
      levers.map((k) => el("th", { text: LEVER_LABEL[k] }))));
    const body = el("tbody", {}, r.strategies.map((s, i) => {
      const best = levers.slice(1).reduce((a, b) => (s.levers[b].on_time_prob > s.levers[a].on_time_prob ? b : a));
      return el("tr", {}, nameCell(s, i), levers.map((k) => {
        const v = s.levers[k];
        const isBest = k === best && v.on_time_prob > s.levers.baseline.on_time_prob + 0.005;
        return el("td", {},
          el("span", { class: isBest ? "best-lever" : "", text: `${pct(v.on_time_prob)} on time` }),
          el("span", { class: "sub-v", text: `P80 ${wk(v.p80_weeks)} wk` }));
      }));
    }));
    $("#levers-table").replaceChildren(head, body);
  }

  const COLUMNS = [
    ["Markup", (s) => pct(s.markup_pct / 100, 1)],
    ["P50 weeks", (s) => wk(s.p50_weeks)],
    ["P80 weeks", (s) => wk(s.p80_weeks)],
    ["On-time chance", (s) => pct(s.on_time_prob, 1)],
    ["P50 cost / tool", (s) => money(s.p50_cost_per_tool)],
    ["P80 cost / tool", (s) => money(s.p80_cost_per_tool)],
    ["vs. baseline", (s, r) => (s.key === r.baseline_key ? "—" : (s.savings_vs_first > 0 ? "−" : "+") + pct(Math.abs(s.savings_vs_first), 1))],
    ["Bottleneck", (s) => `${TRADE_LABEL[s.bottleneck] || s.bottleneck} ${pct(s.utilization[s.bottleneck])}`],
  ];

  function renderTable(r) {
    $("#table-sub").textContent =
      `${r.n_runs.toLocaleString()} runs per strategy. Planned direct labor ${money(r.direct_labor_per_tool)} per tool before markup.`;
    const head = el("thead", {}, el("tr", {}, el("th", { text: "Strategy" }), COLUMNS.map(([h]) => el("th", { text: h }))));
    const body = el("tbody", {}, r.strategies.map((s, i) =>
      el("tr", {}, nameCell(s, i), COLUMNS.map(([, f]) => el("td", { text: f(s, r) })))));
    $("#results-table").replaceChildren(head, body);
  }

  function renderTasks() {
    const ref = defaults.reference;
    const head = el("thead", {}, el("tr", {}, ["Task", "Trade", "Craft hours", "Crew size", "Burdened rate", "Starts after"]
      .map((h) => el("th", { text: h }))));
    const pretty = (n) => n.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
    const body = el("tbody", {}, ref.tasks.map((t) => el("tr", {},
      el("td", { text: pretty(t.name) }),
      el("td", { text: t.trade ? TRADE_LABEL[t.trade] : "Owner / OEM" }),
      el("td", { text: t.hours }),
      el("td", { text: t.trade ? ref.crew_size[t.trade] : "—" }),
      el("td", { text: t.trade ? `${money(ref.wages[t.trade] * (1 + ref.labor_burden))}/h` : "—" }),
      el("td", { text: t.after.length ? t.after.map(pretty).join(" + ") : "Delivery" }))));
    $("#tasks-table").replaceChildren(head, body);
  }

  // ---------- CSV ----------
  function downloadCsv() {
    if (!last) return;
    const header = ["strategy", "markup_pct", "p50_weeks", "p80_weeks", "on_time_prob", "p50_cost_per_tool",
      "p80_cost_per_tool", "savings_vs_baseline", "bottleneck_trade", "bottleneck_util",
      "on_time_plus_hookup_crews", "on_time_half_handoff"];
    const q = (v) => (typeof v === "string" ? `"${v.replace(/"/g, '""')}"` : v);
    const rows = last.strategies.map((s) => [
      s.label, s.markup_pct, s.p50_weeks.toFixed(2), s.p80_weeks.toFixed(2), s.on_time_prob.toFixed(3),
      Math.round(s.p50_cost_per_tool), Math.round(s.p80_cost_per_tool), s.savings_vs_first.toFixed(4),
      s.bottleneck, s.utilization[s.bottleneck].toFixed(3),
      s.levers.plus_hookup_crews.on_time_prob.toFixed(3), s.levers.half_handoff.on_time_prob.toFixed(3),
    ].map(q).join(","));
    const blob = new Blob([[header.join(","), ...rows].join("\n") + "\n"], { type: "text/csv" });
    const a = el("a", { href: URL.createObjectURL(blob), download: "strategy_summary.csv" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- theme ----------
  function currentTheme() {
    const stamped = document.documentElement.dataset.theme;
    if (stamped) return stamped;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("theme", theme); } catch { /* storage unavailable */ }
    render();
  }
  try {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  } catch { /* storage unavailable */ }
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => render());

  // ---------- wire up ----------
  els.form.addEventListener("submit", (e) => { e.preventDefault(); run(); });
  els.form.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(run, 450);
  });
  els.resetBtn.addEventListener("click", () => {
    buildForm(defaults.inputs);
    run();
  });
  els.csvBtn.addEventListener("click", downloadCsv);
  els.themeBtn.addEventListener("click", () => setTheme(currentTheme() === "dark" ? "light" : "dark"));
  els.shareBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      els.shareBtn.textContent = "Link copied";
    } catch {
      els.shareBtn.textContent = "Copy failed";
    }
    setTimeout(() => { els.shareBtn.textContent = "Copy link"; }, 1600);
  });
  for (const b of document.querySelectorAll(".seg button")) {
    b.addEventListener("click", () => {
      view = b.dataset.view;
      for (const o of document.querySelectorAll(".seg button")) o.setAttribute("aria-selected", String(o === b));
      if (last) drawDistribution(last);
    });
  }

  async function init() {
    try {
      const res = await fetch("/api/defaults");
      if (!res.ok) throw new Error(`Could not load defaults (HTTP ${res.status}).`);
      defaults = await res.json();
    } catch (err) {
      els.meta.textContent = "";
      showError(err.message || "Could not reach the simulation server.");
      return;
    }
    buildForm(inputsFromHash() || defaults.inputs);
    renderTasks();
    run();
  }

  init();
})();
