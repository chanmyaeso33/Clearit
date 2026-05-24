#!/usr/bin/env node
// Usage:
//   node test_scan.js                          → test all three images against localhost:3000
//   node test_scan.js test_burmese_pali.png    → test one image
//   node test_scan.js --url https://clearit-xezb.onrender.com test_burmese_pali.png

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let baseUrl = 'http://localhost:3000';
const urlFlagIdx = args.indexOf('--url');
if (urlFlagIdx !== -1) {
  baseUrl = args[urlFlagIdx + 1];
  args.splice(urlFlagIdx, 2);
}

const defaultImages = ['test_burmese.png', 'test_burmese_pali.png', 'test_english.png'];
const images = args.length > 0 ? args : defaultImages;

async function testScan(imagePath) {
  const absPath = path.resolve(imagePath);
  if (!fs.existsSync(absPath)) {
    console.error(`  [SKIP] File not found: ${absPath}`);
    return;
  }

  const imageBase64 = fs.readFileSync(absPath).toString('base64');
  const outputLang = imagePath.includes('english') ? 'English' : 'Burmese';

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`IMAGE : ${path.basename(imagePath)}`);
  console.log(`LANG  : ${outputLang}  |  MODE: simplify`);
  console.log(`URL   : ${baseUrl}/api/scan`);
  console.log(`${'─'.repeat(60)}`);

  const start = Date.now();
  let res;
  try {
    res = await fetch(`${baseUrl}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64, outputLang, mode: 'simplify' }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    console.error(`  [NETWORK ERROR] ${err.message}`);
    return;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`STATUS: ${res.status} (${elapsed}s)`);

  let data;
  try {
    data = await res.json();
  } catch {
    console.error('  [ERROR] Response was not valid JSON');
    return;
  }

  if (!res.ok) {
    console.error(`  [API ERROR] ${data.error || JSON.stringify(data)}`);
    return;
  }

  console.log(`\nSCRIPT DETECTED : ${data.image_script || 'n/a'}`);
  console.log(`LANG REPORTED   : ${data.language || 'n/a'}`);
  console.log(`THEME           : ${data.theme?.mood || 'n/a'}`);
  console.log(`HAS BURMESE OCR : ${data.ocr_has_burmese}`);

  if (data.extracted_text) {
    const preview = data.extracted_text.substring(0, 300).replace(/\n/g, ' ↵ ');
    console.log(`\nEXTRACTED (first 300 chars):\n  ${preview}`);
  }

  if (data.cleaned_text && data.cleaned_text !== data.extracted_text) {
    const preview = data.cleaned_text.substring(0, 300).replace(/\n/g, ' ↵ ');
    console.log(`\nCLEANED (first 300 chars):\n  ${preview}`);
  }

  const output = data.simplified || data.summary || '';
  console.log(`\nOUTPUT:\n${output}`);
}

(async () => {
  console.log(`Testing against: ${baseUrl}`);
  for (const img of images) {
    await testScan(img);
  }
  console.log(`\n${'─'.repeat(60)}\nDone.\n`);
})();
