// Interactive periodic table. Built with DOM calls (no innerHTML, no inline styles)
// so it works under the site's strict Content-Security-Policy.
import { ELEMENTS } from "./elements.js";

const table = document.getElementById("periodic-table");
const legend = document.getElementById("legend");
const select = document.querySelector("#trend-selector select");

// matrix[y-1][x-1] = element
const matrix = [];
for (const sym in ELEMENTS) {
    const el = ELEMENTS[sym];
    (matrix[el.ypos - 1] ??= [])[el.xpos - 1] = el;
}

function span(text, className) {
    const s = document.createElement("span");
    if (className) s.className = className;
    s.textContent = String(text);
    return s;
}

// Touch screens: cells are far smaller than a fingertip, so a tap selects an element and shows it in a
// panel with a big "Open" button instead of jumping straight to its page (a mis-tap is then harmless).
const touch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
const picked = document.getElementById("picked");
let pickedCell = null;

function pick(td, el, a, trendValue) {
    if (pickedCell) pickedCell.classList.remove("picked");
    pickedCell = td;
    td.classList.add("picked");
    picked.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = el.symbol + " - " + el.name;
    const detail = document.createElement("span");
    const bits = ["atomic number " + el.number, Math.round(el.atomic_mass * 1000) / 1000 + " u", categoryOf(el).split("_").join(" ")];
    if (trendValue !== null && trendValue !== undefined) {       // a trend is selected: show its value too
        bits.push(select.selectedOptions[0].textContent + ": " + trendValue);
    }
    detail.textContent = bits.join(" \u00b7 ");
    const open = document.createElement("a");
    open.className = "open";
    open.href = a.href;
    open.textContent = "Open " + el.symbol + " \u2192";
    picked.append(title, detail, open);
    picked.hidden = false;
}

function cell(el, bottomText, trendValue, maxTrend) {
    const td = document.createElement("td");
    if (!el) return td;
    td.className = "element";

    const a = document.createElement("a");
    // symbol comes from our own data file, but encode it anyway
    a.href = "/projects/chemcalc/index.php?input=" + encodeURIComponent(el.symbol);
    a.append(span(el.number), document.createTextNode(el.symbol));
    if (bottomText !== null) a.append(span(bottomText, trendValue != null ? "trend" : ""));
    td.append(a);
    if (touch && picked) {
        a.addEventListener("click", (ev) => {
            ev.preventDefault();
            pick(td, el, a, trendValue);
        });
    }

    if (trendValue != null) {
        const r = 255 * trendValue / maxTrend;
        td.style.backgroundColor = `rgb(255, ${255 - r}, ${255 - r})`;
    } else if (trendValue === undefined) {
        const category = categoryOf(el);
        td.classList.add("category", category);
    }
    return td;
}

function categoryOf(el) {
    let c = el.category.split(" ").join("_");
    if (c.startsWith("unknown")) c = "unknown";
    return c;
}

function render(trendKey) {
    pickedCell = null;
    if (picked) { picked.hidden = true; picked.replaceChildren(); }
    table.replaceChildren();
    legend.replaceChildren();

    let maxTrend = null;
    if (trendKey) {
        for (const row of matrix) for (const el of row ?? []) {
            const v = el?.[trendKey];
            if (v != null && (maxTrend === null || v > maxTrend)) maxTrend = v;
        }
    }

    const categories = [];
    for (const row of matrix) {
        const tr = document.createElement("tr");
        for (let x = 0; x < (row?.length ?? 0); x++) {
            const el = row[x];
            if (!el) { tr.append(document.createElement("td")); continue; }
            if (trendKey) {
                const v = el[trendKey];
                tr.append(cell(el, v != null ? v : null, v != null ? v : null, maxTrend));
            } else {
                const mass = Math.round(el.atomic_mass * 1000) / 1000;
                const td = cell(el, mass, undefined, null);
                const c = categoryOf(el);
                if (!categories.includes(c)) categories.push(c);
                tr.append(td);
            }
        }
        table.append(tr);
    }

    for (const c of categories) {
        const d = document.createElement("div");
        d.className = c;
        d.textContent = c.split("_").join(" ");
        legend.append(d);
    }
}

select.addEventListener("change", () => render(select.value === "None" ? "" : select.value));
render("");
