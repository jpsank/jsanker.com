<?php
declare(strict_types=1);

/**
 * ProTop: a 2023 software-engineering team project (Yale CPSC 439/549), rebuilt. This is the landing page.
 * The tools live in search/, catalog/, workspace/ and flexibility/; they talk to the Flask service at /projects/protop/api.
 */

require_once __DIR__ . '/../../../src/layout.php';

page_start([
    'title'       => 'ProTop',
    'description' => 'A protein-database aggregator, a catalog of knotted proteins and a shared structure workspace. A 2023 Yale software-engineering team project, rebuilt.',
    'crumbs'      => [['home', '/'], ['projects', '/projects/'], ['protop', null]],
    'styles'      => ['/projects/protop/protop.css'],
]);
?>
<div class="pt">
<h1>ProTop</h1>
<p class="lede">Structural biologists keep switching between databases that each know a different piece of a protein. ProTop was our attempt, in a fall 2023 software-engineering course at Yale (CPSC 439/549), at one place to look a protein up, browse the knotted ones, and work on a structure together. Here it is running again.</p>
<p class="credit">Built by Anna Su, Jason Apostol, Julian Sanker, Daniel Zuo and Lily Cai. Anna was our resident biologist.</p>

<h2>The tools</h2>
<ul class="tools">
  <li><a href="/projects/protop/search/"><strong>Search</strong></a> Type a PDB ID or a UniProt accession. You get the entry's summary, any knot data from AlphaKnot and KnotProt, and the structure in 3D.</li>
  <li><a href="/projects/protop/catalog/"><strong>Catalog</strong></a> Knotted proteins from AlphaKnot and KnotProt in one table you can filter, sort and download as CSV.</li>
  <li><a href="/projects/protop/workspace/"><strong>Workspace</strong></a> Open a structure with other people. See what each person has selected, annotate stretches of residues, propose mutations and decide on them together, then export the result. This is the part we did not manage to build in 2023.</li>
  <li><a href="/projects/protop/flexibility/"><strong>Flexibility</strong></a> The model we proposed for predicting protein flexibility, and why it is not here.</li>
</ul>

<h2>What changed in the rebuild</h2>
<p>The 2023 version was a React app on Render that called a Flask service on Render, a MongoDB Atlas database and a few Firebase services. It ran on free-tier hosting that was never meant to last. This version keeps the ideas and swaps the plumbing.</p>
<ul>
  <li><strong>No framework, no accounts.</strong> Plain pages and ES modules, no build step, no sign-in. A room's link is its only key.</li>
  <li><strong>One small service, on this site.</strong> A Flask app next to the website fetches RCSB, UniProt, AlphaKnot and KnotProt on your behalf, checks every ID, caches the answers and gives up on a database that is too slow. Your browser never talks to any of them, or to anyone but this site.</li>
  <li><strong>The catalog is a snapshot.</strong> It is a SQLite copy of the two knot databases rather than a live MongoDB, with the date it was taken shown on the page. The data change rarely.</li>
  <li><strong>Collaboration now exists.</strong> In 2023 the editor loaded a file and highlighted a range, and everything stayed in one browser tab. The workspace is a shared log of edits that every open tab follows within a couple of seconds.</li>
  <li><strong>Flexibility is still a proposal.</strong> We never built the model, and I have not pretended otherwise.</li>
</ul>

<h2>Data and software credits</h2>
<ul>
  <li><a href="https://www.rcsb.org/">RCSB Protein Data Bank</a>: entry summaries and the coordinate files.</li>
  <li><a href="https://www.uniprot.org/">UniProt</a>: protein names, genes, sequences and disease links.</li>
  <li><a href="https://alphaknot.cent.uw.edu.pl/">AlphaKnot</a>: knots found in AlphaFold predictions.</li>
  <li><a href="https://knotprot.cent.uw.edu.pl/">KnotProt</a>: knots found in experimentally determined structures.</li>
  <li><a href="https://nglviewer.org/ngl/">NGL</a> (MIT licence): the 3D viewer, served from this site.</li>
</ul>
<p class="muted small">These databases belong to their maintainers; please cite them, not this page, if you use their data. The code for this rebuild is in the <a href="https://github.com/jpsank/jsanker.com">site repository</a> (<code>public/projects/protop</code> and <code>protop-app</code>).</p>
</div>
<?php page_end();
