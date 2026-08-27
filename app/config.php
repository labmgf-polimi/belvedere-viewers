<?php
header('Content-Type: application/javascript');
header('Cache-Control: no-store');
// Callers build paths as `${API_BASE}/surveys/...`, so a trailing slash in the
// environment would produce a double slash. Normalise it away.
$api_base = rtrim(getenv('API_BASE') ?: 'http://localhost:8000', '/');
echo 'const API_BASE = ' . json_encode($api_base) . ';';

// MapTiler terrain key. Empty means "no terrain provider" rather than a
// hardcoded fallback — see viewer.js.
$maptiler_key = getenv('MAPTILER_KEY') ?: '';
echo 'const MAPTILER_KEY = ' . json_encode($maptiler_key) . ';';

// Base URL for the Potree assets. The layout underneath is fixed —
// `<base>/pointclouds/<year>/` and `<base>/meshes/<year>/` (docs/background-mesh.md)
// — so viewer.js derives both from this one value. Unlike MAPTILER_KEY this
// keeps a working default: an unset variable here would leave the viewer with
// no point clouds at all, which is a hard break rather than a degraded render.
$potree_assets_base = rtrim(
    getenv('POTREE_ASSETS_BASE')
        ?: 'https://belvedere-website.nbg1.your-objectstorage.com/potree',
    '/'
);
echo 'const POTREE_ASSETS_BASE = ' . json_encode($potree_assets_base) . ';';