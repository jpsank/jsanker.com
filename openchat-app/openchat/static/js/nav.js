// Small enhancements; the site works without them (the menu just stays expanded on narrow screens).
(function () {
    var toggle = document.getElementById('nav-toggle');
    var menu = document.getElementById('nav-menu');
    if (toggle && menu) {
        toggle.addEventListener('click', function () {
            var open = menu.classList.toggle('in');
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
    }
    document.addEventListener('click', function (event) {
        var el = event.target.closest ? event.target.closest('[data-confirm]') : null;
        if (el && !window.confirm(el.getAttribute('data-confirm'))) {
            event.preventDefault();
        }
    });
})();
