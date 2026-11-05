'use strict';

// OpenChat client. Same structure and behaviour as the original script.js, hardened:
// all server data goes in via textContent / createElement (never innerHTML), ids are
// validated as integers before use in URLs, and there are no inline handlers.
(function () {
    const ledger = document.getElementById('ledger');
    const form = document.getElementById('form');
    const errorBox = document.getElementById('form-error');
    if (!ledger || !form) return;

    const PER_PAGE = parseInt(ledger.dataset.perPage, 10) || 50;
    const POLL_MS = 5000;
    const DATE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

    // The page number in the URL is 1-based; the API is 0-based.
    let current_page = 0;
    {
        const n = parseInt(new URLSearchParams(location.search).get('page') || '1', 10);
        if (Number.isSafeInteger(n) && n >= 1 && n <= 1000000) current_page = n - 1;
    }

    const rendered = new Set();
    let polling = false;

    function validId(v) {
        return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
    }

    function getTimePassed(time) {
        let time_passed = Math.max(0, (Date.now() - Date.parse(time)) / 1000);
        let units = 'seconds';
        if (time_passed > 60) {
            time_passed /= 60;
            units = 'minutes';

            if (time_passed > 60) {
                time_passed /= 60;
                units = 'hours';

                if (time_passed > 24) {
                    time_passed /= 24;
                    units = 'days';
                }
            }
        }
        time_passed = Math.round(time_passed);

        // if it's 1 hour, 1 minute, etc, take off the S
        if (time_passed === 1) {
            units = units.slice(0, -1);
        }
        return [time_passed, units];
    }

    function updateTimePassed(messageElem) {
        const post_date = messageElem.getAttribute('data-post-date');
        if (Number.isNaN(Date.parse(post_date))) return false;
        const [time_passed, units] = getTimePassed(post_date);
        const newText = `${time_passed} ${units} ago`;

        const time = messageElem.getElementsByClassName('t')[0];
        if (time && time.textContent !== newText) {
            time.textContent = newText;
            return true;
        }
        return false;
    }

    function updateTimePassedElems() {
        for (const elem of document.getElementsByClassName('message')) {
            updateTimePassed(elem);
        }
    }

    function firstMessageId() {
        const first = ledger.querySelector('.message');
        return first ? parseInt(first.id, 10) || 0 : 0;
    }

    function buildMessage(msg) {
        if (!msg || !validId(msg.id) || typeof msg.message !== 'string') return null;
        if (typeof msg.post_date !== 'string' || !DATE_RE.test(msg.post_date)) return null;

        const div = document.createElement('div');
        div.id = String(msg.id);
        div.setAttribute('data-post-date', msg.post_date.replace(' ', 'T') + 'Z'); // server sends UTC
        div.classList.add('message');

        const time = document.createElement('p');
        time.classList.add('t');
        div.appendChild(time);

        const message = document.createElement('p');
        message.classList.add('m');
        message.textContent = msg.message;
        div.appendChild(message);

        if (msg.has_attachment === 1) {
            const img = document.createElement('img');
            img.src = 'image.php?id=' + encodeURIComponent(String(msg.id));
            img.alt = 'Image attached to message ' + msg.id;
            img.loading = 'lazy';
            div.appendChild(img);
        }

        updateTimePassed(div);
        return div;
    }

    function addMessages(messages, top = false) {
        if (!Array.isArray(messages)) return;
        // The server returns newest first. When prepending, insert oldest first so order is preserved.
        const list = top ? messages.slice().reverse() : messages;
        const empty = ledger.querySelector('.empty');
        for (const msg of list) {
            if (msg && rendered.has(msg.id)) continue;
            const div = buildMessage(msg);
            if (!div) continue;
            rendered.add(msg.id);
            if (empty) empty.remove();

            if (top) {
                // adds the new div to the top of the ledger
                ledger.insertBefore(div, ledger.firstChild);
            } else {
                ledger.appendChild(div);
            }
        }
    }

    function pageLink(page, label) {
        const a = document.createElement('a');
        a.href = `?page=${page + 1}`;
        a.textContent = label;
        return a;
    }

    function addPagination(num_pages) {
        if (!Number.isSafeInteger(num_pages) || num_pages < 1) return;
        const div = document.createElement('div');
        div.classList.add('pages');

        const prev_page = current_page - 1;
        if (prev_page >= 0) {
            const prevDiv = document.createElement('div');
            prevDiv.appendChild(pageLink(prev_page, '<'));
            div.appendChild(prevDiv);
        }

        for (let i = current_page - 5; i < current_page + 6; i++) {
            if (i >= 0 && i < num_pages) {
                if (i === current_page) {
                    const currentDiv = document.createElement('div');
                    currentDiv.classList.add('current');
                    currentDiv.textContent = String(i + 1);
                    div.appendChild(currentDiv);
                } else {
                    const pageDiv = document.createElement('div');
                    pageDiv.classList.add(i < current_page ? 'previous' : 'next');
                    pageDiv.appendChild(pageLink(i, String(i + 1)));
                    div.appendChild(pageDiv);
                }
            }
        }

        const next_page = current_page + 1;
        if (next_page < num_pages) {
            const nextDiv = document.createElement('div');
            nextDiv.appendChild(pageLink(next_page, '>'));
            div.appendChild(nextDiv);
        }

        // adds the pagination to the bottom of the ledger
        ledger.appendChild(div);
    }

    async function getJson(url) {
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

    async function initialFetch() {
        try {
            const data = await getJson(`fetch.php?page=${current_page}&per_page=${PER_PAGE}`);
            addMessages(data.result, false);
            if (!ledger.querySelector('.message')) {
                const p = document.createElement('p');
                p.className = 'empty';
                p.textContent = current_page === 0 ? 'nothing here yet, say something' : 'no messages on this page';
                ledger.appendChild(p);
            }
            addPagination(data.metadata && data.metadata.num_pages);
        } catch (e) {
            const p = document.createElement('p');
            p.className = 'empty';
            p.textContent = 'could not load messages, try reloading';
            ledger.appendChild(p);
        }
    }

    // loops update fetcher every 5 seconds (page 1 only)
    async function fetchUpdates() {
        if (polling) return;
        polling = true;
        try {
            const data = await getJson(`fetch.php?last_id=${firstMessageId()}`);
            addMessages(data.result, true);
            updateTimePassedElems();
        } catch (e) {
            // transient; try again on the next tick
        } finally {
            polling = false;
        }
    }

    function showError(msg) {
        errorBox.textContent = msg;
        errorBox.hidden = !msg;
    }

    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        showError('');
        const submit = form.querySelector('input[type="submit"]');
        submit.disabled = true;
        try {
            const res = await fetch(form.getAttribute('action') || location.pathname, {
                method: 'POST',
                body: new FormData(form),
                headers: { Accept: 'application/json' },
                credentials: 'same-origin',
            });
            let body = null;
            try { body = await res.json(); } catch (e) { /* non-JSON error */ }
            if (!res.ok || !body || body.ok !== true) {
                showError((body && typeof body.error === 'string' && body.error) ||
                    (res.status === 429 ? 'You are posting too fast. Try again in a minute.' : 'Could not post your message.'));
                return;
            }
            // Clears all the form inputs
            form.reset();
            if (current_page === 0) {
                // Fetch updates including the new message from the db once it is sent, rather than
                // inserting it locally, so the order always matches the server.
                await fetchUpdates();
            } else {
                // Not on the first page: go home to see the latest messages.
                location.assign(location.pathname);
            }
        } catch (e) {
            showError('Network error. Try again.');
        } finally {
            submit.disabled = false;
        }
    });

    initialFetch();
    if (current_page === 0) {
        setInterval(() => { if (!document.hidden) fetchUpdates(); }, POLL_MS);
    }
    setInterval(updateTimePassedElems, 30000);
})();
