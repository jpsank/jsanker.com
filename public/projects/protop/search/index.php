<?php
declare(strict_types=1);

/** ProTop search: one box, a PDB ID or a UniProt accession. Everything is drawn by js/search.js from /projects/protop/api. */

require_once __DIR__ . '/../../../../src/layout.php';


page_start([
    'title'       => 'Search — ProTop',
    'description' => 'Look up a protein by PDB ID or UniProt accession: summary, knot data from AlphaKnot and KnotProt, and a 3D view.',
    'crumbs'      => [['home', '/'], ['projects', '/projects/'], ['protop', '/projects/protop/'], ['search', null]],
    'styles'      => ['/projects/protop/protop.css'],
    'scripts'     => [['src' => '/projects/protop/js/search.js', 'module' => true]],
]);
?>
<div class="pt">
<h1>Search</h1>
<p class="lede">Look a protein up by PDB ID or UniProt accession. The databases are asked on the server, so the first look at an entry can take a few seconds.</p>
<form id="search-form" role="search" action="/projects/protop/search/" method="get">
  <label for="q">PDB ID or UniProt accession</label>
  <div class="row">
    <input id="q" name="q" type="search" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="20" placeholder="1R42 or P01308" aria-describedby="q-hint" required>
    <button type="submit">Search</button>
  </div>
  <p id="q-hint" class="muted small">A PDB ID is four characters, like <a href="?q=1R42">1R42</a> or <a href="?q=1AKI">1AKI</a>. A UniProt accession looks like <a href="?q=P01308">P01308</a> or <a href="?q=Q9BYF1">Q9BYF1</a>.</p>
</form>
<noscript><p class="note">This page needs JavaScript to talk to the databases and draw the structure.</p></noscript>
<div id="result" aria-live="polite" aria-busy="false"></div>
</div>
<?php page_end();
