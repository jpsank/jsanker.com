<?php
declare(strict_types=1);

require_once __DIR__ . '/bootstrap.php';

/**
 * "/path/file.css" -> "/path/file.css?v=<mtime>" for files in public/, so browsers (and the 1-hour static
 * cache) pick up a changed file immediately instead of running stale JS against new HTML.
 */
function asset(string $path): string
{
    $file = __DIR__ . '/../public' . parse_url($path, PHP_URL_PATH);
    $mtime = @filemtime($file);
    return $mtime ? $path . (str_contains($path, '?') ? '&' : '?') . 'v=' . $mtime : $path;
}

/**
 * Site chrome. Every page is   page_start([...]);  ...content...  page_end();
 *
 * Options:
 *   title        page title (site name is appended)
 *   description  <meta description>
 *   crumbs       [[label, url], ...] shown under the header, e.g. projects / ChemCalc
 *   styles       extra stylesheet paths
 *   scripts      extra scripts: 'path.js' or ['src' => 'path.js', 'module' => true]
 *   home         true = the home page: the header shows only the nav (the page's own h1 carries the name)
 *   bare         true = no header/footer (full-screen toys like WireWorld)
 *   legacy       true = original puffyboa.xyz look: loads /assets/legacy/shared.css and prints the
 *                original breadcrumb bar from `crumbs` (jsanker.com / Projects / Project / Page); no new site chrome.
 *                The page prints its own original markup and passes its original CSS via `styles`.
 *                Add `nobar => true` to omit the breadcrumb bar (standalone originals).
 */
function page_start(array $o = []): void
{
    $legacy = !empty($o['legacy']);
    $title = isset($o['title'])
        ? $o['title'] . ($legacy ? ' - jsanker.com' : ' — Julian Sanker')
        : 'Julian Sanker';
    $desc  = $o['description'] ?? 'Julian Sanker — software, AI, and computational biology.';
    $GLOBALS['__page_scripts'] = $o['scripts'] ?? [];
    // legacy pages render their own original markup: no new site header/footer
    $GLOBALS['__page_bare'] = !empty($o['bare']) || $legacy;

    send_security_headers();
    header('Content-Type: text/html; charset=utf-8');

    echo "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n";
    echo "<meta charset=\"utf-8\">\n";
    echo "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n";
    echo '<title>' . e($title) . "</title>\n";
    echo '<meta name="description" content="' . e($desc) . "\">\n";
    if ($legacy) {
        // The original puffyboa.xyz look: its shared.css + the project's own stylesheet.
        echo "<link rel=\"shortcut icon\" href=\"/assets/legacy/favicon.png\">\n";
        echo "<link rel=\"stylesheet\" type=\"text/css\" href=\"" . e(asset('/assets/legacy/shared.css')) . "\">\n";
    } else {
        echo "<link rel=\"icon\" href=\"/favicon.ico\">\n";
        echo "<link rel=\"stylesheet\" href=\"" . e(asset('/assets/site.css')) . "\">\n";
    }
    foreach ($o['styles'] ?? [] as $css) {
        echo '<link rel="stylesheet" type="text/css" href="' . e(asset($css)) . "\">\n";
    }
    echo '</head><body' . (!empty($o['bare']) && !$legacy ? ' class="bare"' : '') . ">\n";

    if ($legacy && empty($o['nobar'])) {
        // The original "puffyboa.xyz / Project / Page" breadcrumb bar, now pointing home to jsanker.com.
        // (Standalone originals such as HHA Grades and uMusic pass 'nobar' => true to leave it out.)
        echo '<div class="back-to-home"><a href="/">jsanker.com</a><a href="/projects/">Projects</a>';
        foreach ($o['crumbs'] ?? [] as [$label, $url]) {
            echo '<a href="' . e((string) $url) . '">' . e($label) . '</a>';
        }
        echo "</div>\n";
    }

    if ($GLOBALS['__page_bare']) {
        return;
    }

    $home = !empty($o['home']);
    echo '<header class="site' . ($home ? ' home' : '') . '">';
    if (!$home) {
        echo '<a class="name" href="/">Julian Sanker</a>';
    }
    echo '<nav aria-label="Main">';
    foreach ([['/projects/', 'projects'], ['/blog/', 'blog'], ['/photos/', 'photos']] as [$href, $label]) {
        echo '<a href="' . e($href) . '">' . e($label) . '</a>';
    }
    echo "</nav></header>\n";

    if (!empty($o['crumbs'])) {
        echo '<p class="crumbs">';
        $parts = [];
        foreach ($o['crumbs'] as [$label, $url]) {
            $parts[] = $url === null ? e($label) : '<a href="' . e($url) . '">' . e($label) . '</a>';
        }
        echo implode(' / ', $parts) . "</p>\n";
    }
    echo "<main>\n";
}

function page_end(): void
{
    if (!$GLOBALS['__page_bare']) {
        echo "</main>\n<footer class=\"site\">";
        echo '<a href="mailto:julian@sankergroup.org">julian@sankergroup.org</a> · ';
        echo '<a href="https://github.com/jpsank">github</a> · ';
        echo '<a href="https://www.linkedin.com/in/juliansanker">linkedin</a>';
        echo "</footer>\n";
    }
    foreach ($GLOBALS['__page_scripts'] as $s) {
        $src = is_array($s) ? $s['src'] : $s;
        $mod = is_array($s) && !empty($s['module']) ? ' type="module"' : '';
        echo '<script' . $mod . ' src="' . e(asset($src)) . '"></script>' . "\n";
    }
    echo "</body>\n</html>\n";
}
