<?php
declare(strict_types=1);

require_once __DIR__ . '/../../../src/apedia/page.php';

$repo = apedia_repo();
if (apedia_user() !== null) {
    redirect(APEDIA_URL);
}

$error = null;
$username = '';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    csrf_require();
    $username = is_string($_POST['username'] ?? null) ? mb_substr($_POST['username'], 0, 30) : '';
    $password = is_string($_POST['password'] ?? null) ? $_POST['password'] : '';

    if (!rate_limit('apedia_login', 10, 600)) {
        http_response_code(429);
        $error = 'Too many attempts. Please wait a few minutes and try again.';
    } else {
        $valid = preg_match('/^[A-Za-z0-9_-]{3,30}$/', $username) === 1
            && strlen($password) >= 1 && strlen($password) <= 72 && !str_contains($password, "\0");
        $row = $valid ? $repo->userAuthByName($username) : null;
        // Always run one bcrypt verification, whether or not the user exists.
        $ok = password_verify($valid ? $password : 'x', $row['password_hash'] ?? APEDIA_DUMMY_HASH);
        if ($row !== null && $ok) {
            if (password_needs_rehash($row['password_hash'], PASSWORD_DEFAULT)) {
                $repo->updatePasswordHash((int) $row['id'], password_hash($password, PASSWORD_DEFAULT));
            }
            apedia_sign_in((int) $row['id']);
            redirect(APEDIA_URL);
        }
        $error = 'Invalid username or password.';
    }
}

apedia_start('APedia', [['Login', APEDIA_URL . 'login.php']], null, '', 'auth');
?>
    <h1>Login</h1>
    <p>Please fill in your credentials to log in</p>
    <p class="err_message"><?= e($error) ?></p>
    <form id='login' method='post' action="<?= e(APEDIA_URL . 'login.php') ?>">
        <?= csrf_field() ?>
        <label for="username">Username</label>
        <input type='text' name='username' id="username" maxlength="30" autocomplete="username" required value="<?= e($username) ?>">
        <label for="password">Password</label>
        <input type='password' name='password' id="password" maxlength="72" autocomplete="current-password" required>
        <input type='submit' value="Login">
    </form>
    <p>Don't have an account? <a href="<?= e(APEDIA_URL . 'register.php') ?>">Sign up now.</a></p>
<?php apedia_end();
