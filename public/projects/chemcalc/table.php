<?php
declare(strict_types=1);
require_once __DIR__ . '/../../../src/layout.php';

page_start([
    'legacy'      => true,
    'title'       => 'ChemCalc',
    'description' => 'Interactive periodic table',
    'crumbs'      => [['ChemCalc', '/projects/chemcalc/'], ['Periodic Table', '/projects/chemcalc/table.php']],
    'styles'      => ['/projects/chemcalc/style.css'],
    'scripts'     => [['src' => '/projects/chemcalc/table.js', 'module' => true]],
]);
?>
<section id="jumbo">
    <h1><a href="index.php">ChemCalc</a></h1>
    <p>Interactive Periodic Table</p>
</section>

<section id="main">

    <div id="trend-selector">
        <label>Select a trend:</label>
        <select>
            <option>None</option>
            <option value="boil">Boiling Point (K)</option>
            <option value="density">Density (g/cm3)</option>
            <option value="melt">Melting Point (K)</option>
            <option value="molar_heat">Molar Heat (J/mol K)</option>
        </select>
    </div>

    <div id="legend">

    </div>

    <table id="periodic-table">

    </table>

</section>
<?php page_end();
