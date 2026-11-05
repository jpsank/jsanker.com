<?php
declare(strict_types=1);

/**
 * Firebase web-client config for the blog, served as an ES module:
 *   import config from '/blog/firebase-config.php';
 * Values come from the environment (see .env.example). These are public
 * client identifiers, not secrets; access control is in firestore.rules.
 * Emits `export default null;` when anything is missing.
 */

header('Content-Type: text/javascript; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-cache');

$map = [
    'apiKey'            => 'FIREBASE_API_KEY',
    'authDomain'        => 'FIREBASE_AUTH_DOMAIN',
    'projectId'         => 'FIREBASE_PROJECT_ID',
    'storageBucket'     => 'FIREBASE_STORAGE_BUCKET',
    'messagingSenderId' => 'FIREBASE_MESSAGING_SENDER_ID',
    'appId'             => 'FIREBASE_APP_ID',
];

$config = [];
foreach ($map as $key => $env) {
    $value = getenv($env);
    if (!is_string($value) || $value === '') {
        // storageBucket and messagingSenderId are optional for Auth + Firestore.
        if (in_array($key, ['storageBucket', 'messagingSenderId'], true)) {
            continue;
        }
        echo "export default null;\n";
        exit;
    }
    $config[$key] = $value;
}

echo 'export default ', json_encode($config, JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_THROW_ON_ERROR), ";\n";
