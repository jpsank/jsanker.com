// Blog + accounts, no build step. Posts and users live in Firebase (Cloud
// Firestore `blogs` collection + Firebase Auth); access control is firestore.rules.
//
// XSS rules for this file:
//   - post bodies only reach the page through renderMarkdown() (marked -> DOMPurify)
//   - everything else (author names, dates, errors, ids) goes through textContent
//     / text nodes via h(); there is no innerHTML anywhere in this file
//   - ids from the URL are validated against ID_RE before use

import { marked } from '/vendor/marked/marked.esm.js';
import DOMPurify from '/vendor/dompurify/purify.es.mjs';

const FIREBASE_BASE = 'https://www.gstatic.com/firebasejs/13.2.0/';
const MAX_CONTENT = 50000;   // firestore.rules: content.size() <= 50000
const MAX_NAME = 100;        // firestore.rules: authorName.size() <= 100
const PAGE_SIZE = 20;
const ID_RE = /^[A-Za-z0-9]{1,64}$/;
const RETURN_RE = /^\/blog\/\?(new|post=[A-Za-z0-9]{1,64}|edit=[A-Za-z0-9]{1,64})$/;

// ------------------------------------------------------------------ DOM ---

/** Tiny element builder. Strings become text nodes, never markup. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const link = (text, href) => h('a', { href }, text);
const SEP = () => document.createTextNode(' · ');

// ------------------------------------------------------------- markdown ---

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },          // no SVG, no MathML
  FORBID_TAGS: [
    'style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'optgroup',
    'fieldset', 'label', 'iframe', 'frame', 'frameset', 'object', 'embed', 'link',
    'meta', 'base', 'script', 'noscript', 'template', 'dialog',
  ],
  FORBID_ATTR: ['style', 'id', 'name', 'class', 'srcset', 'form', 'formaction'],
  ALLOW_DATA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
};

/** Markdown (untrusted) -> sanitised DocumentFragment in this document. */
function renderMarkdown(markdown) {
  const html = marked.parse(String(markdown), { gfm: true, breaks: false, async: false });
  const frag = DOMPurify.sanitize(html, PURIFY_CONFIG);   // inert fragment

  for (const a of frag.querySelectorAll('a')) {
    a.setAttribute('rel', 'noopener noreferrer nofollow');
    a.removeAttribute('target');
  }
  // The CSP only allows same-origin and data: images. Anything else would be a
  // broken image (and a tracking-pixel vector), so show it as a plain link.
  for (const img of frag.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    const alt = img.getAttribute('alt') || 'image';
    let local = false;
    let remote = null;
    try {
      const u = new URL(src, location.href);
      local = u.origin === location.origin || (u.protocol === 'data:' && /^data:image\//i.test(src));
      if (u.protocol === 'http:' || u.protocol === 'https:') remote = u.href;
    } catch { /* unparsable: drop it */ }
    if (local) {
      img.setAttribute('loading', 'lazy');
      img.setAttribute('referrerpolicy', 'no-referrer');
    } else if (remote) {
      const a = document.createElement('a');
      a.setAttribute('href', remote);
      a.setAttribute('rel', 'noopener noreferrer nofollow');
      a.textContent = '[image: ' + alt + ']';
      img.replaceWith(a);
    } else {
      img.replaceWith(document.createTextNode('[image: ' + alt + ']'));
    }
  }
  return document.importNode(frag, true);
}

/** Rendered markdown in a container; the one place post content enters the page. */
function markdownBlock(markdown, className = 'md') {
  const el = h('div', { class: className });
  el.replaceChildren(renderMarkdown(markdown));
  return el;
}

function previewOf(content) {
  const text = String(content).trim().split(/\r?\n/).slice(0, 8).join('\n');
  if (text.length <= 300 && text.length === String(content).trim().length) return text;
  let cut = text.slice(0, 300);
  const space = cut.lastIndexOf(' ');
  if (space > 200) cut = cut.slice(0, space);
  return cut.trimEnd() + '…';
}

function titleOf(content) {
  const first = String(content).split(/\r?\n/).find((l) => l.trim() !== '') || '';
  const t = first.replace(/^[#>\-*\s]+/, '').replace(/[*_`[\]]/g, '').trim();
  return t.length > 60 ? t.slice(0, 59) + '…' : t;
}

// ----------------------------------------------------------- state / UI ---

const root = document.getElementById('blog');
const nav = document.getElementById('blog-nav');

const S = {
  config: null,
  A: null, F: null, auth: null, db: null,   // firebase auth / firestore modules + instances
  user: null,
  dirty: false,                             // unsaved editor changes
  routeId: 0,
};

function setView(title, ...nodes) {
  document.title = (title ? title + ' — ' : '') + 'Blog — Julian Sanker';
  root.replaceChildren(...nodes);
}

function note(text, cls = 'muted') {
  return h('p', { class: cls }, text);
}

function errorBox() {
  return h('p', { class: 'error', role: 'alert' });
}

function showError(box, err) {
  box.textContent = typeof err === 'string' ? err : friendlyError(err);
}

function friendlyError(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  if (code) console.warn('blog error:', code);
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-login-credentials':
      return 'Incorrect email or password.';
    case 'auth/invalid-email': return 'That does not look like a valid email address.';
    case 'auth/email-already-in-use': return 'An account with that email already exists. Try signing in.';
    case 'auth/weak-password': return 'Choose a longer password (at least 8 characters).';
    case 'auth/too-many-requests': return 'Too many attempts. Wait a few minutes and try again.';
    case 'auth/network-request-failed':
    case 'unavailable': return 'Network problem. Check your connection and try again.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request': return 'Sign-in was cancelled.';
    case 'auth/popup-blocked': return 'Your browser blocked the sign-in popup. Allow popups for this site and try again.';
    case 'auth/account-exists-with-different-credential':
      return 'That email is already registered with a different sign-in method.';
    case 'auth/requires-recent-login': return 'Please sign in again and retry.';
    case 'auth/operation-not-allowed': return 'That sign-in method is not enabled.';
    case 'permission-denied': return 'You are not allowed to do that. Are you signed in as the author?';
    case 'failed-precondition': return 'This view needs a database index that has not been created yet.';
    case 'resource-exhausted': return 'The database quota was exceeded. Try again later.';
    case 'not-found': return 'That post no longer exists.';
    default: return 'Something went wrong. Please try again.';
  }
}

/** Run an async action with the button disabled; show failures in `box`. */
async function busy(button, box, action) {
  box.textContent = '';
  button.disabled = true;
  try {
    await action();
  } catch (err) {
    showError(box, err);
  } finally {
    button.disabled = false;
  }
}

// ------------------------------------------------------------- firebase ---

async function initFirebase(config) {
  const [app, A, F] = await Promise.all([
    import(FIREBASE_BASE + 'firebase-app.js'),
    import(FIREBASE_BASE + 'firebase-auth.js'),
    import(FIREBASE_BASE + 'firebase-firestore.js'),
  ]);
  const fbApp = app.initializeApp(config);
  // No popup resolver here, so the sign-in iframe/gapi are only loaded if
  // someone actually clicks "Sign in with Google" (see googleSignIn).
  S.auth = A.initializeAuth(fbApp, { persistence: [A.indexedDBLocalPersistence, A.browserLocalPersistence] });
  S.db = F.getFirestore(fbApp);
  S.A = A;
  S.F = F;
}

function authorLabel(user) {
  return (user && user.displayName && user.displayName.trim()) || null;
}

function renderNav() {
  const parts = [link('blog', '/blog/'), SEP(), link('new post', '/blog/?new'), SEP(), link('account', '/blog/?account')];
  if (S.user) {
    const out = h('button', { type: 'button', class: 'linklike' }, 'sign out');
    out.addEventListener('click', async () => {
      try {
        await S.A.signOut(S.auth);
      } catch (err) {
        console.warn('sign out failed');
      }
      go('/blog/');
    });
    parts.push(SEP(), out);
  }
  nav.replaceChildren(...parts);
}

// -------------------------------------------------------------- helpers ---

function toDate(ts) {
  return ts && typeof ts.toDate === 'function' ? ts.toDate() : null;
}
const fmtDate = (d) => d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const sameDay = (a, b) => a.toDateString() === b.toDateString();

function timeEl(d) {
  return h('time', { datetime: d.toISOString() }, fmtDate(d));
}

function authorLink(uid, name) {
  const label = (typeof name === 'string' && name.trim()) || 'anonymous';
  return typeof uid === 'string' && ID_RE.test(uid)
    ? link(label, '/blog/?author=' + encodeURIComponent(uid))
    : label;
}

function metaLine(post) {
  const created = toDate(post.dateCreated);
  const updated = toDate(post.dateUpdated);
  const bits = [];
  if (created) bits.push(timeEl(created));
  if (created && updated && !sameDay(created, updated)) {
    bits.push(' (updated ', timeEl(updated), ')');
  }
  bits.push(' · by ', authorLink(post.authorId, post.authorName));
  return h('p', { class: 'meta muted small' }, bits);
}

function postData(snap) {
  return snap.data({ serverTimestamps: 'estimate' });
}

function twoStepDelete(onDelete, box) {
  const del = h('button', { type: 'button', class: 'linklike danger' }, 'Delete');
  const yes = h('button', { type: 'button', class: 'danger-solid' }, 'Yes, delete it');
  const no = h('button', { type: 'button' }, 'Keep it');
  const ask = h('span', { class: 'confirm', hidden: true }, 'Delete this post for good? ', yes, ' ', no);
  del.addEventListener('click', () => { del.hidden = true; ask.hidden = false; no.focus(); });
  no.addEventListener('click', () => { ask.hidden = true; del.hidden = false; del.focus(); });
  yes.addEventListener('click', () => busy(yes, box, async () => {
    await onDelete();
  }));
  return h('span', { class: 'delete-wrap' }, del, ask);
}

function signInPrompt(message, ret) {
  const href = '/blog/?account' + (ret && RETURN_RE.test(ret) ? '&ret=' + encodeURIComponent(ret) : '');
  return h('p', {}, message, ' ', link('Sign in or create an account', href), '.');
}

// ---------------------------------------------------------------- views ---

async function listView(authorId, rid) {
  const { F, db } = S;
  const heading = h('h1', {}, authorId ? 'Posts by author' : 'Blog');
  const list = h('div', { class: 'posts' });
  const more = h('p', {}, '');
  const box = errorBox();
  const status = note('Loading posts…');

  const intro = authorId
    ? h('p', { class: 'muted' }, link('← all posts', '/blog/'))
    : h('p', {}, 'This is where I write about things, and you can too. ',
        S.user ? link('Write a post', '/blog/?new') : link('Sign up for an account', '/blog/?account=signup'),
        S.user ? '.' : ' to start writing. Posts are Markdown, and are stored in Cloud Firestore.');

  setView(authorId ? 'Posts' : '', heading, intro, box, list, status, more);

  let cursor = null;
  let named = false;

  async function loadPage() {
    const constraints = [];
    if (authorId) constraints.push(F.where('authorId', '==', authorId));
    constraints.push(F.orderBy('dateUpdated', 'desc'));
    if (cursor) constraints.push(F.startAfter(cursor));
    constraints.push(F.limit(PAGE_SIZE));
    const snap = await F.getDocs(F.query(F.collection(db, 'blogs'), ...constraints));
    if (rid !== S.routeId) return;

    for (const d of snap.docs) {
      const post = postData(d);
      if (authorId && !named && post.authorName) {
        heading.textContent = 'Posts by ' + post.authorName;
        named = true;
      }
      list.append(h('article', { class: 'post' },
        metaLine(post),
        markdownBlock(previewOf(post.content), 'md preview'),
        h('p', { class: 'small' }, link('Read post →', '/blog/?post=' + encodeURIComponent(d.id))),
      ));
    }
    cursor = snap.docs.length ? snap.docs[snap.docs.length - 1] : cursor;
    status.textContent = '';
    if (!list.children.length) status.textContent = 'No posts yet.';

    more.replaceChildren();
    if (snap.docs.length === PAGE_SIZE) {
      const btn = h('button', { type: 'button' }, 'Older posts');
      btn.addEventListener('click', () => busy(btn, box, loadPage));
      more.append(btn);
    }
  }

  try {
    await loadPage();
  } catch (err) {
    if (rid !== S.routeId) return;
    status.textContent = '';
    showError(box, err);
  }
}

async function postView(id, rid) {
  const status = note('Loading post…');
  setView('', status);
  let snap;
  try {
    snap = await S.F.getDoc(S.F.doc(S.db, 'blogs', id));
  } catch (err) {
    if (rid !== S.routeId) return;
    const box = errorBox();
    showError(box, err);
    setView('', box, link('← all posts', '/blog/'));
    return;
  }
  if (rid !== S.routeId) return;
  if (!snap.exists()) {
    setView('Not found', h('h1', {}, 'Post not found'), h('p', {}, 'It may have been deleted. ', link('← all posts', '/blog/')));
    return;
  }
  const post = postData(snap);
  const box = errorBox();
  const actions = h('p', { class: 'actions small' });
  if (S.user && S.user.uid === post.authorId) {
    actions.append(
      link('Edit', '/blog/?edit=' + encodeURIComponent(id)), ' · ',
      twoStepDelete(async () => {
        await S.F.deleteDoc(S.F.doc(S.db, 'blogs', id));
        go('/blog/');
      }, box),
    );
  }
  setView(titleOf(post.content),
    link('← all posts', '/blog/'),
    metaLine(post),
    markdownBlock(post.content, 'md post-body'),
    actions,
    box,
  );
}

async function editorView(id, rid) {
  if (!S.user) {
    setView('Sign in', h('h1', {}, id ? 'Edit post' : 'New post'),
      signInPrompt('You need to be signed in to write.', id ? `/blog/?edit=${id}` : '/blog/?new'));
    return;
  }

  let existing = null;
  if (id) {
    setView('Edit post', note('Loading post…'));
    try {
      const snap = await S.F.getDoc(S.F.doc(S.db, 'blogs', id));
      if (rid !== S.routeId) return;
      if (!snap.exists()) {
        setView('Not found', h('h1', {}, 'Post not found'), link('← all posts', '/blog/'));
        return;
      }
      existing = postData(snap);
    } catch (err) {
      if (rid !== S.routeId) return;
      const box = errorBox();
      showError(box, err);
      setView('Edit post', box);
      return;
    }
    if (existing.authorId !== S.user.uid) {
      setView('Edit post', h('h1', {}, 'Edit post'),
        h('p', {}, 'Only the author can edit this post. ', link('Back to the post', '/blog/?post=' + encodeURIComponent(id))));
      return;
    }
  }

  const area = h('textarea', {
    id: 'content', rows: '18', spellcheck: 'true', autocomplete: 'off',
    'aria-describedby': 'counter',
  });
  area.value = existing ? existing.content : '# Hello World\n\nThis is a blog post.';
  const counter = h('span', { id: 'counter', class: 'muted small' });
  const preview = h('div', { class: 'md preview-pane', 'aria-label': 'Preview' });
  const box = errorBox();
  const status = h('span', { class: 'muted small', role: 'status' });
  const save = h('button', { type: 'submit' }, id ? 'Save changes' : 'Publish');
  const actions = h('div', { class: 'editor-actions' }, save, ' ', status);
  const form = h('form', { class: 'stack' },
    h('label', { for: 'content' }, 'Post (Markdown)'),
    area,
    counter,
    actions,
    box,
  );

  function refresh() {
    const n = area.value.length;
    counter.textContent = `${n.toLocaleString()} / ${MAX_CONTENT.toLocaleString()} characters`;
    counter.classList.toggle('error', n > MAX_CONTENT);
    preview.replaceChildren(renderMarkdown(area.value));
  }
  let timer = 0;
  area.addEventListener('input', () => {
    S.dirty = true;
    status.textContent = '';
    clearTimeout(timer);
    timer = setTimeout(refresh, 120);
  });
  refresh();

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    busy(save, box, async () => {
      const content = area.value.trimEnd();
      if (!content.trim()) throw 'A post cannot be empty.';
      if (content.length > MAX_CONTENT) throw `That is too long: the limit is ${MAX_CONTENT.toLocaleString()} characters.`;
      const { F, db } = S;
      if (id) {
        // firestore.rules: an update may only change content + dateUpdated.
        await F.updateDoc(F.doc(db, 'blogs', id), { content, dateUpdated: F.serverTimestamp() });
        S.dirty = false;
        status.replaceChildren('Saved. ', link('View post', '/blog/?post=' + encodeURIComponent(id)));
      } else {
        const name = authorLabel(S.user);
        const ref = await F.addDoc(F.collection(db, 'blogs'), {
          authorId: S.user.uid,
          authorName: name ? name.slice(0, MAX_NAME) : null,
          content,
          dateCreated: F.serverTimestamp(),
          dateUpdated: F.serverTimestamp(),
        });
        S.dirty = false;
        go('/blog/?post=' + encodeURIComponent(ref.id));
      }
    });
  });

  const kids = [
    h('h1', {}, id ? 'Edit post' : 'New post'),
    h('p', { class: 'muted small' }, 'Write in Markdown. The preview below shows what readers will see. ',
      'Images from other sites are shown as links.'),
    form,
    h('h2', {}, 'Preview'),
    preview,
  ];
  if (id) {
    const delBox = errorBox();
    kids.push(h('p', { class: 'small' },
      link('Cancel', '/blog/?post=' + encodeURIComponent(id)), ' · ',
      twoStepDelete(async () => {
        await S.F.deleteDoc(S.F.doc(S.db, 'blogs', id));
        S.dirty = false;
        go('/blog/');
      }, delBox)), delBox);
  }
  setView(id ? 'Edit post' : 'New post', ...kids);
  area.focus();
}

// ------------------------------------------------------------- accounts ---

function field(labelText, type, name, extra = {}) {
  const input = h('input', { type, name, required: true, ...extra });
  return { input, label: h('label', {}, labelText, input) };
}

function returnTarget() {
  const ret = new URLSearchParams(location.search).get('ret');
  return ret && RETURN_RE.test(ret) ? ret : null;
}

async function googleSignIn() {
  const { A, auth } = S;
  // The popup resolver is passed per call so its iframe/gapi load only on demand.
  await A.signInWithPopup(auth, new A.GoogleAuthProvider(), A.browserPopupRedirectResolver);
  go(returnTarget() || '/blog/?account');
}

function signInView() {
  const email = field('Email', 'email', 'email', { autocomplete: 'username' });
  const pass = field('Password', 'password', 'password', { autocomplete: 'current-password' });
  const box = errorBox();
  const submit = h('button', { type: 'submit' }, 'Sign in');
  const form = h('form', { class: 'stack' }, email.label, pass.label, h('p', {}, submit), box);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    busy(submit, box, async () => {
      await S.A.signInWithEmailAndPassword(S.auth, email.input.value.trim(), pass.input.value);
      go(returnTarget() || '/blog/?account');
    });
  });
  const google = h('button', { type: 'button' }, 'Sign in with Google');
  google.addEventListener('click', () => busy(google, box, googleSignIn));
  const ret = returnTarget();
  const suffix = ret ? '&ret=' + encodeURIComponent(ret) : '';
  setView('Sign in',
    h('h1', {}, 'Sign in'),
    form,
    h('p', {}, google),
    h('p', { class: 'small' },
      link('Forgot your password?', '/blog/?account=reset'), ' · ',
      link('Create an account', '/blog/?account=signup' + suffix)),
  );
}

function signUpView() {
  const name = field('Display name (shown on your posts)', 'text', 'name', { maxlength: MAX_NAME, autocomplete: 'nickname' });
  const email = field('Email', 'email', 'email', { autocomplete: 'email' });
  const pass = field('Password (at least 8 characters)', 'password', 'password', { autocomplete: 'new-password', minlength: 8 });
  const confirm = field('Confirm password', 'password', 'confirm', { autocomplete: 'new-password' });
  const box = errorBox();
  const submit = h('button', { type: 'submit' }, 'Create account');
  const form = h('form', { class: 'stack' }, name.label, email.label, pass.label, confirm.label, h('p', {}, submit), box);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    busy(submit, box, async () => {
      const displayName = name.input.value.trim();
      if (!displayName) throw 'Please enter a display name.';
      if (displayName.length > MAX_NAME) throw `Keep the display name under ${MAX_NAME} characters.`;
      if (pass.input.value.length < 8) throw 'Choose a longer password (at least 8 characters).';
      if (pass.input.value !== confirm.input.value) throw 'The passwords do not match.';
      const { A, auth } = S;
      const cred = await A.createUserWithEmailAndPassword(auth, email.input.value.trim(), pass.input.value);
      await A.updateProfile(cred.user, { displayName });
      try { await A.sendEmailVerification(cred.user); } catch { /* non-fatal */ }
      renderNav();
      go(returnTarget() || '/blog/?account');
    });
  });
  setView('Create account',
    h('h1', {}, 'Create an account'),
    h('p', { class: 'muted' }, 'Accounts let you write posts and edit or delete your own.'),
    form,
    h('p', { class: 'small' }, 'Already have one? ', link('Sign in', '/blog/?account'), '.'),
  );
}

function resetView() {
  const email = field('Email', 'email', 'email', { autocomplete: 'email' });
  const box = errorBox();
  const status = h('p', { class: 'ok', role: 'status' });
  const submit = h('button', { type: 'submit' }, 'Send reset link');
  const form = h('form', { class: 'stack' }, email.label, h('p', {}, submit), box, status);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    status.textContent = '';
    busy(submit, box, async () => {
      try {
        await S.A.sendPasswordResetEmail(S.auth, email.input.value.trim());
      } catch (err) {
        // Don't reveal whether an address has an account.
        if (!err || err.code !== 'auth/user-not-found') throw err;
      }
      status.textContent = 'If an account exists for that address, a reset link is on its way.';
    });
  });
  setView('Reset password',
    h('h1', {}, 'Reset your password'),
    h('p', { class: 'muted' }, 'Enter your email and we will send you a link to choose a new password.'),
    form,
    h('p', { class: 'small' }, link('Back to sign in', '/blog/?account')),
  );
}

function profileView() {
  const user = S.user;
  const verified = user.emailVerified;
  const box = errorBox();
  const status = h('p', { class: 'ok', role: 'status' });

  const name = field('Display name', 'text', 'name', { maxlength: MAX_NAME, autocomplete: 'nickname' });
  name.input.value = user.displayName || '';
  const update = h('button', { type: 'submit' }, 'Update name');
  const form = h('form', { class: 'stack' }, name.label, h('p', {}, update), box, status);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    status.textContent = '';
    busy(update, box, async () => {
      const displayName = name.input.value.trim();
      if (!displayName) throw 'Please enter a display name.';
      if (displayName.length > MAX_NAME) throw `Keep the display name under ${MAX_NAME} characters.`;
      await S.A.updateProfile(S.user, { displayName });
      status.textContent = 'Saved. New posts will use this name.';
    });
  });

  const kids = [
    h('h1', {}, 'Your account'),
    h('p', {}, 'Signed in as ', h('strong', {}, user.email || 'a Google account'), '. ',
      h('span', { class: verified ? 'ok' : 'muted' }, verified ? 'Email verified.' : 'Email not verified.')),
  ];
  if (!verified && user.email) {
    const resend = h('button', { type: 'button' }, 'Resend verification email');
    const vbox = errorBox();
    const vstatus = h('p', { class: 'ok', role: 'status' });
    resend.addEventListener('click', () => busy(resend, vbox, async () => {
      await S.A.sendEmailVerification(S.user);
      vstatus.textContent = 'Verification email sent.';
    }));
    kids.push(h('p', {}, resend), vbox, vstatus);
  }
  kids.push(
    form,
    h('p', { class: 'muted small' }, 'Existing posts keep the name they were published under.'),
    h('p', {}, link('Your posts', '/blog/?author=' + encodeURIComponent(user.uid)), ' · ', link('Write a post', '/blog/?new')),
  );
  setView('Account', ...kids);
}

function accountView() {
  if (S.user) {
    const ret = returnTarget();
    if (ret) { go(ret, true); return; }
    profileView();
    return;
  }
  const mode = new URLSearchParams(location.search).get('account');
  if (mode === 'signup') signUpView();
  else if (mode === 'reset') resetView();
  else signInView();
}

// --------------------------------------------------------------- router ---

function notFound() {
  setView('Not found', h('h1', {}, 'Not found'), h('p', {}, link('← all posts', '/blog/')));
}

async function route() {
  const rid = ++S.routeId;
  S.dirty = false;
  const p = new URLSearchParams(location.search);
  try {
    if (p.has('post')) {
      const id = p.get('post');
      return ID_RE.test(id) ? await postView(id, rid) : notFound();
    }
    if (p.has('edit')) {
      const id = p.get('edit');
      return ID_RE.test(id) ? await editorView(id, rid) : notFound();
    }
    if (p.has('new')) return await editorView(null, rid);
    if (p.has('author')) {
      const id = p.get('author');
      return ID_RE.test(id) ? await listView(id, rid) : notFound();
    }
    if (p.has('account')) return accountView();
    return await listView(null, rid);
  } catch (err) {
    if (rid !== S.routeId) return;
    console.warn('route failed');
    const box = errorBox();
    showError(box, err);
    setView('Error', box);
  }
}

function go(url, replace = false) {
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  window.scrollTo(0, 0);
  route();
}

function handleLinkClick(ev) {
  if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
  const a = ev.target instanceof Element ? ev.target.closest('a[href]') : null;
  if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
  if (a.origin !== location.origin || a.pathname !== '/blog/') return;
  if (S.dirty) return;            // let the browser's "leave site?" prompt handle it
  ev.preventDefault();
  go(a.pathname + a.search);
}

// ----------------------------------------------------------------- boot ---

async function boot() {
  renderNav();
  let config = null;
  try {
    config = (await import('/blog/firebase-config.php')).default;
  } catch { /* treated as not configured */ }
  if (!config) {
    setView('', h('h1', {}, 'Blog'), h('p', { class: 'note' }, 'The blog is not configured on this server yet.'));
    return;
  }
  S.config = config;

  try {
    await initFirebase(config);
  } catch {
    setView('', h('h1', {}, 'Blog'), h('p', { class: 'note error' }, 'Could not load the Firebase libraries. Check your connection and reload.'));
    return;
  }

  document.addEventListener('click', handleLinkClick);
  window.addEventListener('popstate', route);
  window.addEventListener('beforeunload', (ev) => {
    if (S.dirty) { ev.preventDefault(); ev.returnValue = ''; }
  });

  let first = true;
  S.A.onAuthStateChanged(S.auth, (user) => {
    const changed = (S.user && S.user.uid) !== (user && user.uid);
    S.user = user;
    renderNav();
    if (first || changed) {
      first = false;
      route();
    }
  }, () => {
    if (first) { first = false; route(); }
  });
}

boot();

// Exported for testing the sanitiser from the browser console.
export { renderMarkdown };
