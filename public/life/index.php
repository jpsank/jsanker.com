<?php
declare(strict_types=1);

// The Game of Life lives on the home page now; keep old links working.
require_once __DIR__ . '/../../src/bootstrap.php';
redirect('/');
