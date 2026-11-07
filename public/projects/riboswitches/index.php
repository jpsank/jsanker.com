<?php
declare(strict_types=1);

/**
 * Riboswitches: the results of a 2023 directed-research project (CPSC 290, Breaker Lab), redrawn.
 * Every number comes from data.json, which is built from the search tables in github.com/jpsank/breaker.
 */

require_once __DIR__ . '/../../../src/layout.php';

$data = json_decode((string) file_get_contents(__DIR__ . '/data.json'), true, 512, JSON_THROW_ON_ERROR);
$c = $data['counts'];
$n = static fn(int $v): string => number_format($v);
$cmp = $data['compare'];
$last = static fn(string $m): array => $cmp[$m][array_key_last($cmp[$m])];
$dufN = $cmp['comb'][0]['duf_found'] + $cmp['comb'][0]['duf_missed'];
$nhaN = $cmp['comb'][0]['nha_found'] + $cmp['comb'][0]['nha_missed'];

page_start([
    'title'       => 'Riboswitches',
    'description' => 'Can two sodium-binding riboswitch families be described by one model? Search results and the story of the pipeline, from a 2023 research project at the Breaker Lab.',
    'crumbs'      => [['home', '/'], ['projects', '/projects/'], ['riboswitches', null]],
    'styles'      => ['/projects/riboswitches/riboswitches.css'],
    'scripts'     => ['/projects/riboswitches/riboswitches.js'],
]);
$img = '/projects/riboswitches/img/';
?>
<div class="rs">
<h1>Riboswitches</h1>
<p class="lede">Can two bacterial RNA switches that respond to sodium be described by one model? This was my directed-research project at Yale in spring 2023 (CPSC 290), working with the Breaker Lab. Here are its results, redrawn so you can poke at them, and how the work got there.</p>
<p class="credit">Advised by Dr. Smita Krishnaswamy, mentored by Dr. Ronald Breaker and Christopher King.
Code and the original report: <a href="https://github.com/jpsank/breaker">github.com/jpsank/breaker</a>.</p>

<h2>Background</h2>
<p>A riboswitch is a stretch of messenger RNA that binds a small molecule and, in response, changes whether the gene next to it is translated. More than 55 classes were known in 2022, and a review that year projected that thousands more remain undiscovered. They are rare and hard to spot, so finding them is a search problem: take a model of a known RNA family, scan every sequenced genome for matches, and look at what turns up.</p>

<h2>The question</h2>
<p>Rfam lists two families that look alike and are both associated with sodium: <strong>nhaA-I</strong> (RF03057) and <strong>DUF1646</strong> (RF03071). Each is two stem-loops, 95 and 77 nucleotides long. If they are really one family, a single model should find the hits of both. These are R2R drawings of each family's consensus structure; letters mark the conserved positions.</p>
<div class="pair">
  <figure><img src="<?= $img ?>nhaA-I-rfam.png" width="446" height="289" alt="R2R diagram of the nhaA-I consensus structure: two stem-loops joined by a short unpaired stretch" loading="lazy"><figcaption>nhaA-I (RF03057)</figcaption></figure>
  <figure><img src="<?= $img ?>DUF1646-rfam.png" width="362" height="316" alt="R2R diagram of the DUF1646 consensus structure: two stem-loops" loading="lazy"><figcaption>DUF1646 (RF03071)</figcaption></figure>
</div>

<h2>The experiment</h2>
<ol class="steps">
  <li>
    <h3>Download the two alignments</h3>
    <p>From Rfam. They are the drawings above.</p>
  </li>
  <li>
    <h3>Search each one against the genomes</h3>
    <p>I used Infernal's <code>cmsearch</code> to scan the representative bacterial genomes in GTDB release 207, on Yale's cluster. Every hit gets an <strong>E-value</strong>: roughly how many matches this good you would expect by chance in a database this size, so lower is better. Many hits are copies of the same sequence, so I also count <strong>unique</strong> hits, where identical aligned sequences collapse into one, and apply an <strong>E &lt; 1</strong> cutoff.</p>
    <div class="chart">
      <h4>How many hits survive each filter</h4>
      <p class="sub">The four searches in this experiment. Bars are scaled to the largest count.</p>
      <div id="funnel"></div>
    </div>
    <p>The two single-family searches share no hits: not one hit from the nhaA-I search overlaps one from the DUF1646 search.</p>
    <div class="chart">
      <h4>Where the hits fall by E-value</h4>
      <p class="sub">Unique hits per bin of the log of the E-value. Drag the cutoff; the bars you keep stay colored.</p>
      <div class="controls">
        <label>Search
          <select id="hist-model">
            <option value="nha">nhaA-I</option>
            <option value="duf">DUF1646</option>
            <option value="comb">Combined (CMfinder)</option>
            <option value="lina">LiNa</option>
          </select>
        </label>
        <label>E-value cutoff
          <input id="hist-thr" type="range" min="-9" max="3" step="0.1" value="0" aria-describedby="hist-out">
        </label>
        <button type="button" id="hist-reset">E &lt; 1</button>
      </div>
      <p class="readout" id="hist-out" aria-live="polite"></p>
      <div id="hist-plot"></div>
      <details><summary>Table view</summary><div id="hist-table"></div></details>
    </div>
    <div class="pair">
      <figure><img src="<?= $img ?>nhaA-I-hits.png" width="569" height="311" alt="R2R diagram of the nhaA-I search hits" loading="lazy"><figcaption>Consensus of the unique nhaA-I hits with E &lt; 1</figcaption></figure>
      <figure><img src="<?= $img ?>DUF1646-hits.png" width="614" height="323" alt="R2R diagram of the DUF1646 search hits" loading="lazy"><figcaption>Consensus of the unique DUF1646 hits with E &lt; 1</figcaption></figure>
    </div>
  </li>
  <li>
    <h3>Refold with CMfinder</h3>
    <p>CMfinder builds a new structural model from a set of hits. I ran it on the nhaA-I hits, on the DUF1646 hits, and on both together, which gave the <strong>combined</strong> model. Chris made a second merged model, <strong>LiNa</strong>, by merging the two original Rfam alignments directly with <code>esl-alimerge</code>.</p>
    <div class="quad">
      <figure><img src="<?= $img ?>nhaA-I-refold.png" width="399" height="317" alt="R2R diagram of the model CMfinder built from the nhaA-I hits" loading="lazy"><figcaption>nhaA-I, refolded</figcaption></figure>
      <figure><img src="<?= $img ?>DUF1646-refold.png" width="443" height="328" alt="R2R diagram of the model CMfinder built from the DUF1646 hits" loading="lazy"><figcaption>DUF1646, refolded</figcaption></figure>
      <figure><img src="<?= $img ?>combined-refold.png" width="560" height="317" alt="R2R diagram of the combined model CMfinder built from both sets of hits" loading="lazy"><figcaption>Combined (CMfinder)</figcaption></figure>
      <figure><img src="<?= $img ?>lina.png" width="404" height="331" alt="R2R diagram of the LiNa model" loading="lazy"><figcaption>LiNa (Chris's merge)</figcaption></figure>
    </div>
  </li>
  <li>
    <h3>Search with the merged models</h3>
    <p>Same tool, same genomes. The combined model reports <?= $n($c['comb']['total']) ?> hits, <?= $n($c['comb']['unique_e1']) ?> of them unique with E &lt; 1. LiNa reports <?= $n($c['lina']['total']) ?>, <?= $n($c['lina']['unique_e1']) ?> unique with E &lt; 1.</p>
  </li>
  <li>
    <h3>Did a merged model find both?</h3>
    <p>For each cutoff I took the unique nhaA-I and DUF1646 hits with E &lt; 1 (<?= $n($nhaN) ?> and <?= $n($dufN) ?>) and asked how many fall on the same stretch of the same contig as a hit from the merged model. The right-hand column counts hits the merged model found that neither original search did.</p>
    <ul class="legend"><li><span class="swatch sw-nha"></span>nhaA-I hits recovered</li><li><span class="swatch sw-duf"></span>DUF1646 hits recovered</li></ul>
    <div class="chart">
      <h4><span class="swatch sw-comb"></span> Combined (CMfinder)</h4>
      <div id="recall-comb"></div>
      <p class="takeaway" id="recall-note-comb"></p>
      <details><summary>Table view</summary><div id="recall-table-comb"></div></details>
    </div>
    <div class="chart">
      <h4><span class="swatch sw-lina"></span> LiNa</h4>
      <div id="recall-lina"></div>
      <p class="takeaway" id="recall-note-lina"></p>
      <details><summary>Table view</summary><div id="recall-table-lina"></div></details>
    </div>
    <p><strong>So: no, neither merged model replaced both.</strong> The CMfinder model found none of the DUF1646 hits at any cutoff. Its input held four times as many nhaA-I hits as DUF1646 hits (<?= $n($c['nha']['unique_e1']) ?> to <?= $n($c['duf']['unique_e1']) ?>), and my guess was that it learned the bigger family and ignored the smaller; I never tested that. LiNa is less lopsided, but at strict cutoffs it gives up many of the nhaA-I hits to get a few DUF1646 ones. Both find some hits the single-family searches missed (<?= $n($last('comb')['novel']) ?> and <?= $n($last('lina')['novel']) ?> at E &lt; 1). Whether those are riboswitches or false positives needs more work than I did.</p>
    <div class="note">
      <strong>A correction to the original report.</strong> Its summary table gave LiNa 1,953 hits and 1,801 unique hits for E &lt; 1. Those are the E &lt; 100 counts, from the wrong file. At E &lt; 1 LiNa has <?= $n($c['lina']['e1']) ?> hits, <?= $n($c['lina']['unique_e1']) ?> unique (the report's comparison table has the right figure). That undoes the report's remark that LiNa found more well-matched hits than the combined model: at E &lt; 1 it is <?= $n($c['lina']['unique_e1']) ?> against <?= $n($c['comb']['unique_e1']) ?>. Every number on this page is recomputed from the search tables.
    </div>
    <details>
      <summary>How these numbers were made</summary>
      <p class="small muted">Hits come from each search's <code>.out.tbl</code> file. "Unique" uses the pipeline's own deduplicated table. A merged-model hit counts as recovering a single-family hit when both lie on the same contig and their coordinates overlap. This reproduces the comparison table in the original report exactly; the cutoffs between its four rows (300, 30, 3) are added here.</p>
    </details>
  </li>
  <li>
    <h3>An aside: tandem hits</h3>
    <p>The comparison script also flags hits within 100 base pairs of each other. It found <?= (int) $data['tandem_contigs'] ?> contigs with such pairs. That did not change the analysis, but it is the kind of question a pipeline like this should make cheap to ask.</p>
  </li>
</ol>

<h2>The journey</h2>
<p>The repository has <?= count($data['commits']) ?> commits between February and May 2023, shown here one dot per commit.</p>
<div class="chart">
  <div id="commits-plot"></div>
</div>
<ol class="phases">
  <li><strong>Parse and count.</strong> <span class="when">Feb 26 – Mar 6, <span data-phase="1"></span>.</span> Read Infernal's tables, join hits to their alignments, drop duplicate sequences, first score plots.</li>
  <li><strong>Tidy and document.</strong> <span class="when">Mar 9 – 13, <span data-phase="2"></span>.</span> Reorganize the code and write the README.</li>
  <li><strong>Automate on the cluster.</strong> <span class="when">Apr 6 – 9, <span data-phase="3"></span>.</span> Scripts to submit searches to the cluster's job scheduler and copy results back, the refolding step, and the first full set of searches.</li>
  <li><strong>Finalize the pipeline.</strong> <span class="when">Apr 23, <span data-phase="4"></span>.</span> The searches behind this page, the final statistics, and a fix for the structure-drawing tool failing on the cluster.</li>
  <li><strong>SQL and the report.</strong> <span class="when">May 2 – 4, <span data-phase="5"></span>.</span> Moved from files to a SQL database and wrote the final report.</li>
</ol>
<details><summary>All commits</summary><ol id="commit-list" class="small"></ol></details>

<h2>Where it stopped</h2>
<p>The proposal had three parts: the pipeline above; a genetic algorithm for RNA folding, adapted from NEAT, to replace CMfinder; and a web interface with an RNA alignment editor. Only the pipeline got finished. The report says I planned to keep going over the summer, and the repository stops in May 2023. The original write-up, with the proposal and final report, is in the repository's <a href="https://github.com/jpsank/breaker/tree/HEAD/cpsc290"><code>cpsc290</code></a> folder.</p>

<script type="application/json" id="rs-data"><?= json_encode($data, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_THROW_ON_ERROR) ?></script>
</div>
<?php page_end();
