<?php
declare(strict_types=1);

/**
 * Blog + accounts shell. Everything happens client-side in blog.js, which talks
 * straight to Firebase Auth and Cloud Firestore (posts and accounts live there;
 * firestore.rules is the access control). Routing is by query string:
 *
 *   /blog/                 list of posts
 *   /blog/?post=<id>       one post
 *   /blog/?edit=<id>       edit (author only)
 *   /blog/?new             write a post
 *   /blog/?author=<uid>    posts by one author
 *   /blog/?account         sign in; ?account=signup | reset; profile when signed in
 *
 * The CSP is widened only for what the Firebase JS SDK needs: its modules from
 * gstatic, its API endpoints, and the Google sign-in popup.
 */

require_once __DIR__ . '/../../src/layout.php';

csp_allow('script-src', 'https://www.gstatic.com', 'https://apis.google.com');
csp_allow('connect-src',
    'https://firestore.googleapis.com',
    'https://identitytoolkit.googleapis.com',
    'https://securetoken.googleapis.com');
csp_allow('frame-src', 'https://*.firebaseapp.com', 'https://accounts.google.com');

page_start([
    'title'       => 'Blog',
    'description' => 'Posts by Julian Sanker, and by anyone who signs up to write.',
    'styles'      => ['/blog/blog.css'],
    'scripts'     => [['src' => '/blog/blog.js', 'module' => true]],
]);
?>
<nav id="blog-nav" class="blognav" aria-label="Blog">
  <a href="/blog/">blog</a> · <a href="/blog/?new">new post</a> · <a href="/blog/?account">account</a>
</nav>

<div id="blog" aria-live="polite">
  <noscript><p class="note">The blog needs JavaScript: posts and accounts are loaded in your browser from Firebase.</p></noscript>
  <p class="muted" id="blog-loading">Loading…</p>
</div>
<?php
page_end();
