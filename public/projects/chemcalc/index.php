<?php
declare(strict_types=1);

/**
 * ChemCalc — thermodynamic properties of molecules and chemical equations.
 * Original PHP (Parser / Molecule / Equation), ported and hardened:
 *   - input is validated against a character allow-list before parsing
 *   - every value is HTML-escaped, except formula markup that the classes build
 *     only from element symbols and integers (already restricted by the allow-list)
 *   - parser/solver failures (including PHP warnings) become a friendly message
 *   - infinite loops in the balancer were fixed (see src/chemcalc/Equation.php)
 */

require_once __DIR__ . '/../../../src/layout.php';

function startsWith(string $haystack, string $needle): bool
{
    return str_starts_with($haystack, $needle);
}

function endsWith(string $haystack, string $needle): bool
{
    return $needle === '' || str_ends_with($haystack, $needle);
}

function readJSON(string $file): array
{
    return json_decode((string) file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);
}

$ELEMENTS = readJSON(APP_ROOT . '/data/chemcalc/elements.json');
$APPENDIX = readJSON(APP_ROOT . '/data/chemcalc/appendix.json');

require_once APP_ROOT . '/src/chemcalc/Parser.php';
require_once APP_ROOT . '/src/chemcalc/Constituent.php';
require_once APP_ROOT . '/src/chemcalc/Molecule.php';
require_once APP_ROOT . '/src/chemcalc/Equation.php';

const MAX_INPUT = 200;
const MAX_PER_SIDE = 8;

/** Returns an error message if the input must not reach the parser, else null. */
function validateInput(string $input): ?string
{
    if (mb_strlen($input) > MAX_INPUT) {
        return 'That is too long. Keep it under ' . MAX_INPUT . ' characters.';
    }
    if (!preg_match('/^[A-Za-z0-9()+\-=\s.]+$/', $input)) {
        return 'Only letters, digits, parentheses, spaces and + - = . are allowed.';
    }
    if (substr_count($input, '=') > 1) {
        return 'Use a single = to separate reactants from products.';
    }
    if (preg_match('/\d{5,}/', $input)) {
        return 'Numbers are limited to four digits.';
    }
    foreach (explode('=', $input) as $side) {
        if (substr_count($side, '+ ') + substr_count($side, ' + ') + 1 > MAX_PER_SIDE * 3) {
            return 'Too many terms.';
        }
    }
    return null;
}

/** One result row. $rawValue marks values built from safe formula markup. */
function row(string $label, string $value, bool $rawValue = false): string
{
    $class = '';
    if ($value === 'No') {
        $class = ' red';
    } elseif ($value === 'Yes') {
        $class = ' green';
    }
    return '<tr><td class="key">' . $label . ' </td><td class="val' . $class . '">'
        . ($rawValue ? $value : e($value)) . '</td></tr>';
}

$input = isset($_GET['input']) && is_string($_GET['input'])
    ? trim(str_replace('%2B', '+', $_GET['input']))
    : '';

$error = null;
$resultHtml = '';
$extraHtml = '';

if ($input !== '') {
    $error = validateInput($input);
    if ($error === null) {
        set_time_limit(5);
        try {
            $parser = new Parser();
            if (str_contains($input, '=')) {
                $equation = $parser->parseEquation($input);
                if (count($equation->reactants) > MAX_PER_SIDE || count($equation->products) > MAX_PER_SIDE) {
                    throw new RuntimeException('too many molecules');
                }
                $isBalanced = $equation->isBalanced();

                $rows = '';
                $pre = '';
                if (!$isBalanced) {
                    $newEq = $equation->getBalancedEq();
                    if ($newEq) {
                        $flat = urlencode($newEq->getEquationStr(false, false));
                        $pre = '<a class="blue" href="?input=' . e($flat) . '">Go to balanced version</a>';
                    } else {
                        $pre = 'Unable to calculate balanced equation';
                    }
                }
                $rows .= row('Reaction', $equation->getEquationStr(true, true), true);
                $rows .= row('Is balanced', $isBalanced ? 'Yes' : 'No');
                if ($equation->checkHasSupport()) {
                    $rows .= row('&Delta;H&deg;<sub>rxn</sub>', $equation->getEnthalpy() . ' kJ/mol (' . $equation->getEnthalpyBehavior() . ')');
                    $rows .= row('&Delta;S&deg;<sub>rxn</sub>', $equation->getEntropy() . ' J/molK (' . $equation->getEntropyBehavior() . ')');
                    $rows .= row('&Delta;G&deg;<sub>rxn</sub>', $equation->getGibbs() . ' kJ/mol (' . $equation->getGibbsBehavior() . ')');
                    $rows .= row('Behavior', $equation->getBehavior());
                    $rows .= row('Favorable at 25 Celsius', $equation->isFavorableAt(298.15) ? 'Yes' : 'No');
                }
                $resultHtml = $pre . '<table class="props">' . $rows . '</table>';
            } else {
                $molecule = $parser->parseMolecule($input);
                if (!$molecule->constituents) {
                    throw new RuntimeException('no recognisable elements');
                }
                $rows = '<tr><td>' . $molecule->getFullFormula() . '</td></tr>';
                $rows .= row('Composition', $molecule->getComposition(), true);
                $rows .= row('Average molar mass', $molecule->getMass() . ' g/mol');
                if ($molecule->appendices) {
                    $rows .= row('Available phases', $molecule->getPhasesHTML(), true);
                    $rows .= row('&Delta;H&deg;<sub>f</sub>', $molecule->getEnthalpy() . ' kJ/mol');
                    $rows .= row('&Delta;S&deg;<sub>f</sub>', $molecule->getEntropy() . ' J/molK');
                    $rows .= row('&Delta;G&deg;<sub>f</sub>', $molecule->getGibbs() . ' kJ/mol');
                }
                $resultHtml = '<table class="props">' . $rows . '</table>';

                $elem = $molecule->isSingleElement();
                if ($elem !== false) {
                    $fmt = static fn($v, string $unit = ''): string => ($v !== null && $v !== '' && $v !== false) ? $v . $unit : '';
                    $props = [
                        'Appearance'     => $fmt($elem['appearance']),
                        'Molar Mass'     => $fmt($elem['atomic_mass'], ' g/mol'),
                        'Boiling point'  => $fmt($elem['boil'], ' K'),
                        'Category'       => $fmt($elem['category']),
                        'Color'          => $fmt($elem['color']),
                        'Density'        => $fmt($elem['density'], ' g/cm3'),
                        'Discovered by'  => $fmt($elem['discovered_by']),
                        'Melting point'  => $fmt($elem['melt'], ' K'),
                        'Molar heat'     => $fmt($elem['molar_heat'], ' J/molK'),
                        'Named by'       => $fmt($elem['named_by']),
                        'Atomic Number'  => $fmt($elem['number']),
                        'Phase'          => $fmt($elem['phase']),
                        'Source'         => $fmt($elem['source']),
                        'Spectral img'   => $fmt($elem['spectral_img']),
                        'Shells'         => json_encode($elem['shells']),
                    ];
                    $extraHtml = '<h2>Atomic Properties of ' . e($elem['name']) . '</h2><p>' . e($elem['summary']) . '</p><table class="atomic_props">';
                    foreach ($props as $label => $value) {
                        $extraHtml .= row(e($label), (string) $value);
                    }
                    $extraHtml .= '</table>';
                }
            }
        } catch (Throwable $t) {
            // Undefined element symbols, malformed formulas, solver failures, timeouts…
            error_log('chemcalc: ' . $t::class . ': ' . $t->getMessage());
            $error = "I couldn't make sense of that. Try something like NaOH + HCl = NaCl + H2O.";
            $resultHtml = $extraHtml = '';
        }
    }
}

page_start([
    'legacy'      => true,
    'title'       => 'ChemCalc',
    'description' => 'Calculate the properties for all your chemical equations and molecules',
    'crumbs'      => [['ChemCalc', '/projects/chemcalc/']],
    'styles'      => ['/projects/chemcalc/style.css'],
]);

$examples = ['NaOH + HCl = NaCl + H2O', 'H2O', '3Fe2O3 + CO = CO2 + 2Fe3O4', 'CH3OH', 'H2O (g) = H2O (l)'];
$links = [];
foreach ($examples as $ex) {
    $class = $input === $ex ? ' class="selected"' : '';
    $links[] = '<a' . $class . ' href="?input=' . e(urlencode($ex)) . '">' . e($ex) . '</a>';
}
?>
<section id="jumbo">
    <h1>ChemCalc</h1>
    <a href="table.php">See Periodic Table</a>
    <p>Calculate the properties for all your chemical equations and molecules</p>
    <p>i.e.
        <?= implode(', ', $links) ?>
    </p>
</section>

<section id="main">

    <form id="form" method="get">
        <input type="text" name="input" autocomplete="off" spellcheck="false"
               placeholder="chemical equation or molecule" maxlength="<?= MAX_INPUT ?>" required="required"
               value="<?= e($input) ?>">
        <input type="submit">
    </form>

    <div id="answer">
        <?php if ($error !== null): ?><p class="red"><?= e($error) ?></p><?php endif; ?>
        <?= $resultHtml ?>
        <?= $extraHtml ?>
    </div>

</section>
<?php page_end();
