// Speedreed: words are rendered by the server as <p class="word"> inside <div class="line">;
// this script reveals them one at a time. Everything here only toggles styles on existing
// elements (no HTML is ever built from strings).
//
// Keyboard shortcuts (not shown on the page, to keep the original look):
//   Space  pause / resume      Left arrow  back 10 lines      Home  start over

function findGetParameter(parameterName) {
    let result = null;
    let tmp = [];
    location.search
        .substr(1)
        .split("&")
        .forEach(function (item) {
            tmp = item.split("=");
            if (tmp[0] === parameterName) {
                try {
                    result = decodeURIComponent(tmp[1]);
                } catch (e) {
                    result = tmp[1];
                }
            }
        });
    return result;
}

function visify(word, idx) {
    word.style.display = "block";
    word.style.color = "rgb(" + word.innerText.length*15 + ",0," + 255*(idx%2) + ")";
}

function update() {
    timer = null;
    try { localStorage.setItem(file, String(lIdx)); } catch (e) { /* storage unavailable */ }
    window.scrollTo(0,document.body.scrollHeight);

    let wordsCol = lines[lIdx][1];
    const wordText = wordsCol[wIdx].innerText;

    let timeout = 150+wordText.length*10;
    if (wordText.endsWith(",") || wordText.endsWith(".")) {
        timeout += 50;
    }

    for (let l = 0; l < lIdx; l++) {
        lines[l][0].style.display = "none";
    }
    lines[lIdx][0].style.display = "flex";
    visify(wordsCol[wIdx], wIdx);
    wIdx++;
    if (wIdx >= wordsCol.length) {
        lIdx++;
        wIdx = 0;
        timeout += 200;
    }
    if (lIdx >= lines.length) {
        return;
    }
    if (!paused) timer = setTimeout(update,timeout);
}

// Jump to a line: hide everything from that line on, then carry on reading from there.
function jumpTo(line) {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    lIdx = Math.max(0, Math.min(line, lines.length - 1));
    wIdx = 0;
    for (let l = 0; l < lines.length; l++) {
        lines[l][0].style.display = l < lIdx ? "none" : "";
        if (l >= lIdx) {
            for (const w of lines[l][1]) {
                w.style.display = "";
            }
        }
    }
    paused = false;
    update();
}

let lIdx, wIdx, lines, timer = null, paused = false;
const file = findGetParameter("file");

window.onload = function() {
    lines = document.getElementsByClassName("line");
    if (lines.length > 0) {
        document.body.style.overflow = "hidden";

        lines = Array.from(lines).map((l) => [l, l.getElementsByClassName("word")]);
        lIdx = 0;
        wIdx = 0;

        // Only a plain non-negative integer (from the hash or localStorage) is accepted as a line number.
        const hash = window.location.hash.substr(1);
        let param = null;
        if (/^\d{1,9}$/.test(hash)) {
            param = hash;
        } else {
            try { param = localStorage.getItem(file); } catch (e) { param = null; }
        }
        if (param !== null && /^\d{1,9}$/.test(param) && parseInt(param, 10) < lines.length) {
            lIdx = parseInt(param, 10);
        }

        document.addEventListener("keydown", function (ev) {
            if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
            if (ev.key === " ") {
                ev.preventDefault();
                paused = !paused;
                if (paused) {
                    if (timer !== null) clearTimeout(timer);
                    timer = null;
                } else if (timer === null && lIdx < lines.length) {
                    update();
                }
            } else if (ev.key === "ArrowLeft") {
                jumpTo(Math.min(lIdx, lines.length - 1) - 10);
            } else if (ev.key === "Home") {
                jumpTo(0);
            }
        });

        update();
    }
};
