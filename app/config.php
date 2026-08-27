<?php
header('Content-Type: application/javascript');
header('Cache-Control: no-store');
$api_base = getenv('API_BASE') ?: 'http://localhost:8000';
echo 'const API_BASE = ' . json_encode($api_base) . ';';

// MapTiler terrain key. Empty means "no terrain provider" rather than a
// hardcoded fallback — see viewer.js.
$maptiler_key = getenv('MAPTILER_KEY') ?: '';
echo 'const MAPTILER_KEY = ' . json_encode($maptiler_key) . ';';