<?php
declare(strict_types=1);

/**
 * ProTop workspace: a shared room around one structure. The room id lives in the URL hash so it never reaches
 * server logs or Referer headers. All of it is drawn by js/workspace.js.
 */

require_once __DIR__ . '/../../../../src/layout.php';


page_start([
    'title'       => 'Workspace — ProTop',
    'description' => 'Look at a protein structure together: shared selections, annotations on residue ranges, and mutation proposals the group can accept or reject.',
    'crumbs'      => [['home', '/'], ['projects', '/projects/'], ['protop', '/projects/protop/'], ['workspace', null]],
    'styles'      => ['/projects/protop/protop.css'],
    'scripts'     => [['src' => '/projects/protop/js/workspace.js', 'module' => true]],
]);
?>
<div class="pt pt-wide">
<h1>Workspace</h1>
<noscript><p class="note">The workspace needs JavaScript: it draws the structure and keeps your tab in step with everyone else's.</p></noscript>
<div id="ws"></div>
</div>
<?php page_end();
