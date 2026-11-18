// A small SVG line chart: one y-axis, 2px lines with gaps where a value is
// missing, a legend for two or more series, and a crosshair with one tooltip
// listing every series. Charts in the same group share the crosshair.

const NS = "http://www.w3.org/2000/svg";
const HEIGHT = 208;
const MARGIN = { top: 10, right: 14, bottom: 26, left: 48 };

function svg(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function html(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function niceStep(span, target) {
  const raw = span / target;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
}

const formatTick = (value) => value.toLocaleString("en-US", { maximumFractionDigits: 2 });
const formatValue = (value) =>
  value.toLocaleString("en-US", { maximumFractionDigits: Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2 });

/** Charts that share an x-axis register here so hovering one moves them all. */
export function chartGroup() {
  const charts = [];
  return {
    add(chart) {
      charts.push(chart);
    },
    hover(index, source) {
      for (const chart of charts) chart.showAt(index, chart === source);
    },
    clear() {
      for (const chart of charts) chart.showAt(null, false);
    },
  };
}

/**
 * lineChart(container, {
 *   title, unit,
 *   x: seconds[], series: [{ name, color, values: (number|null)[] }],
 *   marks: [{ y, label }],          // optional horizontal reference lines
 *   group,                           // optional chartGroup()
 * })
 * `color` is a CSS colour or custom property reference such as "var(--series-1)".
 */
export function lineChart(container, { title, unit, x, series, marks = [], group }) {
  container.replaceChildren();
  const figure = html("figure", "chart");
  const caption = html("figcaption", "chart-caption");
  caption.append(html("span", "chart-title", title), html("span", "chart-unit", unit));
  figure.append(caption);

  if (series.length > 1) {
    const legend = html("div", "chart-legend");
    for (const line of series) {
      const item = html("span", "chart-legend-item");
      const key = html("span", "chart-key");
      key.style.background = line.color;
      item.append(key, html("span", "", line.name));
      legend.append(item);
    }
    figure.append(legend);
  }

  const plot = html("div", "chart-plot");
  const tip = html("div", "chart-tip");
  tip.hidden = true;
  figure.append(plot);
  container.append(figure);

  // y range: from zero when nothing is negative, otherwise symmetric about zero.
  let low = 0;
  let high = 0;
  for (const line of series) {
    for (const value of line.values) {
      if (value === null) continue;
      if (value < low) low = value;
      if (value > high) high = value;
    }
  }
  for (const mark of marks) high = Math.max(high, mark.y);
  const reach = Math.max(high, -low) || 1;
  const yStep = niceStep(low < 0 ? reach * 2 : reach, 4);
  const yMax = Math.ceil(reach / yStep) * yStep;
  const yMin = low < 0 ? -yMax : 0;
  const xMin = x[0];
  const xMax = x[x.length - 1];

  const chart = { showAt: () => {} };
  let width = 0;

  function draw() {
    width = Math.max(280, Math.floor(plot.clientWidth || 640));
    const innerWidth = width - MARGIN.left - MARGIN.right;
    const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
    const sx = (value) => MARGIN.left + ((value - xMin) / (xMax - xMin || 1)) * innerWidth;
    const sy = (value) => MARGIN.top + (1 - (value - yMin) / (yMax - yMin)) * innerHeight;

    const root = svg("svg", {
      width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, role: "img", tabindex: "0",
      "aria-label": `${title}, ${unit}, over ${formatValue(xMax - xMin)} seconds. `
        + "Use the left and right arrow keys to read values.",
    });

    // Horizontal gridlines and y tick labels.
    for (let value = yMin; value <= yMax + yStep / 1000; value += yStep) {
      const y = Math.round(sy(value)) + 0.5;
      root.append(svg("line", {
        x1: MARGIN.left, x2: width - MARGIN.right, y1: y, y2: y,
        class: Math.abs(value) < yStep / 1000 ? "chart-axis" : "chart-grid",
      }));
      const label = svg("text", { x: MARGIN.left - 8, y: y + 4, "text-anchor": "end", class: "chart-tick" });
      label.textContent = formatTick(value);
      root.append(label);
    }

    // x tick labels in seconds since the trigger.
    const xStep = niceStep(xMax - xMin, Math.max(3, Math.floor(innerWidth / 90)));
    for (let value = Math.ceil(xMin / xStep) * xStep; value <= xMax + xStep / 1000; value += xStep) {
      const label = svg("text", { x: sx(value), y: HEIGHT - 8, "text-anchor": "middle", class: "chart-tick" });
      label.textContent = `${formatTick(Math.abs(value) < xStep / 1000 ? 0 : value)} s`;
      root.append(label);
    }

    // Reference lines, labelled at the right-hand end.
    for (const mark of marks) {
      const y = Math.round(sy(mark.y)) + 0.5;
      root.append(svg("line", { x1: MARGIN.left, x2: width - MARGIN.right, y1: y, y2: y, class: "chart-mark" }));
      const label = svg("text", { x: width - MARGIN.right, y: y - 5, "text-anchor": "end", class: "chart-mark-label" });
      label.textContent = mark.label;
      root.append(label);
    }

    // The data: one path per series, broken wherever a value is missing.
    for (const line of series) {
      let d = "";
      let pen = false;
      line.values.forEach((value, i) => {
        if (value === null) {
          pen = false;
          return;
        }
        d += `${pen ? "L" : "M"}${sx(x[i]).toFixed(1)},${sy(value).toFixed(1)}`;
        pen = true;
      });
      const path = svg("path", { d, class: "chart-line" });
      path.style.stroke = line.color;
      root.append(path);
    }

    // Hover layer: crosshair, a dot per series, and the tooltip.
    const cross = svg("line", { y1: MARGIN.top, y2: HEIGHT - MARGIN.bottom, class: "chart-cross", visibility: "hidden" });
    root.append(cross);
    const dots = series.map((line) => {
      const dot = svg("circle", { r: 4, class: "chart-dot", visibility: "hidden" });
      dot.style.fill = line.color;
      root.append(dot);
      return dot;
    });
    const hit = svg("rect", {
      x: MARGIN.left, y: MARGIN.top, width: innerWidth, height: innerHeight, fill: "transparent",
    });
    root.append(hit);

    let current = null;
    const nearest = (clientX) => {
      const bounds = root.getBoundingClientRect();
      const value = xMin + ((clientX - bounds.left - MARGIN.left) / innerWidth) * (xMax - xMin);
      let lo = 0;
      let hi = x.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (x[mid] < value) lo = mid;
        else hi = mid;
      }
      return Math.abs(x[lo] - value) <= Math.abs(x[hi] - value) ? lo : hi;
    };

    chart.showAt = (index, withTip) => {
      current = index;
      if (index === null) {
        cross.setAttribute("visibility", "hidden");
        dots.forEach((dot) => dot.setAttribute("visibility", "hidden"));
        tip.hidden = true;
        return;
      }
      const px = sx(x[index]);
      cross.setAttribute("x1", px);
      cross.setAttribute("x2", px);
      cross.setAttribute("visibility", "visible");
      series.forEach((line, i) => {
        const value = line.values[index];
        dots[i].setAttribute("visibility", value === null ? "hidden" : "visible");
        if (value !== null) {
          dots[i].setAttribute("cx", px);
          dots[i].setAttribute("cy", sy(value));
        }
      });
      if (!withTip) {
        tip.hidden = true;
        return;
      }
      tip.replaceChildren(html("div", "chart-tip-time", `${x[index].toFixed(2)} s`));
      for (const line of series) {
        const row = html("div", "chart-tip-row");
        const key = html("span", "chart-key");
        key.style.background = line.color;
        const value = line.values[index];
        row.append(key, html("strong", "", value === null ? "no reading" : `${formatValue(value)} ${unit}`),
          html("span", "chart-tip-name", line.name));
        tip.append(row);
      }
      tip.hidden = false;
      const tipWidth = tip.offsetWidth;
      const left = px + 12 + tipWidth > width ? px - 12 - tipWidth : px + 12;
      tip.style.left = `${Math.max(0, left)}px`;
    };

    const hover = (index) => (group ? group.hover(index, chart) : chart.showAt(index, true));
    const clear = () => (group ? group.clear() : chart.showAt(null, false));
    hit.addEventListener("pointermove", (event) => hover(nearest(event.clientX)));
    hit.addEventListener("pointerdown", (event) => hover(nearest(event.clientX)));
    hit.addEventListener("pointerleave", clear);
    root.addEventListener("focus", () => hover(current ?? Math.floor(x.length / 2)));
    root.addEventListener("blur", clear);
    root.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const stride = (event.shiftKey ? 10 : 1) * (event.key === "ArrowLeft" ? -1 : 1);
      hover(Math.min(x.length - 1, Math.max(0, (current ?? 0) + stride)));
    });

    plot.replaceChildren(root, tip);
  }

  draw();
  if (group) group.add(chart);
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => {
      if (Math.floor(plot.clientWidth) !== width && plot.clientWidth > 0) draw();
    }).observe(plot);
  }
  return chart;
}
