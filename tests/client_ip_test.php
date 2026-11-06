<?php
declare(strict_types=1);

/** Tests for client_ip() in src/bootstrap.php.   php tests/client_ip_test.php */

require_once __DIR__ . '/../src/bootstrap.php';

$fail = 0;
function expect_ip(array $server, string $want, string $label): void
{
    global $fail;
    $_SERVER = $server;
    $got = client_ip();
    if ($got !== $want) {
        $fail++;
        echo "FAIL: $label (got $got, wanted $want)\n";
    }
}

// came through the tunnel (private peer): trust CF-Connecting-IP
expect_ip(['REMOTE_ADDR' => '172.18.0.3', 'HTTP_CF_CONNECTING_IP' => '203.0.113.7'], '203.0.113.7', 'tunnel peer, v4');
expect_ip(['REMOTE_ADDR' => '172.18.0.3', 'HTTP_CF_CONNECTING_IP' => '2001:db8::1'], '2001:db8::1', 'tunnel peer, v6');
expect_ip(['REMOTE_ADDR' => '127.0.0.1', 'HTTP_CF_CONNECTING_IP' => '203.0.113.7'], '203.0.113.7', 'loopback peer');
// a public peer cannot spoof it
expect_ip(['REMOTE_ADDR' => '198.51.100.9', 'HTTP_CF_CONNECTING_IP' => '203.0.113.7'], '198.51.100.9', 'public peer ignored');
// garbage / missing header falls back to the peer
expect_ip(['REMOTE_ADDR' => '172.18.0.3', 'HTTP_CF_CONNECTING_IP' => 'not-an-ip'], '172.18.0.3', 'invalid header');
expect_ip(['REMOTE_ADDR' => '172.18.0.3'], '172.18.0.3', 'no header');
expect_ip([], '0.0.0.0', 'no peer');

// rate-limit identity: IPv4 as is, IPv6 by /64, v4-mapped v6 as the IPv4 address
$bucketCases = [
    ['203.0.113.7', '203.0.113.7'],
    ['2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['2001:db8:1:3::1', '2001:db8:1:3::/64'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['not-an-ip', 'not-an-ip'],
];
foreach ($bucketCases as [$in, $want]) {
    $got = ip_bucket($in);
    if ($got !== $want) {
        $fail++;
        echo "FAIL: ip_bucket($in) = $got, wanted $want\n";
    }
}

echo $fail === 0 ? "client_ip: all ok\n" : "client_ip: $fail failed\n";
exit($fail === 0 ? 0 : 1);
