<?php
declare(strict_types=1);

/**
 * HHA Grades: a live souvenir of the original grade checker UI, running on made-up data.
 * The original logged into a school portal with the student's own credentials and scraped
 * their grades. That portal no longer exists, so this page is client-side only: submitting
 * the form never sends or stores anything, it just opens a demo view built from grades.json.
 * Markup follows the original Flask templates (base.html, login.html, index.html).
 */

require_once __DIR__ . '/../../../src/layout.php';

page_start([
    'title'       => 'HHA ESchool (demo)',
    'description' => 'A working demo of a grade checker for Haas Hall scholars, running on made-up data.',
    'legacy'      => true,
    'nobar'       => true,
    'styles'      => ['/projects/hha-grades/style.css'],
    'scripts'     => ['/projects/hha-grades/script.js'],
]);
?>

    <div class="jumbo">
        <img alt src="/projects/hha-grades/crest.png" />
        <h1>Haas Hall Academy</h1>
    </div>

    <form id="login" autocomplete="off">
        <p class="message"></p>

        <label for="username">Username:</label>
        <input type="text" id="username" autocomplete="off">
        <br>
        <label for="password">Password:</label>
        <input type="password" id="password" autocomplete="off">
        <br>
        <input type="submit" value="Login">
        <p class="demo-note">Demo: the school portal this scraped no longer exists, so this uses made-up data. Nothing you type is sent.</p>
    </form>

    <section class="courses" hidden>
    </section>

    <footer>
        <p>The source code for this project is hosted on <a href="https://github.com/puffyboa/hha-grades">Github</a>.</p>
        <p><b>Disclaimer:</b> jsanker.com is not officially affiliated with Haas Hall Academy.</p>
        <p><b>Privacy Policy:</b> No ESchool login credentials or grades are kept or stored in any way.</p>
        <p class="back"><a href="/projects/">&larr; All projects</a> <span id="logout-wrap" hidden>&middot; <a href="#" id="logout">Back to login</a></span></p>
    </footer>

<?php page_end();
