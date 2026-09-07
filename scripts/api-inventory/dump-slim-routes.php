<?php
/**
 * Dump every route registered in Slim route files, with full group prefixes.
 *
 * Loads each route file with a stub `$app` that records `group()` nesting and
 * every `get/post/put/patch/delete/map/any/options/redirect` call, so no
 * framework bootstrap or database is needed. If a `vendor/autoload.php` is
 * found above the first route file it is loaded so class constants resolve.
 *
 * Usage:
 *   php scripts/api-inventory/dump-slim-routes.php <out.tsv> <route-file.php>...
 * Output rows: <route file basename> \t METHOD \t /full/path
 */
declare(strict_types=1);

error_reporting(E_ALL & ~E_DEPRECATED & ~E_WARNING);

if ($argc < 3) {
    fwrite(STDERR, "usage: php dump-slim-routes.php <out.tsv> <route-file.php>...\n");
    exit(2);
}
$out = $argv[1];
$files = array_slice($argv, 2);

// Best-effort autoload so `Foo::class` and enum references in route files resolve.
$dir = dirname(realpath($files[0]) ?: $files[0]);
while ($dir !== dirname($dir)) {
    if (is_file($dir . '/vendor/autoload.php')) {
        require $dir . '/vendor/autoload.php';
        break;
    }
    $dir = dirname($dir);
}

final class RouteStub
{
    public function __call(string $name, array $args): self
    {
        return $this;
    }
}

final class RecorderApp
{
    /** @var string[] */
    private array $stack = [];
    /** @var array<int, array{0: string, 1: string}> */
    public array $routes = [];

    public function group(string $pattern, callable $cb): RouteStub
    {
        $this->stack[] = $pattern;
        try {
            $cb($this);
        } finally {
            array_pop($this->stack);
        }
        return new RouteStub();
    }

    /** @param string|string[] $methods */
    private function record($methods, string $pattern): RouteStub
    {
        $full = implode('', $this->stack) . $pattern;
        foreach ((array) $methods as $m) {
            $this->routes[] = [strtoupper((string) $m), $full];
        }
        return new RouteStub();
    }

    public function get(string $p, $h = null): RouteStub { return $this->record('get', $p); }
    public function post(string $p, $h = null): RouteStub { return $this->record('post', $p); }
    public function put(string $p, $h = null): RouteStub { return $this->record('put', $p); }
    public function patch(string $p, $h = null): RouteStub { return $this->record('patch', $p); }
    public function delete(string $p, $h = null): RouteStub { return $this->record('delete', $p); }
    public function options(string $p, $h = null): RouteStub { return $this->record('options', $p); }
    public function any(string $p, $h = null): RouteStub { return $this->record('any', $p); }
    public function map(array $methods, string $p, $h = null): RouteStub { return $this->record($methods, $p); }
    public function redirect(string $from, $to, int $status = 302): RouteStub { return $this->record('redirect', $from); }

    public function __call(string $name, array $args): RouteStub
    {
        return new RouteStub();
    }
}

$lines = [];
foreach ($files as $file) {
    $app = new RecorderApp();
    try {
        (static function () use ($app, $file): void {
            require $file;
        })();
    } catch (\Throwable $e) {
        fwrite(STDERR, sprintf("FAIL %s: %s: %s\n", $file, get_class($e), $e->getMessage()));
    }
    fwrite(STDERR, sprintf("%s: %d routes\n", basename($file), count($app->routes)));
    foreach ($app->routes as [$method, $pattern]) {
        $lines[] = basename($file) . "\t" . $method . "\t" . $pattern;
    }
}

if (!is_dir(dirname($out))) {
    mkdir(dirname($out), 0777, true);
}
file_put_contents($out, implode("\n", $lines) . "\n");
fwrite(STDERR, sprintf("written %s (%d rows)\n", $out, count($lines)));
