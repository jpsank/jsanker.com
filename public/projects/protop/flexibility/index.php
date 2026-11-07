<?php
declare(strict_types=1);

/** ProTop flexibility: the model that was proposed in 2023 and never built, said plainly. */

require_once __DIR__ . '/../../../../src/layout.php';

page_start([
    'title'       => 'Flexibility — ProTop',
    'description' => 'The original ProTop team proposed a graph neural network with persistent homology to predict protein flexibility. It was not built. What exists instead is a B-factor view.',
    'crumbs'      => [['home', '/'], ['projects', '/projects/'], ['protop', '/projects/protop/'], ['flexibility', null]],
    'styles'      => ['/projects/protop/protop.css'],
]);
?>
<div class="pt">
<h1>Flexibility</h1>
<p class="lede">Proteins are not rigid. Some regions barely move and others swing about, and which is which matters for what a protein does. One of ProTop's four goals was to predict that from the structure. <strong>That predictor was never built.</strong></p>

<h2>What we proposed</h2>
<p>In 2023 we planned a deep-learning model that takes a protein structure and predicts the flexibility of each part. It would combine two ideas: a <strong>graph neural network</strong>, which treats the structure as a graph of residues and learns from their neighbourhoods, and <strong>persistent homology</strong>, a tool from topological data analysis that summarises the shape of a point cloud, here the atoms, at every scale at once. The figure from our proposal sketches the pipeline.</p>
<figure>
  <img src="/projects/protop/img/dl_overview.jpg" width="1230" height="1064" alt="Flow diagram of the proposed model. A user supplies a 3D protein structure as a PDB file. Two aspects feed the prediction: a graph neural network, built either as a multi-graph of atoms, bonds and bond angles or as a residue contact map with one-hot amino-acid labels; and topological features, calculated from bond geometry and knot theory or extracted with persistent homology. Together they return a protein molecular flexibility prediction." loading="lazy">
  <figcaption>The summary figure from the 2023 proposal. This describes a plan, not something that ran.</figcaption>
</figure>
<p>The upload form on the old page was a placeholder that said "to be enabled later this month". It never was, there was no trained model behind it, and this page does not have one either.</p>

<h2>What does work today</h2>
<p>Most structures determined by X-ray crystallography record, for every atom, a <strong>B-factor</strong>: how much the atom seems to smear around its average position in the experiment. A high value means the atom was mobile or poorly ordered, so it is an experimental view of flexibility, not a prediction. Any structure opened in the workspace can be coloured by it: tick <em>Colour by B-factor</em> under the 3D view.</p>
<p><a class="btn" href="/projects/protop/workspace/">Open the workspace</a></p>
<p class="muted small">A few cautions. B-factors depend on the crystal and the resolution, not only on the protein, so compare regions within one structure rather than across structures. NMR structures usually do not have them. And a model predicted by AlphaFold stores a per-residue confidence score in the same column, where a high value means "sure", the opposite of mobile.</p>
</div>
<?php page_end();
