// Expand the Ask / Answer / Comment boxes on focus; collapse them again when
// focus leaves and every textarea is empty (same behaviour as the original).
(function () {
    'use strict';

    function focusOut(form) {
        var textAreas = form.getElementsByTagName('textarea');
        for (var i = 0; i < textAreas.length; i++) {
            if (textAreas[i].value !== '') {
                return;
            }
        }
        form.classList.remove('activated');
    }

    function focusIn(form) {
        form.classList.add('activated');
    }

    document.querySelectorAll('form.submit').forEach(function (form) {
        form.addEventListener('focusin', function () { focusIn(form); });
        form.addEventListener('focusout', function () { focusOut(form); });
    });
})();
