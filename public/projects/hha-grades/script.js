// HHA Grades demo. Original script.js toggled each course's "Details" modal; the rest of this
// file builds the same course cards the Flask template rendered, from made-up data in grades.json.
// Nothing typed into the login form is read, sent, or stored.
(function () {
  'use strict';

  var data = null;

  function toggleModal(button) {
    var modal = button.parentElement.querySelector('.modal');
    modal.hidden = !modal.hidden;
  }

  function closeModal(button) {
    button.parentElement.hidden = true;
  }

  // ---- grade math ----------------------------------------------------------

  function round2(x) { return Math.round(x * 100) / 100; }

  function letterFor(avg) {
    return avg < 60 ? 'F' : avg < 70 ? 'D' : avg < 80 ? 'C' : avg < 90 ? 'B' : 'A';
  }

  // Per-category totals, then a weighted course average over categories that have graded work.
  function computeCourse(course) {
    var cats = course.categories.map(function (c) {
      return { name: c.name, weight: c.weight, earned: 0, possible: 0 };
    });
    var byName = {};
    cats.forEach(function (c) { byName[c.name] = c; });

    course.assignments.forEach(function (a) {
      var c = byName[a.category];
      if (!c) { return; }
      if (a.score !== null && a.score !== undefined) {
        c.earned += a.score;
        c.possible += a.possible;
      }
    });

    var weighted = 0, weightUsed = 0;
    cats.forEach(function (c) {
      c.pct = c.possible > 0 ? (c.earned / c.possible) * 100 : null;
      if (c.pct !== null) {
        weighted += c.pct * c.weight;
        weightUsed += c.weight;
      }
    });

    var avg = weightUsed > 0 ? round2(weighted / weightUsed) : null;
    return { categories: cats, average: avg, letter: avg === null ? null : letterFor(avg), weightUsed: weightUsed };
  }

  // ---- DOM helpers ----------------------------------------------------------

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined) { n.textContent = text; }
    return n;
  }

  function fmtPct(x) { return x === null ? '—' : x.toFixed(2) + '%'; }
  function fmtNum(x) { return String(Math.round(x * 100) / 100); }

  function fmtDate(iso) {
    var p = iso.split('-');
    return Number(p[1]) + '/' + Number(p[2]) + '/' + p[0];
  }

  function addRow(table, cells, header) {
    var tr = el('tr');
    cells.forEach(function (c) { tr.appendChild(el(header ? 'th' : 'td', c.cls || '', c.text)); });
    table.appendChild(tr);
  }

  // The original dropped the school's own grade table into div.content; this is a plain stand-in.
  function buildGrid(course, r) {
    var frag = document.createDocumentFragment();

    frag.appendChild(el('h4', '', 'Categories'));
    var t1 = el('table');
    addRow(t1, [
      { text: 'Category' }, { text: 'Weight', cls: 'num' }, { text: 'Points', cls: 'num' },
      { text: 'Percent', cls: 'num' }
    ], true);
    r.categories.forEach(function (c) {
      addRow(t1, [
        { text: c.name },
        { text: c.weight + '%', cls: 'num' },
        { text: c.possible > 0 ? fmtNum(c.earned) + ' / ' + fmtNum(c.possible) : '—', cls: 'num' },
        { text: fmtPct(c.pct), cls: 'num' }
      ]);
    });
    frag.appendChild(t1);

    frag.appendChild(el('h4', '', 'Assignments'));
    var t2 = el('table');
    addRow(t2, [
      { text: 'Due' }, { text: 'Assignment' }, { text: 'Category' },
      { text: 'Score', cls: 'num' }, { text: 'Percent', cls: 'num' }
    ], true);
    course.assignments.slice().sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; })
      .forEach(function (a) {
        var graded = a.score !== null && a.score !== undefined;
        addRow(t2, [
          { text: fmtDate(a.date) },
          { text: a.name },
          { text: a.category },
          { text: graded ? fmtNum(a.score) + ' / ' + fmtNum(a.possible) : 'not graded / ' + fmtNum(a.possible), cls: graded ? 'num' : 'num pending' },
          { text: graded ? fmtPct(a.score / a.possible * 100) : '—', cls: graded ? 'num' : 'num pending' }
        ]);
      });
    frag.appendChild(t2);
    return frag;
  }

  // ---- rendering (mirrors templates/index.html) ---------------------------------

  function renderCourses(section) {
    section.textContent = '';
    section.appendChild(el('p', 'demo-note',
      'Demo: the school portal this scraped no longer exists, so this uses made-up data (' +
      data.scholar + '). Nothing you type is sent.'));

    data.courses.forEach(function (course) {
      var r = computeCourse(course);
      var card = el('div', 'course');
      card.appendChild(el('p', 'name', course.name));
      var info = el('div', 'info');

      if (r.average !== null) {
        info.appendChild(el('p', 'score', r.average + '%'));
        info.appendChild(el('p', 'grade', r.letter));

        var bar = el('progress', r.letter);
        bar.setAttribute('value', String(r.average));
        bar.setAttribute('max', '100');
        info.appendChild(bar);

        var wrap = el('div');
        var details = el('button', 'details', 'Details');
        details.addEventListener('click', function () { toggleModal(details); });
        wrap.appendChild(details);

        var modal = el('div', 'modal');
        modal.hidden = true;
        var close = el('button', 'modal-close', '×');
        close.addEventListener('click', function () { closeModal(close); });
        modal.appendChild(close);
        var content = el('div', 'content');
        content.appendChild(buildGrid(course, r));
        modal.appendChild(content);
        wrap.appendChild(modal);
        info.appendChild(wrap);
      } else {
        info.appendChild(el('p', 'na', 'N/A'));
      }

      card.appendChild(info);
      section.appendChild(card);
    });
  }

  // ---- wiring ------------------------------------------------------------------

  var form = document.getElementById('login');
  var section = document.querySelector('section.courses');
  var logoutWrap = document.getElementById('logout-wrap');

  function show() {
    form.hidden = true;
    section.hidden = false;
    logoutWrap.hidden = false;
    renderCourses(section);
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    // Whatever was typed is discarded, never read.
    form.reset();
    if (data) { show(); return; }
    fetch('/projects/hha-grades/grades.json', { credentials: 'omit' })
      .then(function (res) {
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        return res.json();
      })
      .then(function (json) { data = json; show(); })
      .catch(function () {
        form.querySelector('p.message').textContent = 'Could not load the sample data. Try reloading the page.';
      });
  });

  document.getElementById('logout').addEventListener('click', function (ev) {
    ev.preventDefault();
    section.hidden = true;
    logoutWrap.hidden = true;
    form.hidden = false;
    form.querySelector('p.message').textContent = '';
  });
})();
