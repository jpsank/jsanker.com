<?php
declare(strict_types=1);

/**
 * Audiovisual.js — p5.js + p5.sound particle visualiser for an audio file the
 * visitor picks. The file never leaves the browser (it is read through an object URL).
 * The original page was a bare full-screen document with no site chrome, so this prints it
 * directly (only the bootstrap's strict security headers are added). It deliberately has no
 * doctype: the original ran in quirks mode, and layout.php's HTML5 doctype adds a page scrollbar.
 */

require_once __DIR__ . '/../../../src/bootstrap.php';

// p5.sound fetches the chosen file from a blob: URL with XMLHttpRequest.
csp_allow('connect-src', "'self'", 'blob:');
send_security_headers();
header('Content-Type: text/html; charset=utf-8');
?>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="Visualize your music files with particle animations">
    <title>Audiovisual.js - jsanker.com</title>
    <link rel="shortcut icon" href="/assets/legacy/favicon.png" />

    <script language="javascript" type="text/javascript" src="libraries/p5.min.js"></script>
    <script language="javascript" type="text/javascript" src="libraries/p5.sound.min.js"></script>
    <script language="javascript" type="text/javascript" src="audiovisual.js"></script>
    <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
<input type="file" name="file" id="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.aac,.flac">
<button id="fullscreen">Fullscreen</button>

</body>
</html>
