import { PRESETS } from "./presets.js";
import * as wireworld from "./wireworld.js";

const presetSelect = document.getElementById("presetSelect");
const warningElem = document.getElementById("warningElem");

// location.hash is untrusted input: it is only ever compared against own keys of PRESETS
// and shown with textContent.
function currentPresetName() {
    let name;
    try {
        name = decodeURIComponent(window.location.hash.slice(1));
    } catch (e) {
        return null;
    }
    return Object.hasOwn(PRESETS, name) ? name : null;
}

function hashChange() {
    const name = currentPresetName();
    for (const a of presetSelect.querySelectorAll(".preset")) {
        a.style.color = a.dataset.preset === name ? "yellow" : "white";
    }

    if (name !== null) {
        wireworld.init(PRESETS[name]);
        warningElem.textContent = "";
    } else {
        wireworld.init();
        warningElem.textContent = "No preset specified";
    }
}

function loop() {
    requestAnimationFrame(loop);

    wireworld.loop();
}

function setup() {
    for (const name of Object.keys(PRESETS)) {
        const a = document.createElement("a");
        a.className = "preset";
        a.href = "#" + encodeURIComponent(name);
        a.dataset.preset = name;
        a.textContent = name;
        presetSelect.append(a);
    }

    wireworld.setup();
    hashChange();
    window.onhashchange = hashChange;


    requestAnimationFrame(loop);
}

setup();
