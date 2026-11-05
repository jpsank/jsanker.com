<?php
declare(strict_types=1);
require_once __DIR__ . '/../src/layout.php';

page_start(['description' => 'Julian Sanker — Yale CS graduate from Northwest Arkansas. Software, AI, computational biology.']);
?>
<img class="portrait" src="/img/me.jpeg" alt="Julian Sanker" width="144" height="144">

<h1>Julian Sanker</h1>

<p>I'm a Yale University graduate with a degree in Computer Science, from Northwest Arkansas.</p>

<p>I enjoy creating software, particularly websites and useful apps. I'm looking for jobs in software
engineering, artificial intelligence, and computational biology.</p>

<p>I also enjoy nature, and I'm interested in creating models of living organisms using
<a href="https://nn.cs.utexas.edu/downloads/papers/stanley.ec02.pdf">neural networks and evolutionary algorithms</a>.</p>

<p>Reach out at <a href="mailto:julian@sankergroup.org">julian@sankergroup.org</a>
or <a href="https://calendly.com/juliansanker">schedule a meeting</a>.</p>

<h2>Things of note</h2>
<ul>
  <li><a href="/projects/">Projects</a> — old high-school programs, most still running</li>
  <li><a href="/blog/">Blog</a> — write one yourself if you make an account</li>
  <li><a href="/life/">Life</a> — Conway's Game of Life, seeded at random from 1,257 patterns</li>
  <li><a href="/photos/">Photos</a> — Northwest Arkansas</li>
  <li><a href="https://crimemap.app/">Crime Map</a> — 911 dispatches in Fayetteville, built with Lucas Kellar for the 2019 JB Hunt Hackathon</li>
</ul>

<h2>Colophon</h2>
<p class="muted small">Plain HTML and PHP, one stylesheet, no tracking. The old projects are the original PHP,
audited and patched, running in a single FrankenPHP container.</p>
<?php page_end();
