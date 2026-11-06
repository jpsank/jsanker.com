let counter = 0;
let loading = false;

// Function to request new items and render to the dom.
// The original fetched `load?c=<counter>` from its Flask API; here the (fictional) track list
// comes from tracks.js, and covers are generated in the browser.
const BATCH = 20;

function fetchItems(c) {
    return Promise.resolve(window.UMUSIC_TRACKS.slice(c, c + BATCH).map((t) => ({
        id: t.id,
        title: t.title + ' — ' + t.artist,
        image_url: window.UMusicCover(t)
    })));
}

function loadItems() {
    loading = true;
    fetchItems(counter).then((data) => {
        if (!data.length) {
            return;
        }
        for (let track of data) {
            // Clone the HTML template
            let templateClone = template.content.cloneNode(true);

            let trackElem = templateClone.querySelector(".track");
            trackElem.id = track['id'];
            trackElem.title = track['title'];
            let img = templateClone.querySelector("img");
            img.src = track['image_url'];
            img.alt = track['title'];

            // Append template to dom
            scroller.appendChild(templateClone);

            counter += 1;
        }
    }).then(() => {
        loading = false;
    });
}

let intersectionObserver = new IntersectionObserver(entries => {
    // If intersectionRatio is 0, the sentinel is out of view and we don't need to do anything
    if (entries[0].intersectionRatio <= 0) {
        return;
    }

    if (!loading) {
        loadItems();
    }
});

// Instruct the IntersectionObserver to watch the sentinel
intersectionObserver.observe(sentinel);


let mutationObserver = new MutationObserver(records => {
    setup();
    mutationObserver.disconnect();
});

// Instruct the MutationObserver to watch the scroller
mutationObserver.observe(scroller, { childList: true});
