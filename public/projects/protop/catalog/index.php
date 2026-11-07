<?php
declare(strict_types=1);

/** ProTop catalog of knotted proteins (AlphaKnot + KnotProt snapshot). Table drawn by js/catalog.js. */

require_once __DIR__ . '/../../../../src/layout.php';

page_start([
    'title'       => 'Knotted protein catalog — ProTop',
    'description' => 'Knotted proteins from AlphaKnot and KnotProt in one filterable, sortable table with CSV download.',
    'crumbs'      => [['home', '/'], ['projects', '/projects/'], ['protop', '/projects/protop/'], ['catalog', null]],
    'styles'      => ['/projects/protop/protop.css'],
    'scripts'     => [['src' => '/projects/protop/js/catalog.js', 'module' => true]],
]);
?>
<div class="pt pt-wide">
<h1>Knotted protein catalog</h1>
<p class="lede">Proteins whose backbone is tied in a knot, collected from two databases: <a href="https://alphaknot.cent.uw.edu.pl/">AlphaKnot</a> (AlphaFold predictions, keyed by UniProt accession) and <a href="https://knotprot.cent.uw.edu.pl/">KnotProt</a> (experimental structures, keyed by PDB ID). The two overlap in what they cover but not in how they were found, so the source is a column. Choose a row to look the protein up.</p>
<form id="cat-form" class="filters" action="/projects/protop/catalog/" method="get" role="search" aria-label="Filter the catalog">
  <div><label for="f-q">Search IDs and names</label><input id="f-q" name="q" type="search" autocomplete="off" maxlength="60"></div>
  <div><label for="f-knot">Knot type</label><select id="f-knot" name="knot"><option value="">All</option></select></div>
  <div><label for="f-source">Source</label><select id="f-source" name="source"><option value="">Both</option></select></div>
  <div><label for="f-per">Rows per page</label><select id="f-per" name="per_page"><option>25</option><option>50</option><option>100</option></select></div>
  <button type="submit">Apply</button>
</form>
<noscript><p class="note">This page needs JavaScript to load the table.</p></noscript>
<div class="cat-top">
  <p id="cat-count" class="count" role="status" aria-live="polite">Loading the catalog…</p>
  <a id="cat-csv" class="btn" href="/projects/protop/api/catalog.csv" download>Download CSV</a>
</div>
<div class="table-wrap" tabindex="0" role="region" aria-label="Catalog table">
  <table id="cat-table" class="cat">
    <caption class="sr-only">Knotted proteins. Column headers are buttons that sort the table.</caption>
    <thead></thead>
    <tbody></tbody>
  </table>
</div>
<nav id="cat-pager" class="pager" aria-label="Pages"></nav>
<p id="cat-snapshot" class="muted small"></p>
</div>
<?php page_end();
