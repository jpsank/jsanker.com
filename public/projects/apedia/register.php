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
    // Passwords are never trimmed or echoed back.
    $username = is_string($_POST['username'] ?? null) ? trim($_POST['username']) : '';
    $password = is_string($_POST['password'] ?? null) ? $_POST['password'] : '';
    $confirm = is_string($_POST['password_confirm'] ?? null) ? $_POST['password_confirm'] : '';

    if (!preg_match('/^[A-Za-z0-9_-]{3,30}$/', $username)) {
        $error = 'Usernames are 3 to 30 characters: letters, digits, underscore and hyphen.';
        $username = mb_substr($username, 0, 30);
    } elseif (Censor::contains($username)) {
        $error = 'Please choose a different username.';
    } elseif (strlen($password) < 8 || strlen($password) > 72) {
        $error = 'Passwords must be 8 to 72 bytes long.';
    } elseif (str_contains($password, "\0")) {
        $error = 'That password contains an invalid character.';
    } elseif (!hash_equals($password, $confirm)) {
        $error = 'Passwords do not match.';
    } elseif (!rate_limit('apedia_register', 5, 3600)) {
        http_response_code(429);
        $error = 'Too many sign-ups from your network. Please try again later.';
    } else {
        $id = $repo->createUser($username, password_hash($password, PASSWORD_DEFAULT));
        if ($id === null) {
            $error = 'That username is already taken.';
        } else {
            apedia_sign_in($id);
            redirect(APEDIA_URL);
        }
    }
}

apedia_start('APedia', [['Register', APEDIA_URL . 'register.php']], null, '', 'auth');
?>
    <h1>Sign up</h1>
    <p>Please fill this form to create an account</p>
    <p class="err_message"><?= e($error) ?></p>
    <form id='login' method='post' action="<?= e(APEDIA_URL . 'register.php') ?>">
        <?= csrf_field() ?>
        <label for="username">Username</label>
        <input type='text' name='username' id="username" maxlength="30" pattern="[A-Za-z0-9_\-]{3,30}" autocomplete="username" required value="<?= e($username) ?>">
        <label for="password">Password</label>
        <input type='password' name='password' id="password" minlength="8" maxlength="72" autocomplete="new-password" required>
        <label for="password_confirm">Confirm Password</label>
        <input type='password' name='password_confirm' id="password_confirm" minlength="8" maxlength="72" autocomplete="new-password" required>
        <input type='submit'>
    </form>
    <p>Already have an account? <a href="<?= e(APEDIA_URL . 'login.php') ?>">Login here.</a></p>
<?php apedia_end();
